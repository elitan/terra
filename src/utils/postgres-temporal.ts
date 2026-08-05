import { ValidationError } from "../types/errors";
import {
  collectPostgresTypeUsages,
  type PostgresTypeUsage,
  type PostgresTypeUsageSchema,
} from "./postgres-type-usage";

interface PostgresTemporalConstraint {
  precision?: number;
  intervalFields?: string;
}

export type PostgresTemporalModifierSchema = PostgresTypeUsageSchema;

const INTERVAL_FIELDS_PATTERN = [
  "YEAR TO MONTH",
  "DAY TO SECOND",
  "DAY TO MINUTE",
  "DAY TO HOUR",
  "HOUR TO SECOND",
  "HOUR TO MINUTE",
  "MINUTE TO SECOND",
  "YEAR",
  "MONTH",
  "DAY",
  "HOUR",
  "MINUTE",
  "SECOND",
].join("|");

function removeArrayDecorators(type: string): string {
  return type.trim().replace(/(?:\[(?:\d*)\])+$/, "").trim();
}

function parsePostgresTemporalConstraint(
  type: string
): PostgresTemporalConstraint | undefined {
  const baseType = removeArrayDecorators(type);
  const timeMatch = baseType.match(
    /^(?:time|timetz|timestamp|timestamptz)(?:\s*\(\s*([+-]?\d+)\s*\))?(?:\s+(?:with|without)\s+time\s+zone)?$/i
  );
  if (timeMatch) {
    if (timeMatch[1] === undefined) return {};
    return { precision: Number(timeMatch[1]) };
  }

  const intervalMatch = baseType.match(
    new RegExp(
      `^interval(?:\\s+(${INTERVAL_FIELDS_PATTERN}))?(?:\\s*\\(\\s*([+-]?\\d+)\\s*\\))?$`,
      "i"
    )
  );
  if (!intervalMatch) return undefined;
  return {
    ...(intervalMatch[1]
      ? { intervalFields: intervalMatch[1].toUpperCase() }
      : {}),
    ...(intervalMatch[2] === undefined
      ? {}
      : { precision: Number(intervalMatch[2]) }),
  };
}

function hasPostgresTemporalConstraintSyntax(type: string): boolean {
  const baseType = removeArrayDecorators(type);
  return /^(?:time|timetz|timestamp|timestamptz|interval)\b/i.test(baseType) &&
    (baseType.includes("(") || /^interval\s+\w/i.test(baseType));
}

function validatePostgresTemporalConstraint(
  usage: PostgresTypeUsage,
  constraint: PostgresTemporalConstraint
): void {
  const isConstrained = constraint.precision !== undefined ||
    constraint.intervalFields !== undefined;
  if (usage.rangeSubtype && isConstrained) {
    throw new ValidationError(
      `${usage.location} declares temporal modifier '${usage.type}', but PostgreSQL does not retain temporal modifiers for range subtypes; use an unconstrained temporal subtype or a domain`,
      usage.location,
      "type",
      usage.type
    );
  }

  if (
    constraint.precision !== undefined &&
    constraint.intervalFields !== undefined &&
    !constraint.intervalFields.includes("SECOND")
  ) {
    throw new ValidationError(
      `${usage.location} has interval precision on fields '${constraint.intervalFields}'; PostgreSQL permits interval precision only when the fields include SECOND`,
      usage.location,
      "type",
      usage.type
    );
  }

  if (
    constraint.precision !== undefined &&
    (constraint.precision < 0 || constraint.precision > 6)
  ) {
    throw new ValidationError(
      `${usage.location} has temporal precision ${constraint.precision}; PostgreSQL requires time, timestamp, and interval precision between 0 and 6`,
      usage.location,
      "type",
      usage.type
    );
  }
}

export function validatePostgresTemporalModifiers(
  schema: PostgresTemporalModifierSchema
): void {
  for (const usage of collectPostgresTypeUsages(schema)) {
    const constraint = parsePostgresTemporalConstraint(usage.type);
    if (!constraint) {
      if (hasPostgresTemporalConstraintSyntax(usage.type)) {
        throw new ValidationError(
          `${usage.location} has invalid temporal modifier '${usage.type}'; use a single integer precision and a documented interval field range`,
          usage.location,
          "type",
          usage.type
        );
      }
      continue;
    }
    validatePostgresTemporalConstraint(usage, constraint);
  }
}
