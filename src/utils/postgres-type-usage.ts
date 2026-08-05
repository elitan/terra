import type { CompositeType, SqlObject, Table } from "../types/schema";

export interface PostgresTypeUsage {
  type: string;
  location: string;
  rangeSubtype: boolean;
}

export interface PostgresTypeUsageSchema {
  tables: Table[];
  compositeTypes: CompositeType[];
  sqlObjects: SqlObject[];
}

function getQualifiedName(name: string, schema: string | undefined): string {
  return `${schema || "public"}.${name}`;
}

export function collectPostgresTypeUsages(
  schema: PostgresTypeUsageSchema
): PostgresTypeUsage[] {
  const usages: PostgresTypeUsage[] = [];
  for (const table of schema.tables) {
    const tableName = getQualifiedName(table.name, table.schema);
    for (const column of table.columns) {
      usages.push({
        type: column.type,
        location: `column ${tableName}.${column.name}`,
        rangeSubtype: false,
      });
    }
  }
  for (const compositeType of schema.compositeTypes) {
    const typeName = getQualifiedName(compositeType.name, compositeType.schema);
    for (const attribute of compositeType.attributes) {
      usages.push({
        type: attribute.type,
        location: `composite attribute ${typeName}.${attribute.name}`,
        rangeSubtype: false,
      });
    }
  }
  for (const object of schema.sqlObjects) {
    if (object.kind === "partition" && object.partitionColumnTypes) {
      const tableName = getQualifiedName(object.name, object.schema);
      for (const [name, type] of Object.entries(object.partitionColumnTypes)) {
        usages.push({
          type,
          location: `partition column ${tableName}.${name}`,
          rangeSubtype: false,
        });
      }
    }
    const definition = object.typeDefinition;
    if (!definition) continue;
    const typeName = getQualifiedName(object.name, object.schema);
    if (definition.kind === "domain") {
      usages.push({
        type: definition.baseType,
        location: `domain ${typeName}`,
        rangeSubtype: false,
      });
    } else {
      usages.push({
        type: definition.subtype,
        location: `range subtype ${typeName}`,
        rangeSubtype: true,
      });
    }
  }
  return usages;
}
