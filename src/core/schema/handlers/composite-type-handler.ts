import type {
  CompositeType,
  CompositeTypeAttribute,
  Function,
  Procedure,
  SqlObject,
  Table,
  Trigger,
  View,
} from "../../../types/schema";
import { ValidationError } from "../../../types/errors";
import {
  collationsAreDifferent,
  getAlterColumnCollation,
  renderCollationName,
} from "../../../utils/collation";
import {
  generateCreateCompositeTypeSQL,
  generateDropTypeSQL,
  postgresTypesAreEquivalent,
} from "../../../utils/sql";
import {
  getCompositeTypeKey,
  sortCompositeTypesForCreation,
} from "./composite-type-dependencies";
import type { PostgresTypeStatement } from "./postgres-type-ordering";
import { getRetainedPostgresTypeDependentDescriptions } from "./postgres-type-dependency-safety";

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function renderCompositeTypeName(compositeType: CompositeType): string {
  const name = quoteIdentifier(compositeType.name);
  if (!compositeType.schema) return name;
  return `${quoteIdentifier(compositeType.schema)}.${name}`;
}

function attributesAreEqual(
  desiredAttributes: CompositeType["attributes"],
  currentAttributes: CompositeType["attributes"]
): boolean {
  if (desiredAttributes.length !== currentAttributes.length) {
    return false;
  }

  return desiredAttributes.every(function attributeMatches(desired, index) {
    const current = currentAttributes[index];
    return Boolean(
      current &&
        desired.name === current.name &&
        postgresTypesAreEquivalent(
          desired.type,
          current.type,
          current.typeSchema
        ) &&
        !collationsAreDifferent(desired.collation, current.collation)
    );
  });
}

function inferAttributeRenames(
  desiredAttributes: CompositeTypeAttribute[],
  currentAttributes: CompositeTypeAttribute[]
): Map<string, string> {
  const renames = new Map<string, string>();
  const desiredNames = new Set(desiredAttributes.map(function getName(attribute) {
    return attribute.name;
  }));
  const currentNames = new Set(currentAttributes.map(function getName(attribute) {
    return attribute.name;
  }));

  const desiredAnchors = desiredAttributes
    .filter(function isExisting(attribute) {
      return currentNames.has(attribute.name);
    })
    .map(function getName(attribute) {
      return attribute.name;
    });
  const currentAnchors = currentAttributes
    .filter(function isRetained(attribute) {
      return desiredNames.has(attribute.name);
    })
    .map(function getName(attribute) {
      return attribute.name;
    });
  if (!stringArraysAreEqual(desiredAnchors, currentAnchors)) {
    return renames;
  }

  let desiredStart = 0;
  let currentStart = 0;
  for (const anchor of [...desiredAnchors, undefined]) {
    const desiredEnd = anchor
      ? desiredAttributes.findIndex(function findAnchor(attribute) {
          return attribute.name === anchor;
        })
      : desiredAttributes.length;
    const currentEnd = anchor
      ? currentAttributes.findIndex(function findAnchor(attribute) {
          return attribute.name === anchor;
        })
      : currentAttributes.length;
    const desiredSegment = desiredAttributes.slice(desiredStart, desiredEnd);
    const currentSegment = currentAttributes.slice(currentStart, currentEnd);
    if (
      desiredSegment.length > 0 &&
      desiredSegment.length === currentSegment.length
    ) {
      for (let index = 0; index < desiredSegment.length; index += 1) {
        const desired = desiredSegment[index];
        const current = currentSegment[index];
        if (desired && current) {
          renames.set(current.name, desired.name);
        }
      }
    }
    desiredStart = desiredEnd + (anchor ? 1 : 0);
    currentStart = currentEnd + (anchor ? 1 : 0);
  }

  return renames;
}

function stringArraysAreEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every(function valueMatches(value, index) {
      return right[index] === value;
    })
  );
}

