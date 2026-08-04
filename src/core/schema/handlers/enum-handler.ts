import type {
  CompositeType,
  EnumType,
  Function,
  PostgresTypeCatalogDependent,
  Procedure,
  SqlObject,
  Table,
  View,
} from "../../../types/schema";
import { ValidationError } from "../../../types/errors";
import { Logger } from "../../../utils/logger";
import { SQLBuilder } from "../../../utils/sql-builder";
import {
  generateCreateTypeSQL,
  generateDropTypeSQL,
  quotePostgresStringLiteral,
} from "../../../utils/sql";
import type { PostgresTypeStatement } from "./postgres-type-ordering";
import {
  attributeDependentIsRetained,
  typeReferenceMatches,
} from "./composite-type-dependencies";

export interface EnumRemovalContext {
  desiredTables?: Table[];
  desiredCompositeTypes?: CompositeType[];
  desiredViews?: View[];
  desiredSqlObjects?: SqlObject[];
  desiredFunctions?: Function[];
  desiredProcedures?: Procedure[];
  managedSchemas?: string[];
}

function getEnumKey(enumType: EnumType): string {
  return `${enumType.schema || "public"}.${enumType.name}`;
}

function getDuplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }

  return Array.from(duplicates);
}

function functionUsesEnum(func: Function, enumType: EnumType): boolean {
  return (
    typeReferenceMatches(func.returnType, enumType) ||
    func.parameters.some(function parameterUsesEnum(parameter) {
      return typeReferenceMatches(parameter.type, enumType);
    })
  );
}

