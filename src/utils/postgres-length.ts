import { ValidationError } from "../types/errors";
import {
  collectPostgresTypeUsages,
  stripPostgresArrayDecorators,
  type PostgresTypeUsage,
  type PostgresTypeUsageSchema,
} from "./postgres-type-usage";

interface PostgresLengthConstraint {
  typeName: string;
  length?: number;
  maximum: number;
}

export type PostgresLengthModifierSchema = PostgresTypeUsageSchema;

const MAX_CHARACTER_LENGTH = 10_485_760;
const MAX_BIT_LENGTH = 83_886_080;

function parsePostgresLengthConstraint(
  type: string
): PostgresLengthConstraint | undefined {
  const baseType = stripPostgresArrayDecorators(type);
  const characterMatch = baseType.match(
    /^(bpchar|char|character|varchar|character\s+varying)(?:\s*\(\s*([+-]?\d+)\s*\))?$/i
  );
  if (characterMatch?.[1]) {
    return {
      typeName: characterMatch[1].replace(/\s+/g, " ").toUpperCase(),
      maximum: MAX_CHARACTER_LENGTH,
      ...(characterMatch[2] === undefined
        ? {}
        : { length: Number(characterMatch[2]) }),
    };
  }

  const bitMatch = baseType.match(
    /^(bit|varbit|bit\s+varying)(?:\s*\(\s*([+-]?\d+)\s*\))?$/i
  );
  if (!bitMatch?.[1]) return undefined;
  return {
    typeName: bitMatch[1].replace(/\s+/g, " ").toUpperCase(),
    maximum: MAX_BIT_LENGTH,
    ...(bitMatch[2] === undefined
      ? {}
      : { length: Number(bitMatch[2]) }),
  };
}

function hasPostgresLengthModifierSyntax(type: string): boolean {
  const baseType = stripPostgresArrayDecorators(type);
  return /^(?:bpchar|char|character(?:\s+varying)?|varchar|bit(?:\s+varying)?|varbit)\s*\(/i
    .test(baseType);
}

function validatePostgresLengthConstraint(
  usage: PostgresTypeUsage,
  constraint: PostgresLengthConstraint
): void {
  if (usage.rangeSubtype && constraint.length !== undefined) {
    throw new ValidationError(
      `${usage.location} declares length modifier '${usage.type}', but PostgreSQL does not retain length modifiers for range subtypes; use an unconstrained subtype or a domain`,
      usage.location,
      "type",
      usage.type
    );
  }
  if (constraint.length === undefined) return;
  if (constraint.length < 1 || constraint.length > constraint.maximum) {
    throw new ValidationError(
      `${usage.location} has ${constraint.typeName} length ${constraint.length}; PostgreSQL requires length between 1 and ${constraint.maximum}`,
      usage.location,
      "type",
      usage.type
    );
  }
}

export function validatePostgresLengthModifiers(
  schema: PostgresLengthModifierSchema
): void {
  for (const usage of collectPostgresTypeUsages(schema)) {
    const constraint = parsePostgresLengthConstraint(usage.type);
    if (!constraint) {
      if (hasPostgresLengthModifierSyntax(usage.type)) {
        throw new ValidationError(
          `${usage.location} has invalid length modifier '${usage.type}'; use a single integer length`,
          usage.location,
          "type",
          usage.type
        );
      }
      continue;
    }
    validatePostgresLengthConstraint(usage, constraint);
  }
}
