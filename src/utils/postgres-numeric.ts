import type { CompositeType, SqlObject, Table } from "../types/schema";
import { ValidationError } from "../types/errors";

interface PostgresNumericTypeUsage {
  type: string;
  location: string;
  rangeSubtype: boolean;
}

interface PostgresNumericModifier {
  precision: number;
  scale: number;
}

export interface PostgresNumericModifierSchema {
  tables: Table[];
  compositeTypes: CompositeType[];
  sqlObjects: SqlObject[];
}

function getQualifiedName(name: string, schema: string | undefined): string {
  return `${schema || "public"}.${name}`;
}

function parsePostgresNumericModifier(
  type: string
): PostgresNumericModifier | undefined {
  const match = type.trim().match(
    /^(?:numeric|decimal)\(\s*([+-]?\d+)\s*(?:,\s*([+-]?\d+)\s*)?\)(?:\[(?:\d*)\])*$/i
  );
  if (!match?.[1]) return undefined;
  return {
    precision: Number(match[1]),
    scale: match[2] === undefined ? 0 : Number(match[2]),
  };
}

function hasPostgresNumericModifierSyntax(type: string): boolean {
  return /^(?:numeric|decimal)\s*\(/i.test(type.trim());
}

function collectPostgresNumericTypeUsages(
  schema: PostgresNumericModifierSchema
): PostgresNumericTypeUsage[] {
  const usages: PostgresNumericTypeUsage[] = [];
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

function validatePostgresNumericModifier(
  usage: PostgresNumericTypeUsage,
  modifier: PostgresNumericModifier,
  postgresVersionNum: number | undefined
): void {
  if (usage.rangeSubtype) {
    throw new ValidationError(
      `${usage.location} declares numeric modifier '${usage.type}', but PostgreSQL does not retain numeric modifiers for range subtypes; use an unconstrained numeric subtype or a domain`,
      usage.location,
      "type",
      usage.type
    );
  }
  if (modifier.precision < 1 || modifier.precision > 1000) {
    throw new ValidationError(
      `${usage.location} has numeric precision ${modifier.precision}; PostgreSQL requires precision between 1 and 1000`,
      usage.location,
      "type",
      usage.type
    );
  }
  if (modifier.scale < -1000 || modifier.scale > 1000) {
    throw new ValidationError(
      `${usage.location} has numeric scale ${modifier.scale}; PostgreSQL requires scale between -1000 and 1000`,
      usage.location,
      "type",
      usage.type
    );
  }

  const usesExtendedScale =
    modifier.scale < 0 || modifier.scale > modifier.precision;
  if (!usesExtendedScale) return;

  if (postgresVersionNum === undefined) {
    throw new ValidationError(
      `Cannot safely use numeric scale ${modifier.scale} on ${usage.location} without the PostgreSQL server version`,
      usage.location,
      "type",
      usage.type
    );
  }
  if (postgresVersionNum < 150000) {
    const serverMajor = Math.floor(postgresVersionNum / 10000);
    throw new ValidationError(
      `PostgreSQL ${serverMajor} requires numeric scale on ${usage.location} to be between 0 and precision ${modifier.precision}; negative scales and scales above precision require PostgreSQL 15 or newer`,
      usage.location,
      "type",
      usage.type
    );
  }
}

export function validatePostgresNumericModifiers(
  schema: PostgresNumericModifierSchema,
  postgresVersionNum: number | undefined
): void {
  for (const usage of collectPostgresNumericTypeUsages(schema)) {
    const modifier = parsePostgresNumericModifier(usage.type);
    if (!modifier) {
      if (hasPostgresNumericModifierSyntax(usage.type)) {
        throw new ValidationError(
          `${usage.location} has invalid numeric modifier '${usage.type}'; use one or two integer constants for precision and scale`,
          usage.location,
          "type",
          usage.type
        );
      }
      continue;
    }
    validatePostgresNumericModifier(usage, modifier, postgresVersionNum);
  }
}