function procedureUsesEnum(procedure: Procedure, enumType: EnumType): boolean {
  return procedure.parameters.some(function parameterUsesEnum(parameter) {
    return typeReferenceMatches(parameter.type, enumType);
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

function catalogDependentIsRetained(
  dependent: PostgresTypeCatalogDependent,
  context: EnumRemovalContext,
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
    if ((dependent.ownerAttributes || []).some(function ownerColumnWasRemoved(
      column
    ) {
      return !table.columns.some(function retainsOwnerColumn(candidate) {
        return candidate.name === column;
      });
    })) {
      return false;
    }
    if (dependent.type === "default value") {
      const ownerAttribute = dependent.ownerAttributes?.[0];
      return table.columns.some(function retainsDefault(column) {
        return (
          column.name === ownerAttribute && column.default !== undefined
        );
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

function assertEnumCanBeRemoved(
  enumType: EnumType,
  context: EnumRemovalContext
): void {
  const managedSchemas = context.managedSchemas || ["public"];
  const retainedAttributes = (enumType.attributeDependents || []).filter(
    function isRetained(dependent) {
      return attributeDependentIsRetained(
        dependent,
        enumType,
        context.desiredCompositeTypes || [],
        context.desiredTables || [],
        context.desiredViews || [],
        managedSchemas
      );
    }
  );
  const desiredTypeKeys = new Set(
    (context.desiredSqlObjects || []).map(function getKey(object) {
      return object.key;
    })
  );
  const retainedTypes = (enumType.typeDependents || []).filter(
    function isRetained(dependent) {
      if (!managedSchemas.includes(dependent.schema)) return true;
      return desiredTypeKeys.has(
        `${dependent.kind}-type:${dependent.schema}.${dependent.name}`
      );
    }
  );
  const retainedRoutines = (enumType.routineDependents || []).filter(
    function isRetained(dependent) {
      if (!managedSchemas.includes(dependent.schema)) return true;
      if (dependent.kind === "procedure") {
        return (context.desiredProcedures || []).some(
          function findProcedure(procedure) {
            return (
              (procedure.schema || "public") === dependent.schema &&
              procedure.name === dependent.name &&
              procedureUsesEnum(procedure, enumType)
            );
          }
        );
      }
      return (context.desiredFunctions || []).some(
        function findFunction(func) {
          return (
            (func.schema || "public") === dependent.schema &&
            func.name === dependent.name &&
            functionUsesEnum(func, enumType)
          );
        }
      );
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
    ...(enumType.catalogDependents || [])
      .filter(function isRetained(dependent) {
        return catalogDependentIsRetained(dependent, context, managedSchemas);
      })
      .map(function renderCatalogDependent(dependent) {
        return `${dependent.type} ${dependent.identity}`;
      }),
  ];
  if (dependents.length === 0) return;

  const identity = `${enumType.schema || "public"}.${enumType.name}`;
  throw new ValidationError(
    `PostgreSQL enum '${identity}' cannot be dropped while these objects still use it: ${dependents.join(", ")}. Remove or migrate those dependents first`,
    "enum",
    identity,
    dependents
  );
}

export class EnumHandler {
  generateStatements(desiredEnums: EnumType[], currentEnums: EnumType[]): {
    transactional: string[];
    preTransactional: string[];
    typeStatements: PostgresTypeStatement[];
  } {
    const transactional: string[] = [];
    const preTransactional: string[] = [];
    const typeStatements: PostgresTypeStatement[] = [];
    const currentEnumMap = new Map(currentEnums.map((enumType) => [getEnumKey(enumType), enumType]));

    for (const desiredEnum of desiredEnums) {
      this.validateDesiredEnum(desiredEnum);
      const currentEnum = currentEnumMap.get(getEnumKey(desiredEnum));

      if (!currentEnum) {
        const statement = generateCreateTypeSQL(desiredEnum);
        transactional.push(statement);
        typeStatements.push({
          name: desiredEnum.name,
          schema: desiredEnum.schema,
          statement,
        });
      } else {
        const currentValues = currentEnum.values;
        const desiredValues = desiredEnum.values;

        if (JSON.stringify(currentValues) === JSON.stringify(desiredValues)) {
          Logger.info(`ENUM type '${desiredEnum.name}' already exists with matching values, skipping creation`);
        } else {
          const modificationStatements = this.generateModificationStatements(desiredEnum, currentEnum);
          preTransactional.push(...modificationStatements);
        }
      }
    }

    return { transactional, preTransactional, typeStatements };
  }

  generateRemovalStatements(
    desiredEnums: EnumType[],
    currentEnums: EnumType[],
    context: EnumRemovalContext = {}
  ): string[] {
    return this.generateRemovalTypeStatements(
      desiredEnums,
      currentEnums,
      context
    ).map(
      function getStatement(item) {
        return item.statement;
      }
    );
  }

  generateRemovalTypeStatements(
    desiredEnums: EnumType[],
    currentEnums: EnumType[],
    context: EnumRemovalContext = {}
  ): PostgresTypeStatement[] {
    const statements: PostgresTypeStatement[] = [];
    const desiredEnumNames = new Set(desiredEnums.map((enumType) => getEnumKey(enumType)));

    for (const currentEnum of currentEnums) {
      if (!desiredEnumNames.has(getEnumKey(currentEnum))) {
        assertEnumCanBeRemoved(currentEnum, context);
        statements.push({
          name: currentEnum.name,
          schema: currentEnum.schema,
          statement: generateDropTypeSQL(currentEnum.name, currentEnum.schema),
        });
        Logger.info(`Dropping ENUM type '${currentEnum.name}'`);
      }
    }

    return statements;
  }

  private generateModificationStatements(desiredEnum: EnumType, currentEnum: EnumType): string[] {
    const statements: string[] = [];
    const currentValues = new Set(currentEnum.values);
    const desiredValues = new Set(desiredEnum.values);

    const valuesToRemove = currentEnum.values.filter(function findRemoved(value) {
      return !desiredValues.has(value);
    });
    const retainedValues = desiredEnum.values.filter(function findRetained(value) {
      return currentValues.has(value);
    });
    const currentRetainedValues = currentEnum.values.filter(function findCurrentRetained(
      value
    ) {
      return desiredValues.has(value);
    });
    const hasRelativeOrderChange = retainedValues.some(function compareOrder(
      value,
      index
    ) {
      return currentRetainedValues[index] !== value;
    });

    if (valuesToRemove.length > 0 || hasRelativeOrderChange) {
      const changeDescription = [];
      if (valuesToRemove.length > 0) {
        changeDescription.push(`removing values [${valuesToRemove.join(', ')}]`);
      }
      if (hasRelativeOrderChange) {
        changeDescription.push(`reordering values`);
      }

      throw new Error(
        `ENUM type '${desiredEnum.name}' modification requires manual intervention. ` +
        `Cannot safely perform: ${changeDescription.join(' and ')}. ` +
        `Current values: [${currentEnum.values.join(', ')}], ` +
        `Desired values: [${desiredEnum.values.join(', ')}]. ` +
        `Removing ENUM values or changing their order can cause data loss and is not supported by Terra. ` +
        `Please handle this migration manually or create a new ENUM type with a different name.`
      );
    }

    for (let index = 0; index < desiredEnum.values.length; index += 1) {
      const value = desiredEnum.values[index];
      if (value === undefined) {
        continue;
      }
      if (currentValues.has(value)) {
        continue;
      }
      const nextValue = desiredEnum.values
        .slice(index + 1)
        .find(function findExisting(candidate) {
          return currentValues.has(candidate);
        });
      statements.push(this.generateAddValueStatement(desiredEnum, value, nextValue));
      currentValues.add(value);
      Logger.info(`Adding value '${value}' to ENUM type '${desiredEnum.name}'`);
    }

    return statements;
  }

  private validateDesiredEnum(enumType: EnumType): void {
    const duplicateValues = getDuplicateValues(enumType.values);
    if (duplicateValues.length > 0) {
      throw new Error(
        `ENUM type '${enumType.name}' has duplicate values in desired schema: [${duplicateValues.join(", ")}]`
      );
    }
  }

  private generateAddValueStatement(
    enumType: EnumType,
    value: string,
    before: string | undefined
  ): string {
    const builder = new SQLBuilder().p("ALTER TYPE");
    if (enumType.schema) {
      builder.ident(enumType.schema).rewriteLastChar('.');
    }
    builder.ident(enumType.name).p("ADD VALUE").p(quotePostgresStringLiteral(value));
    if (before !== undefined) {
      builder.p("BEFORE").p(quotePostgresStringLiteral(before));
    }
    return builder.rewriteLastChar(";").build();
  }
}
