import type { Sequence } from "../../../types/schema";
import type { MigrationContext } from "../../../types/migration";
import {
  generateCreateSequenceSQL,
  generateDropSequenceSQL,
} from "../../../utils/sql";
import { Logger } from "../../../utils/logger";
import { SQLBuilder } from "../../../utils/sql-builder";
import { ValidationError } from "../../../types/errors";

type NormalizedSequence = {
  dataType: "SMALLINT" | "INTEGER" | "BIGINT";
  increment: string;
  minValue: string;
  maxValue: string;
  start: string;
  cache: string;
  cycle: boolean;
};

function normalizeSequenceNumericValue(
  value: number | string | undefined,
  fallback: string
): string {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? fallback : trimmed;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return fallback;
}

function getSequenceTypeBounds(
  dataType: "SMALLINT" | "INTEGER" | "BIGINT"
): { min: string; max: string } {
  if (dataType === "SMALLINT") {
    return { min: "-32768", max: "32767" };
  }

  if (dataType === "INTEGER") {
    return { min: "-2147483648", max: "2147483647" };
  }

  return { min: "-9223372036854775808", max: "9223372036854775807" };
}

function normalizeSequenceDataType(sequence: Sequence): "SMALLINT" | "INTEGER" | "BIGINT" {
  return sequence.dataType ?? "BIGINT";
}

function normalizeSequenceIncrement(value: number | string | undefined): string {
  const normalized = normalizeSequenceNumericValue(value, "1");
  try {
    return BigInt(normalized) === 0n ? "1" : normalized;
  } catch {
    const numeric = Number(normalized);
    return Number.isFinite(numeric) && numeric !== 0 ? String(numeric) : "1";
  }
}

function isAscendingSequenceIncrement(increment: string): boolean {
  try {
    return BigInt(increment) > 0n;
  } catch {
    return Number(increment) > 0;
  }
}

function normalizeOwnedBy(
  ownedBy: string | undefined,
  defaultSchema?: string
): string | undefined {
  if (!ownedBy) {
    return undefined;
  }

  return getOwnedByParts(ownedBy, defaultSchema).join("\u0000");
}

function normalizeSequence(sequence: Sequence): NormalizedSequence {
  const dataType = normalizeSequenceDataType(sequence);
  const increment = normalizeSequenceIncrement(sequence.increment);
  const ascending = isAscendingSequenceIncrement(increment);
  const bounds = getSequenceTypeBounds(dataType);
  const defaultMin = ascending ? "1" : bounds.min;
  const defaultMax = ascending ? bounds.max : "-1";
  const minValue = normalizeSequenceNumericValue(sequence.minValue, defaultMin);
  const maxValue = normalizeSequenceNumericValue(sequence.maxValue, defaultMax);
  const defaultStart = ascending ? minValue : maxValue;
  const start = normalizeSequenceNumericValue(sequence.start, defaultStart);
  const cache = normalizeSequenceNumericValue(sequence.cache, "1");
  const cycle = sequence.cycle ?? false;

  return {
    dataType,
    increment,
    minValue,
    maxValue,
    start,
    cache,
    cycle,
  };
}

function sequenceParametersDiffer(
  desired: NormalizedSequence,
  current: NormalizedSequence
): boolean {
  return (
    desired.dataType !== current.dataType ||
    desired.increment !== current.increment ||
    desired.minValue !== current.minValue ||
    desired.maxValue !== current.maxValue ||
    desired.start !== current.start ||
    desired.cache !== current.cache
  );
}

function getSequenceKey(sequence: Sequence): string {
  return `${sequence.schema || "public"}.${sequence.name}`;
}

function generateOwnedByStatement(sequence: Sequence): string | null {
  if (!sequence.ownedBy) {
    return null;
  }

  const builder = new SQLBuilder();
  builder.p("ALTER SEQUENCE").table(sequence.name, sequence.schema);
  builder.p(
    `OWNED BY ${renderOwnedByTarget(sequence.ownedBy, sequence.schema)}`
  );
  return builder.build() + ";";
}

function generateOwnedByChangeStatement(sequence: Sequence): string {
  const builder = new SQLBuilder();
  builder.p("ALTER SEQUENCE").table(sequence.name, sequence.schema);
  if (!sequence.ownedBy) {
    builder.p("OWNED BY NONE");
    return builder.build() + ";";
  }

  builder.p(
    `OWNED BY ${renderOwnedByTarget(sequence.ownedBy, sequence.schema)}`
  );
  return builder.build() + ";";
}

function unquoteOwnedByPart(part: string): string {
  if (part.startsWith('"') && part.endsWith('"')) {
    return part.slice(1, -1).replace(/""/g, '"');
  }
  return part;
}

function getOwnedByParts(target: string, defaultSchema?: string): string[] {
  const parts = splitOwnedByTarget(target).map(unquoteOwnedByPart);
  if (parts.length === 2) {
    parts.unshift(defaultSchema || "public");
  }
  return parts;
}

