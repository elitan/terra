import type {
  CompositeType,
  CompositeTypeAttributeDependent,
  CompositeTypeTypeDependent,
  Function,
  PostgresTypeCatalogDependent,
  PostgresTypeRoutineDependent,
  Procedure,
  SqlObject,
  Table,
  Trigger,
  View,
} from "../../../types/schema";
import {
  attributeDependentIsRetained,
  typeReferenceMatches,
} from "./composite-type-dependencies";

export interface PostgresTypeDependencyTarget {
  name: string;
  schema?: string;
  attributeDependents?: CompositeTypeAttributeDependent[];
  typeDependents?: CompositeTypeTypeDependent[];
  routineDependents?: PostgresTypeRoutineDependent[];
  catalogDependents?: PostgresTypeCatalogDependent[];
}

export interface PostgresTypeDependencyContext {
  desiredTables?: Table[];
  desiredCompositeTypes?: CompositeType[];
  desiredViews?: View[];
  desiredSqlObjects?: SqlObject[];
  desiredFunctions?: Function[];
  desiredProcedures?: Procedure[];
  desiredTriggers?: Trigger[];
  managedSchemas?: string[];
}

function functionUsesType(
  func: Function,
  target: PostgresTypeDependencyTarget
): boolean {
  return (
    typeReferenceMatches(func.returnType, target) ||
    func.parameters.some(function parameterUsesType(parameter) {
      return typeReferenceMatches(parameter.type, target);
    })
  );
}

function procedureUsesType(
  procedure: Procedure,
  target: PostgresTypeDependencyTarget
): boolean {
  return procedure.parameters.some(function parameterUsesType(parameter) {
    return typeReferenceMatches(parameter.type, target);
  });
}

function tableRetainsConstraint(table: Table, name: string | undefined): boolean {
  const constraints = [
    ...(table.primaryKey ? [table.primaryKey] : []),
    ...(table.foreignKeys || []),
    ...(table.checkConstraints || []),
    ...(table.uniqueConstraints || []),
    ...(table.exclusionConstraints || []),
  ];
  if (
    name &&
    constraints.some(function matchesName(constraint) {
      return constraint.name === name;
    })
  ) {
    return true;
  }
  return constraints.some(function isUnnamed(constraint) {
    return !constraint.name;
  });
}

function desiredPolicyExists(
  dependent: PostgresTypeCatalogDependent,
  context: PostgresTypeDependencyContext
): boolean {
  if (!dependent.name) return true;
  const key = `policy:${dependent.ownerSchema}.${dependent.ownerRelation}.${dependent.name}`;
  return (context.desiredSqlObjects || []).some(function matchesPolicy(object) {
    return object.key === key;
  });
}

function desiredTriggerExists(
  dependent: PostgresTypeCatalogDependent,
  context: PostgresTypeDependencyContext
): boolean {
  if (!dependent.name) return true;
  const regularTriggerExists = (context.desiredTriggers || []).some(
    function matchesTrigger(trigger) {
      return (
        (trigger.schema || "public") === dependent.ownerSchema &&
        trigger.tableName === dependent.ownerRelation &&
        trigger.name === dependent.name
      );
    }
  );
  if (regularTriggerExists) return true;
  const key = `constraint-trigger:${dependent.ownerSchema}.${dependent.ownerRelation}.${dependent.name}`;
  return (context.desiredSqlObjects || []).some(
    function matchesConstraintTrigger(object) {
      return object.key === key;
    }
  );
}

