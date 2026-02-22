import type { Sequence } from "../../../types/schema";
import {
  generateCreateSequenceSQL,
  generateDropSequenceSQL,
} from "../../../utils/sql";
import { Logger } from "../../../utils/logger";

type NormalizedSequence = {
  dataType: "SMALLINT" | "INTEGER" | "BIGINT";
  increment: number;
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

function normalizeSequence(sequence: Sequence): NormalizedSequence {
  const dataType = normalizeSequenceDataType(sequence);
  const incrementRaw = Number(sequence.increment ?? 1);
  const increment = Number.isFinite(incrementRaw) && incrementRaw !== 0 ? incrementRaw : 1;
  const bounds = getSequenceTypeBounds(dataType);
  const defaultMin = increment > 0 ? "1" : bounds.min;
  const defaultMax = increment > 0 ? bounds.max : "-1";
  const minValue = normalizeSequenceNumericValue(sequence.minValue, defaultMin);
  const maxValue = normalizeSequenceNumericValue(sequence.maxValue, defaultMax);
  const defaultStart = increment > 0 ? minValue : maxValue;
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

function sequencesNeedUpdate(desired: Sequence, current: Sequence): boolean {
  const normalizedDesired = normalizeSequence(desired);
  const normalizedCurrent = normalizeSequence(current);

  return (
    normalizedDesired.dataType !== normalizedCurrent.dataType ||
    normalizedDesired.increment !== normalizedCurrent.increment ||
    normalizedDesired.minValue !== normalizedCurrent.minValue ||
    normalizedDesired.maxValue !== normalizedCurrent.maxValue ||
    normalizedDesired.start !== normalizedCurrent.start ||
    normalizedDesired.cache !== normalizedCurrent.cache ||
    normalizedDesired.cycle !== normalizedCurrent.cycle
  );
}

function getSequenceKey(sequence: Sequence): string {
  return `${sequence.schema || "public"}.${sequence.name}`;
}

export class SequenceHandler {
  generateStatements(desiredSequences: Sequence[], currentSequences: Sequence[]): string[] {
    const statements: string[] = [];
    const currentMap = new Map(currentSequences.map(sequence => [getSequenceKey(sequence), sequence]));
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
        statements.push(generateCreateSequenceSQL(desiredSequence));
        Logger.info(`Creating sequence '${key}'`);
        continue;
      }

      if (currentSequence.ownedBy && !desiredSequence.ownedBy) {
        Logger.info(`sequence '${key}' is owned by a table column, skipping`);
        continue;
      }

      if (sequencesNeedUpdate(desiredSequence, currentSequence)) {
        statements.push(generateDropSequenceSQL(currentSequence.name, currentSequence.schema));
        statements.push(generateCreateSequenceSQL(desiredSequence));
        Logger.info(`Updating sequence '${key}'`);
      } else {
        Logger.info(`sequence '${key}' is up to date, skipping`);
      }
    }

    return statements;
  }
}
