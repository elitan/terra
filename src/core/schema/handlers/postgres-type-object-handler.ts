import type {
  CompositeType,
  DomainTypeConstraint,
  DomainTypeDefinition,
  Function,
  Procedure,
  QualifiedName,
  RangeTypeDefinition,
  SqlObject,
  Table,
  View,
} from "../../../types/schema";
import { ValidationError } from "../../../types/errors";
import { collationsAreDifferent } from "../../../utils/collation";
import { expressionsEqual } from "../../../utils/expression-comparator";
import { normalizeType } from "../../../utils/sql";
import {
  attributeDependentIsRetained,
  parseTypeReference,
} from "./composite-type-dependencies";
import { getAutomaticMultirangeName } from "./postgres-type-ordering";

export type PostgresTypeObjectContext = {
  desiredTables?: Table[];
  desiredViews?: View[];
  desiredCompositeTypes?: CompositeType[];
  desiredFunctions?: Function[];
  currentFunctions?: Function[];
  desiredProcedures?: Procedure[];
  managedSchemas?: string[];
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function renderTypeObjectName(object: SqlObject): string {
  const name = quoteIdentifier(object.name);
  return object.schema ? `${quoteIdentifier(object.schema)}.${name}` : name;
}

function qualifiedNamesAreEqual(
  desired: QualifiedName | undefined,
  current: QualifiedName | undefined,
  localSchema: string
): boolean {
  if (!desired || !current) return desired === current;
  if (desired.name !== current.name) return false;
  if (desired.schema && current.schema) {
    return desired.schema === current.schema;
  }
  const explicitSchema = desired.schema || current.schema;
  return !explicitSchema || ["pg_catalog", localSchema].includes(explicitSchema);
}

function optionalExpressionsAreEqual(
  desired: string | undefined,
  current: string | undefined
): boolean {
  if (!desired || !current) return desired === current;
  return expressionsEqual(desired, current);
}

export function domainDefinitionsRequireReplacement(
  desired: DomainTypeDefinition,
  current: DomainTypeDefinition
): boolean {
  return (
    normalizeType(desired.baseType) !== normalizeType(current.baseType) ||
    collationsAreDifferent(desired.collation, current.collation)
  );
}

function rangeOperatorClassesAreEqual(
  desired: RangeTypeDefinition,
  current: RangeTypeDefinition,
  localSchema: string
): boolean {
  if (current.subtypeOperatorClassIsDefault && !desired.subtypeOperatorClass) {
    return true;
  }
  return qualifiedNamesAreEqual(
    desired.subtypeOperatorClass,
    current.subtypeOperatorClass,
    localSchema
  );
}

function multirangeNamesAreEqual(
  desired: QualifiedName | undefined,
  current: QualifiedName | undefined,
  rangeName: string,
  localSchema: string
): boolean {
  if (!current && desired) {
    return (
      desired.name === getAutomaticMultirangeName(rangeName) &&
      (!desired.schema || desired.schema === localSchema)
    );
  }
  return qualifiedNamesAreEqual(desired, current, "public");
}

export function rangeDefinitionsAreEqual(
  desired: RangeTypeDefinition,
  current: RangeTypeDefinition,
  localSchema: string,
  rangeName: string
): boolean {
  return (
    normalizeType(desired.subtype) === normalizeType(current.subtype) &&
    rangeOperatorClassesAreEqual(desired, current, localSchema) &&
    !collationsAreDifferent(desired.collation, current.collation) &&
    qualifiedNamesAreEqual(
      desired.canonicalFunction,
      current.canonicalFunction,
      localSchema
    ) &&
    qualifiedNamesAreEqual(
      desired.subtypeDiffFunction,
      current.subtypeDiffFunction,
      localSchema
    ) &&
    multirangeNamesAreEqual(
      desired.multirangeTypeName,
      current.multirangeTypeName,
      rangeName,
      localSchema
    )
  );
}

function functionNameMatches(
  func: Function,
  reference: QualifiedName,
  localSchema: string
): boolean {
  return (
    func.name === reference.name &&
    (func.schema || "public") === (reference.schema || localSchema)
  );
}

export function assertRangePrerequisitesExist(
  object: SqlObject,
  definition: RangeTypeDefinition,
  context: PostgresTypeObjectContext
): void {
  const localSchema = object.schema || "public";
  for (const reference of [
    definition.canonicalFunction,
    definition.subtypeDiffFunction,
  ]) {
    if (!reference) continue;
    const isDesired = (context.desiredFunctions || []).some(
      function findDesired(func) {
        return functionNameMatches(func, reference, localSchema);
      }
    );
    const alreadyExists = (context.currentFunctions || []).some(
      function findCurrent(func) {
        return functionNameMatches(func, reference, localSchema);
      }
    );
    if (isDesired && !alreadyExists) {
      throw new ValidationError(
        `PostgreSQL range '${localSchema}.${object.name}' requires function '${reference.schema || localSchema}.${reference.name}' to exist before CREATE TYPE. Apply that prerequisite function first; canonical functions also require PostgreSQL's shell-type workflow`,
        object.kind,
        object.key,
        object.createStatement
      );
    }
  }
}

function renderDomainConstraint(constraint: DomainTypeConstraint): string {
  const name = constraint.name
    ? ` CONSTRAINT ${quoteIdentifier(constraint.name)}`
    : "";
  return `${name} CHECK (${constraint.expression})`;
}

export function generateDomainAlterStatements(
  desiredObject: SqlObject,
  currentDefinition: DomainTypeDefinition,
  desiredDefinition: DomainTypeDefinition,
  hasContainerColumnDependents: boolean
): string[] {
  const typeName = renderTypeObjectName(desiredObject);
  const statements: string[] = [];

  if (
    !optionalExpressionsAreEqual(
      desiredDefinition.default,
      currentDefinition.default
    )
  ) {
    statements.push(
      desiredDefinition.default
        ? `ALTER DOMAIN ${typeName} SET DEFAULT ${desiredDefinition.default};`
        : `ALTER DOMAIN ${typeName} DROP DEFAULT;`
    );
  }

  if (desiredDefinition.notNull !== currentDefinition.notNull) {
    statements.push(
      `ALTER DOMAIN ${typeName} ${desiredDefinition.notNull ? "SET" : "DROP"} NOT NULL;`
    );
  }

  const unmatchedCurrent = new Set(
    currentDefinition.constraints.map(function getIndex(_constraint, index) {
      return index;
    })
  );
  const drops: string[] = [];
  const renames: string[] = [];
  const additions: string[] = [];
  const validations: string[] = [];
  const desiredConstraintNames = new Set(
    desiredDefinition.constraints.flatMap(function getConstraintName(constraint) {
      return constraint.name ? [constraint.name] : [];
    })
  );

  for (const desiredConstraint of desiredDefinition.constraints) {
    let currentIndex = currentDefinition.constraints.findIndex(
      function findNamedConstraint(currentConstraint, index) {
        return (
          unmatchedCurrent.has(index) &&
          desiredConstraint.name !== undefined &&
          currentConstraint.name === desiredConstraint.name
        );
      }
    );
    if (currentIndex < 0) {
      currentIndex = currentDefinition.constraints.findIndex(
        function findEquivalentConstraint(currentConstraint, index) {
          return (
            unmatchedCurrent.has(index) &&
            (!currentConstraint.name ||
              !desiredConstraintNames.has(currentConstraint.name)) &&
            expressionsEqual(
              desiredConstraint.expression,
              currentConstraint.expression
            )
          );
        }
      );
    }

    const currentConstraint = currentDefinition.constraints[currentIndex];
    if (!currentConstraint) {
      additions.push(
        `ALTER DOMAIN ${typeName} ADD${renderDomainConstraint(desiredConstraint)};`
      );
      continue;
    }
    unmatchedCurrent.delete(currentIndex);

    if (
      !expressionsEqual(
        desiredConstraint.expression,
        currentConstraint.expression
      )
    ) {
      if (currentConstraint.name) {
        drops.push(
          `ALTER DOMAIN ${typeName} DROP CONSTRAINT ${quoteIdentifier(currentConstraint.name)} RESTRICT;`
        );
      }
      additions.push(
        `ALTER DOMAIN ${typeName} ADD${renderDomainConstraint(desiredConstraint)};`
      );
      continue;
    }

    let effectiveName = currentConstraint.name;
    if (
      desiredConstraint.name &&
      currentConstraint.name &&
      desiredConstraint.name !== currentConstraint.name
    ) {
      renames.push(
        `ALTER DOMAIN ${typeName} RENAME CONSTRAINT ${quoteIdentifier(currentConstraint.name)} TO ${quoteIdentifier(desiredConstraint.name)};`
      );
      effectiveName = desiredConstraint.name;
    }
    if (
      desiredConstraint.validated &&
      !currentConstraint.validated &&
      effectiveName
    ) {
      validations.push(
        `ALTER DOMAIN ${typeName} VALIDATE CONSTRAINT ${quoteIdentifier(effectiveName)};`
      );
    }
  }

  for (const currentIndex of unmatchedCurrent) {
    const currentConstraint = currentDefinition.constraints[currentIndex];
    if (currentConstraint?.name) {
      drops.push(
        `ALTER DOMAIN ${typeName} DROP CONSTRAINT ${quoteIdentifier(currentConstraint.name)} RESTRICT;`
      );
    }
  }

  const result = [
    ...statements,
    ...drops,
    ...renames,
    ...additions,
    ...validations,
  ];
  const requiresNestedValueValidation = result.some(
    function requiresValidation(statement) {
      return (
        statement.includes(" SET NOT NULL;") ||
        statement.includes(" ADD CONSTRAINT ") ||
        statement.includes(" VALIDATE CONSTRAINT ")
      );
    }
  );
  if (hasContainerColumnDependents && requiresNestedValueValidation) {
    throw new ValidationError(
      `PostgreSQL domain '${desiredObject.schema || "public"}.${desiredObject.name}' cannot add or validate constraints or set NOT NULL while it or a derived domain is stored inside an array, composite, or range column; migrate those container columns first`,
      desiredObject.kind,
      desiredObject.key,
      desiredObject.createStatement
    );
  }
  return result;
}

function getTypeDependentDescriptions(object: SqlObject): string[] {
  return [
    ...(object.attributeDependents || []).map(function renderAttribute(dependent) {
      return `${dependent.schema}.${dependent.relation}.${dependent.attribute}`;
    }),
    ...(object.typeDependents || []).map(function renderType(dependent) {
      return `${dependent.kind} ${dependent.schema}.${dependent.name}`;
    }),
    ...(object.routineDependents || []).map(function renderRoutine(dependent) {
      return `${dependent.kind} ${dependent.schema}.${dependent.name}(${dependent.identityArguments})`;
    }),
  ];
}

function typeReferenceMatchesObject(type: string, object: SqlObject): boolean {
  const reference = parseTypeReference(type.replace(/^SETOF\s+/i, ""));
  if (!reference) return false;
  if (reference.length === 1) return reference[0] === object.name;
  return (
    reference.length === 2 &&
    reference[0] === (object.schema || "public") &&
    reference[1] === object.name
  );
}

function functionUsesType(func: Function, object: SqlObject): boolean {
  return (
    typeReferenceMatchesObject(func.returnType, object) ||
    func.parameters.some(function parameterUsesType(parameter) {
      return typeReferenceMatchesObject(parameter.type, object);
    })
  );
}

function procedureUsesType(procedure: Procedure, object: SqlObject): boolean {
  return procedure.parameters.some(function parameterUsesType(parameter) {
    return typeReferenceMatchesObject(parameter.type, object);
  });
}

export function assertTypeCanBeReplaced(object: SqlObject): void {
  const dependents = getTypeDependentDescriptions(object);
  if (dependents.length === 0) return;
  throw new ValidationError(
    `PostgreSQL ${object.kind === "domain-type" ? "domain" : "range"} '${object.schema || "public"}.${object.name}' cannot be replaced while these objects depend on it: ${dependents.join(", ")}`,
    object.kind,
    object.key,
    object.createStatement
  );
}

export function assertTypeCanBeRemoved(
  object: SqlObject,
  desiredObjects: SqlObject[],
  context: PostgresTypeObjectContext
): void {
  const managedSchemas = context.managedSchemas || ["public"];
  const removedType = {
    name: object.name,
    schema: object.schema,
    attributes: [],
  };
  const retainedAttributes = (object.attributeDependents || []).filter(
    function isRetained(dependent) {
      return attributeDependentIsRetained(
        dependent,
        removedType,
        context.desiredCompositeTypes || [],
        context.desiredTables || [],
        context.desiredViews || [],
        managedSchemas
      );
    }
  );
  const desiredKeys = new Set(
    desiredObjects.map(function getKey(candidate) {
      return candidate.key;
    })
  );
  const retainedTypes = (object.typeDependents || []).filter(
    function isRetained(dependent) {
      if (!managedSchemas.includes(dependent.schema)) return true;
      return desiredKeys.has(
        `${dependent.kind}-type:${dependent.schema}.${dependent.name}`
      );
    }
  );
  const retainedRoutines = (object.routineDependents || []).filter(
    function isRetained(dependent) {
      if (!managedSchemas.includes(dependent.schema)) return true;
      if (dependent.kind === "procedure") {
        return (context.desiredProcedures || []).some(
          function findProcedure(procedure) {
            return (
              (procedure.schema || "public") === dependent.schema &&
              procedure.name === dependent.name &&
              procedureUsesType(procedure, object)
            );
          }
        );
      }
      return (context.desiredFunctions || []).some(function findFunction(func) {
        return (
          (func.schema || "public") === dependent.schema &&
          func.name === dependent.name &&
          functionUsesType(func, object)
        );
      });
    }
  );
  const dependents = [
    ...retainedAttributes.map(function renderAttribute(dependent) {
      return `${dependent.schema}.${dependent.relation}.${dependent.attribute}`;
    }),
    ...retainedTypes.map(function renderType(dependent) {
      return `${dependent.kind} ${dependent.schema}.${dependent.name}`;
    }),
    ...retainedRoutines.map(function renderRoutine(dependent) {
      return `${dependent.kind} ${dependent.schema}.${dependent.name}(${dependent.identityArguments})`;
    }),
  ];
  if (dependents.length === 0) return;

  throw new ValidationError(
    `PostgreSQL ${object.kind === "domain-type" ? "domain" : "range"} '${object.schema || "public"}.${object.name}' cannot be dropped while managed objects still use it: ${dependents.join(", ")}`,
    object.kind,
    object.key,
    object.createStatement
  );
}

export function addInferredTypeDependencies(objects: SqlObject[]): SqlObject[] {
  const typeObjects = objects.filter(function isTypeObject(object) {
    return object.typeDefinition !== undefined;
  });

  return objects.map(function addDependencies(object) {
    const definition = object.typeDefinition;
    if (!definition) return object;
    const referencedType =
      definition.kind === "domain" ? definition.baseType : definition.subtype;
    const reference = parseTypeReference(referencedType);
    if (!reference) return object;

    const matches = typeObjects.filter(function matchesReference(candidate) {
      if (candidate.key === object.key) return false;
      const candidateReferences = [
        {
          schema: candidate.schema || "public",
          name: candidate.name,
        },
      ];
      if (candidate.typeDefinition?.kind === "range") {
        const multirange = candidate.typeDefinition.multirangeTypeName;
        candidateReferences.push(
          multirange
            ? {
                schema: multirange.schema || "public",
                name: multirange.name,
              }
            : {
                schema: candidate.schema || "public",
                name: getAutomaticMultirangeName(candidate.name),
              }
        );
      }
      if (reference.length === 2) {
        return candidateReferences.some(
          function matchesQualified(candidateReference) {
            return (
              reference[0] === candidateReference.schema &&
              reference[1] === candidateReference.name
            );
          }
        );
      }
      return (
        reference.length === 1 &&
        candidateReferences.some(
          function matchesUnqualified(candidateReference) {
            return reference[0] === candidateReference.name;
          }
        )
      );
    });
    if (matches.length > 1) {
      throw new ValidationError(
        `PostgreSQL type '${object.key}' has an ambiguous unqualified dependency '${referencedType}'; schema-qualify it`,
        object.kind,
        object.key,
        object.createStatement
      );
    }
    const dependencies = new Set(object.dependencies || []);
    if (matches[0]) dependencies.add(matches[0].key);
    return dependencies.size > 0
      ? { ...object, dependencies: [...dependencies] }
      : object;
  });
}