export function catalogDependentIsRetained(
  dependent: PostgresTypeCatalogDependent,
  context: PostgresTypeDependencyContext,
  managedSchemas: string[]
): boolean {
  if (!dependent.ownerSchema || !dependent.ownerRelation) return true;
  if (!managedSchemas.includes(dependent.ownerSchema)) return true;

  if (["r", "p", "f"].includes(dependent.ownerRelationKind || "")) {
    const table = (context.desiredTables || []).find(
      function findOwnerTable(candidate) {
        return (
          (candidate.schema || "public") === dependent.ownerSchema &&
          candidate.name === dependent.ownerRelation
        );
      }
    );
    if (!table) return false;
    if (
      (dependent.ownerAttributes || []).some(function ownerColumnWasRemoved(
        column
      ) {
        return !table.columns.some(function retainsOwnerColumn(candidate) {
          return candidate.name === column;
        });
      })
    ) {
      return false;
    }
    if (dependent.type === "default value") {
      const ownerAttribute = dependent.ownerAttributes?.[0];
      return table.columns.some(function retainsDefault(column) {
        return column.name === ownerAttribute && column.default !== undefined;
      });
    }
    if (dependent.type === "index") {
      return (table.indexes || []).some(function retainsIndex(index) {
        return (
          (index.schema || table.schema || "public") === dependent.schema &&
          index.name === dependent.name
        );
      });
    }
    if (dependent.type === "table constraint") {
      return tableRetainsConstraint(table, dependent.name);
    }
    if (dependent.type === "policy") {
      return desiredPolicyExists(dependent, context);
    }
    if (dependent.type === "trigger") {
      return desiredTriggerExists(dependent, context);
    }
    return true;
  }

  if (dependent.ownerRelationKind === "c") {
    return (context.desiredCompositeTypes || []).some(
      function retainsComposite(compositeType) {
        return (
          (compositeType.schema || "public") === dependent.ownerSchema &&
          compositeType.name === dependent.ownerRelation
        );
      }
    );
  }

  if (["v", "m"].includes(dependent.ownerRelationKind || "")) {
    return (context.desiredViews || []).some(function retainsView(view) {
      return (
        (view.schema || "public") === dependent.ownerSchema &&
        view.name === dependent.ownerRelation
      );
    });
  }

  return true;
}

export function getPostgresTypeDependentDescriptions(
  target: PostgresTypeDependencyTarget
): string[] {
  return [
    ...(target.attributeDependents || []).map(function renderAttribute(
      dependent
    ) {
      return `${dependent.schema}.${dependent.relation}.${dependent.attribute}`;
    }),
    ...(target.typeDependents || []).map(function renderType(dependent) {
      return `${dependent.kind} ${dependent.schema}.${dependent.name}`;
    }),
    ...(target.routineDependents || []).map(function renderRoutine(dependent) {
      return `${dependent.kind} ${dependent.schema}.${dependent.name}(${dependent.identityArguments})`;
    }),
    ...(target.catalogDependents || []).map(function renderCatalog(dependent) {
      return `${dependent.type} ${dependent.identity}`;
    }),
  ];
}

export function getRetainedPostgresTypeDependentDescriptions(
  target: PostgresTypeDependencyTarget,
  desiredTypeObjects: SqlObject[],
  context: PostgresTypeDependencyContext
): string[] {
  const managedSchemas = context.managedSchemas || ["public"];
  const retainedAttributes = (target.attributeDependents || []).filter(
    function isRetained(dependent) {
      return attributeDependentIsRetained(
        dependent,
        target,
        context.desiredCompositeTypes || [],
        context.desiredTables || [],
        context.desiredViews || [],
        managedSchemas
      );
    }
  );
  const desiredTypeKeys = new Set(
    desiredTypeObjects.map(function getKey(object) {
      return object.key;
    })
  );
  const retainedTypes = (target.typeDependents || []).filter(
    function isRetained(dependent) {
      if (!managedSchemas.includes(dependent.schema)) return true;
      return desiredTypeKeys.has(
        `${dependent.kind}-type:${dependent.schema}.${dependent.name}`
      );
    }
  );
  const retainedRoutines = (target.routineDependents || []).filter(
    function isRetained(dependent) {
      if (!managedSchemas.includes(dependent.schema)) return true;
      if (dependent.kind === "procedure") {
        return (context.desiredProcedures || []).some(
          function findProcedure(procedure) {
            return (
              (procedure.schema || "public") === dependent.schema &&
              procedure.name === dependent.name &&
              procedureUsesType(procedure, target)
            );
          }
        );
      }
      return (context.desiredFunctions || []).some(
        function findFunction(func) {
          return (
            (func.schema || "public") === dependent.schema &&
            func.name === dependent.name &&
            functionUsesType(func, target)
          );
        }
      );
    }
  );
  const retainedCatalogDependents = (target.catalogDependents || []).filter(
    function isRetained(dependent) {
      return catalogDependentIsRetained(dependent, context, managedSchemas);
    }
  );

  return getPostgresTypeDependentDescriptions({
    name: target.name,
    schema: target.schema,
    attributeDependents: retainedAttributes,
    typeDependents: retainedTypes,
    routineDependents: retainedRoutines,
    catalogDependents: retainedCatalogDependents,
  });
}