export class CompositeTypeHandler {
  generateStatements(
    desiredCompositeTypes: CompositeType[],
    currentCompositeTypes: CompositeType[]
  ): {
    transactional: string[];
    concurrent: string[];
    typeStatements: PostgresTypeStatement[];
  } {
    const transactional: string[] = [];
    const typeStatements: PostgresTypeStatement[] = [];
    const currentCompositeTypeMap = new Map(
      currentCompositeTypes.map(function mapCurrent(compositeType) {
        return [getCompositeTypeKey(compositeType), compositeType];
      })
    );

    const orderedDesiredTypes = sortCompositeTypesForCreation(
      desiredCompositeTypes
    );
    for (const desiredCompositeType of orderedDesiredTypes) {
      const currentCompositeType = currentCompositeTypeMap.get(
        getCompositeTypeKey(desiredCompositeType)
      );

      if (!currentCompositeType) {
        const statement = generateCreateCompositeTypeSQL(desiredCompositeType);
        transactional.push(statement);
        typeStatements.push({
          name: desiredCompositeType.name,
          schema: desiredCompositeType.schema,
          statement,
        });
        continue;
      }

      if (
        !attributesAreEqual(
          desiredCompositeType.attributes,
          currentCompositeType.attributes
        )
      ) {
        const statements = this.generateModificationStatements(
          desiredCompositeType,
          currentCompositeType
        );
        transactional.push(...statements);
        typeStatements.push(
          ...statements.map(function mapStatement(statement) {
            return {
              name: desiredCompositeType.name,
              schema: desiredCompositeType.schema,
              statement,
            };
          })
        );
      }
    }

    return { transactional, concurrent: [], typeStatements };
  }

  generateRemovalStatements(
    desiredCompositeTypes: CompositeType[],
    currentCompositeTypes: CompositeType[],
    desiredTables: Table[] = [],
    managedSchemas: string[] = ["public"],
    desiredSqlObjects: SqlObject[] = [],
    desiredViews: View[] = [],
    desiredFunctions: Function[] = [],
    desiredProcedures: Procedure[] = [],
    desiredTriggers: Trigger[] = []
  ): string[] {
    return this.generateRemovalTypeStatements(
      desiredCompositeTypes,
      currentCompositeTypes,
      desiredTables,
      managedSchemas,
      desiredSqlObjects,
      desiredViews,
      desiredFunctions,
      desiredProcedures,
      desiredTriggers
    ).map(function getStatement(item) {
      return item.statement;
    });
  }

  generateRemovalTypeStatements(
    desiredCompositeTypes: CompositeType[],
    currentCompositeTypes: CompositeType[],
    desiredTables: Table[] = [],
    managedSchemas: string[] = ["public"],
    desiredSqlObjects: SqlObject[] = [],
    desiredViews: View[] = [],
    desiredFunctions: Function[] = [],
    desiredProcedures: Procedure[] = [],
    desiredTriggers: Trigger[] = []
  ): PostgresTypeStatement[] {
    const desiredCompositeTypeNames = new Set(
      desiredCompositeTypes.map(function getDesiredKey(compositeType) {
        return getCompositeTypeKey(compositeType);
      })
    );

    const removedTypes = currentCompositeTypes
      .filter(function isRemoved(compositeType) {
        return !desiredCompositeTypeNames.has(getCompositeTypeKey(compositeType));
      });
    for (const removedType of removedTypes) {
      const dependents = getRetainedPostgresTypeDependentDescriptions(
        removedType,
        desiredSqlObjects,
        {
          desiredTables,
          desiredCompositeTypes,
          desiredViews,
          desiredSqlObjects,
          desiredFunctions,
          desiredProcedures,
          desiredTriggers,
          managedSchemas,
        }
      );
      if (dependents.length === 0) continue;

      const identity = `${removedType.schema || "public"}.${removedType.name}`;
      throw new ValidationError(
        `PostgreSQL composite type '${identity}' cannot be dropped while these objects still use it: ${dependents.join(", ")}. Remove or migrate those dependents first`,
        "composite-type",
        identity,
        dependents
      );
    }

    return sortCompositeTypesForCreation(removedTypes)
      .reverse()
      .map(function generateDrop(compositeType) {
        return {
          name: compositeType.name,
          schema: compositeType.schema,
          statement: generateDropTypeSQL(
            compositeType.name,
            compositeType.schema
          ),
        };
      });
  }

