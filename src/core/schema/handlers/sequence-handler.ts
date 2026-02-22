import type { Sequence } from "../../../types/schema";
import {
  generateCreateSequenceSQL,
  generateDropSequenceSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";

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

const config: HandlerConfig<Sequence> = {
  name: "sequence",
  getKey: getSequenceKey,
  generateDrop: (sequence) => generateDropSequenceSQL(sequence.name, sequence.schema),
  generateCreate: generateCreateSequenceSQL,
  shouldManage: (s) => !s.ownedBy,
  needsUpdate: sequencesNeedUpdate,
};

export class SequenceHandler {
  generateStatements(desiredSequences: Sequence[], currentSequences: Sequence[]): string[] {
    return generateStatements(desiredSequences, currentSequences, config);
  }
}