function quoteOwnedByPart(identifier: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    return identifier;
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function renderOwnedByTarget(target: string, defaultSchema?: string): string {
  return getOwnedByParts(target, defaultSchema)
    .map(quoteOwnedByPart)
    .join(".");
}

function splitOwnedByTarget(target: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inQuote = false;

  for (let i = 0; i < target.length; i++) {
    const char = target[i];

    if (char === '"') {
      current += char;
      if (inQuote && target[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuote = !inQuote;
      continue;
    }

    if (char === "." && !inQuote) {
      if (current) {
        segments.push(current);
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current) {
    segments.push(current);
  }

  return segments;
}

function generateCreateSequenceStatements(sequence: Sequence): string[] {
  const createSequence = sequence.ownedBy
    ? { ...sequence, ownedBy: undefined }
    : sequence;
  const statements = [generateCreateSequenceSQL(createSequence)];
  const ownedByStatement = generateOwnedByStatement(sequence);
  if (ownedByStatement) {
    statements.push(ownedByStatement);
  }
  return statements;
}

function generateDefinitionChangeStatements(
  desired: Sequence,
  current: Sequence
): string[] {
  const statements: string[] = [];
  const normalizedDesired = normalizeSequence(desired);
  const normalizedCurrent = normalizeSequence(current);
  if (sequenceParametersDiffer(normalizedDesired, normalizedCurrent)) {
    statements.push(
      new SQLBuilder()
        .p("ALTER SEQUENCE")
        .table(desired.name, desired.schema)
        .p(`AS ${normalizedDesired.dataType}`)
        .p(`INCREMENT BY ${normalizedDesired.increment}`)
        .p(`MINVALUE ${normalizedDesired.minValue}`)
        .p(`MAXVALUE ${normalizedDesired.maxValue}`)
        .p(`START WITH ${normalizedDesired.start}`)
        .p(`CACHE ${normalizedDesired.cache}`)
        .p(";")
        .build()
    );
  }
  if (normalizedDesired.cycle !== normalizedCurrent.cycle) {
    statements.push(
      new SQLBuilder()
        .p("ALTER SEQUENCE")
        .table(desired.name, desired.schema)
        .p(normalizedDesired.cycle ? "CYCLE" : "NO CYCLE")
        .p(";")
        .build()
    );
  }
  return statements;
}

function generatePersistenceChangeStatement(
  desired: Sequence,
  current: Sequence
): string | null {
  if (Boolean(desired.unlogged) === Boolean(current.unlogged)) {
    return null;
  }
  return new SQLBuilder()
    .p("ALTER SEQUENCE")
    .table(desired.name, desired.schema)
    .p(desired.unlogged ? "SET UNLOGGED" : "SET LOGGED")
    .p(";")
    .build();
}

function generateAlterSequenceStatements(
  desired: Sequence,
  current: Sequence
): string[] {
  const statements = generateDefinitionChangeStatements(desired, current);

  const persistenceStatement = generatePersistenceChangeStatement(
    desired,
    current
  );
  if (persistenceStatement) {
    statements.push(persistenceStatement);
  }

  if (
    normalizeOwnedBy(desired.ownedBy, desired.schema) !==
    normalizeOwnedBy(current.ownedBy, current.schema)
  ) {
    statements.push(generateOwnedByChangeStatement(desired));
  }
  return statements;
}

function validateUnloggedSequenceSupport(
  desiredSequences: Sequence[],
  context: MigrationContext
): void {
  const unlogged = desiredSequences.find(function findUnlogged(sequence) {
    return sequence.unlogged;
  });
  if (!unlogged) return;

  const identity = `${unlogged.schema || "public"}.${unlogged.name}`;
  if (context.postgresVersionNum === undefined) {
    throw new ValidationError(
      `Cannot safely use unlogged sequence ${identity} without the PostgreSQL server version`,
      identity,
      "unlogged",
      true
    );
  }
  if (context.postgresVersionNum < 150000) {
    const serverMajor = Math.floor(context.postgresVersionNum / 10000);
    throw new ValidationError(
      `PostgreSQL ${serverMajor} does not support unlogged sequences; PostgreSQL 15 or newer is required`,
      identity,
      "unlogged",
      true
    );
  }
}

export class SequenceHandler {
  generateStatements(
    desiredSequences: Sequence[],
    currentSequences: Sequence[],
    context: MigrationContext = {}
  ): string[] {
    validateUnloggedSequenceSupport(desiredSequences, context);
    const statements: string[] = [];
    const currentMap = new Map(
      currentSequences.map(function mapCurrentSequence(sequence) {
        return [getSequenceKey(sequence), sequence] as const;
      })
    );
    const desiredKeys = new Set(desiredSequences.map(getSequenceKey));

    for (const currentSequence of currentSequences) {
      const key = getSequenceKey(currentSequence);
      if (!desiredKeys.has(key)) {
        if (currentSequence.ownedBy) {
          Logger.info(`sequence '${key}' is owned by a table column, skipping`);
          continue;
        }

        statements.push(generateDropSequenceSQL(currentSequence.name, currentSequence.schema));
        Logger.info(`Dropping sequence '${key}'`);
      }
    }

    for (const desiredSequence of desiredSequences) {
      const key = getSequenceKey(desiredSequence);
      const currentSequence = currentMap.get(key);

      if (!currentSequence) {
        statements.push(...generateCreateSequenceStatements(desiredSequence));
        Logger.info(`Creating sequence '${key}'`);
        continue;
      }

      const alterationStatements = generateAlterSequenceStatements(
        desiredSequence,
        currentSequence
      );
      if (alterationStatements.length > 0) {
        statements.push(...alterationStatements);
        Logger.info(`Updating sequence '${key}'`);
      } else {
        Logger.info(`sequence '${key}' is up to date, skipping`);
      }
    }

    return statements;
  }
}