  private generateModificationStatements(
    desiredType: CompositeType,
    currentType: CompositeType
  ): string[] {
    const typeName = renderCompositeTypeName(desiredType);
    const renames = inferAttributeRenames(
      desiredType.attributes,
      currentType.attributes
    );
    const effectiveCurrent = currentType.attributes.map(function applyRename(
      attribute
    ) {
      return {
        ...attribute,
        name: renames.get(attribute.name) || attribute.name,
      };
    });
    const desiredNames = new Set(desiredType.attributes.map(function getName(attribute) {
      return attribute.name;
    }));
    const currentNames = new Set(effectiveCurrent.map(function getName(attribute) {
      return attribute.name;
    }));
    const currentRetainedNames = effectiveCurrent
      .filter(function isRetained(attribute) {
        return desiredNames.has(attribute.name);
      })
      .map(function getName(attribute) {
        return attribute.name;
      });
    const desiredRetainedNames = desiredType.attributes
      .filter(function isRetained(attribute) {
        return currentNames.has(attribute.name);
      })
      .map(function getName(attribute) {
        return attribute.name;
      });

    if (!stringArraysAreEqual(currentRetainedNames, desiredRetainedNames)) {
      throw new Error(
        `Composite type '${desiredType.name}' cannot reorder existing attributes; create a new type and migrate dependents explicitly`
      );
    }

    const lastRetainedIndex = desiredType.attributes.reduce(function findLastRetained(
      lastIndex,
      attribute,
      index
    ) {
      return currentNames.has(attribute.name) ? index : lastIndex;
    }, -1);
    const hasInsertedAttribute = desiredType.attributes.some(function isInserted(
      attribute,
      index
    ) {
      return !currentNames.has(attribute.name) && index < lastRetainedIndex;
    });
    if (hasInsertedAttribute) {
      throw new Error(
        `Composite type '${desiredType.name}' can only append new attributes after existing attributes because PostgreSQL cannot insert a composite attribute at a specific position`
      );
    }

    const statements: string[] = [];
    for (const [currentName, desiredName] of renames) {
      statements.push(
        `ALTER TYPE ${typeName} RENAME ATTRIBUTE ${quoteIdentifier(currentName)} TO ${quoteIdentifier(desiredName)} RESTRICT;`
      );
    }

    for (const currentAttribute of effectiveCurrent) {
      if (!desiredNames.has(currentAttribute.name)) {
        statements.push(
          `ALTER TYPE ${typeName} DROP ATTRIBUTE ${quoteIdentifier(currentAttribute.name)} RESTRICT;`
        );
      }
    }

    const currentByName = new Map(
      effectiveCurrent.map(function mapCurrent(attribute) {
        return [attribute.name, attribute];
      })
    );
    for (const desiredAttribute of desiredType.attributes) {
      const currentAttribute = currentByName.get(desiredAttribute.name);
      if (!currentAttribute) {
        const collation = desiredAttribute.collation
          ? ` COLLATE ${renderCollationName(desiredAttribute.collation)}`
          : "";
        statements.push(
          `ALTER TYPE ${typeName} ADD ATTRIBUTE ${quoteIdentifier(desiredAttribute.name)} ${desiredAttribute.type}${collation} RESTRICT;`
        );
        continue;
      }

      const typeIsChanging = !postgresTypesAreEquivalent(
        desiredAttribute.type,
        currentAttribute.type,
        currentAttribute.typeSchema
      );
      const collationIsChanging = collationsAreDifferent(
        desiredAttribute.collation,
        currentAttribute.collation
      );
      if (!typeIsChanging && !collationIsChanging) {
        continue;
      }
      const attributeDependents = currentType.attributeDependents ?? [];
      if (attributeDependents.length > 0) {
        const dependents = attributeDependents
          .map(function renderDependent(dependent) {
            return `${dependent.schema}.${dependent.relation}.${dependent.attribute}`;
          })
          .join(", ");
        throw new Error(
          `Composite type '${desiredType.name}' cannot change the type or collation of attribute '${desiredAttribute.name}' because PostgreSQL blocks the change while these columns use the type: ${dependents}. Migrate or remove the dependent columns first`
        );
      }
      const alterCollation = getAlterColumnCollation(
        desiredAttribute.collation,
        currentAttribute.collation,
        typeIsChanging
      );
      const collation = alterCollation
        ? ` COLLATE ${renderCollationName(alterCollation)}`
        : "";
      statements.push(
        `ALTER TYPE ${typeName} ALTER ATTRIBUTE ${quoteIdentifier(desiredAttribute.name)} TYPE ${desiredAttribute.type}${collation} RESTRICT;`
      );
    }

    return statements;
  }
}
