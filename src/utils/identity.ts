import type { IdentityColumn, IdentitySequenceName } from "../types/schema";

type IdentityNumericOption =
  | "start"
  | "increment"
  | "minValue"
  | "maxValue"
  | "cache";

export type IdentityOptionChange = {
  clause: string;
  order: number;
};

const INTEGER_BOUNDS: Record<string, { min: string; max: string }> = {
  INT2: { min: "-32768", max: "32767" },
  SMALLINT: { min: "-32768", max: "32767" },
  INT: { min: "-2147483648", max: "2147483647" },
  INT4: { min: "-2147483648", max: "2147483647" },
  INTEGER: { min: "-2147483648", max: "2147483647" },
  INT8: { min: "-9223372036854775808", max: "9223372036854775807" },
  BIGINT: { min: "-9223372036854775808", max: "9223372036854775807" },
};

const NUMERIC_OPTIONS: IdentityNumericOption[] = [
  "start",
  "increment",
  "minValue",
  "maxValue",
  "cache",
];

function getIntegerBounds(
  columnType: string
): { min: string; max: string } | undefined {
  const normalized = columnType.trim().toUpperCase();
  return INTEGER_BOUNDS[normalized];
}

function isNegative(value: string): boolean {
  return value.trim().startsWith("-");
}

function compareIntegerStrings(left: string, right: string): number | undefined {
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
    return 0;
  } catch {
    return undefined;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function renderSequenceName(sequenceName: IdentitySequenceName): string {
  const name = quoteIdentifier(sequenceName.name);
  if (!sequenceName.schema) return name;
  return `${quoteIdentifier(sequenceName.schema)}.${name}`;
}

function valuesDiffer(
  desired: IdentityColumn,
  current: IdentityColumn,
  option: IdentityNumericOption
): boolean {
  const desiredValue = desired[option];
  if (desiredValue === undefined) return false;
  return desiredValue !== current[option];
}

function namesDiffer(
  desired: IdentitySequenceName | undefined,
  current: IdentitySequenceName | undefined
): boolean {
  if (!desired) return false;
  if (!current || desired.name !== current.name) return true;
  return desired.schema !== undefined && desired.schema !== current.schema;
}

function optionClause(option: IdentityNumericOption, value: string): string {
  switch (option) {
    case "start":
      return `START WITH ${value}`;
    case "increment":
      return `INCREMENT BY ${value}`;
    case "minValue":
      return `MINVALUE ${value}`;
    case "maxValue":
      return `MAXVALUE ${value}`;
    case "cache":
      return `CACHE ${value}`;
  }
}

function boundaryOrder(
  option: "minValue" | "maxValue",
  desiredValue: string,
  currentValue: string | undefined
): number {
  if (currentValue === undefined) return 30;
  const comparison = compareIntegerStrings(desiredValue, currentValue);
  if (comparison === undefined) return 30;

  const expandsRange =
    (option === "minValue" && comparison < 0) ||
    (option === "maxValue" && comparison > 0);
  return expandsRange ? 10 : 40;
}

export function normalizeIdentityColumn(
  columnType: string,
  identity: IdentityColumn
): IdentityColumn {
  const increment = identity.increment ?? "1";
  const bounds = getIntegerBounds(columnType);
  if (!bounds) {
    return {
      ...identity,
      increment,
      cache: identity.cache ?? "1",
      cycle: identity.cycle ?? false,
    };
  }

  const descending = isNegative(increment);
  const defaultMin = descending ? bounds.min : "1";
  const defaultMax = descending ? "-1" : bounds.max;
  const minValue = identity.minValue ?? defaultMin;
  const maxValue = identity.maxValue ?? defaultMax;

  return {
    ...identity,
    increment,
    minValue,
    maxValue,
    start: identity.start ?? (descending ? maxValue : minValue),
    cache: identity.cache ?? "1",
    cycle: identity.cycle ?? false,
  };
}

export function renderIdentityClause(identity: IdentityColumn): string {
  const options: string[] = [];
  if (identity.sequenceName) {
    options.push(`SEQUENCE NAME ${renderSequenceName(identity.sequenceName)}`);
  }
  for (const option of NUMERIC_OPTIONS) {
    const value = identity[option];
    if (value !== undefined) options.push(optionClause(option, value));
  }
  if (identity.cycle !== undefined) {
    options.push(identity.cycle ? "CYCLE" : "NO CYCLE");
  }

  const renderedOptions = options.length > 0 ? ` (${options.join(" ")})` : "";
  return `GENERATED ${identity.generation} AS IDENTITY${renderedOptions}`;
}

export function identityColumnsAreDifferent(
  desired: IdentityColumn | undefined,
  current: IdentityColumn | undefined
): boolean {
  if (!desired || !current) return desired !== current;
  if (desired.generation !== current.generation) return true;
  if (namesDiffer(desired.sequenceName, current.sequenceName)) return true;
  const hasDifferentOption = NUMERIC_OPTIONS.some(function differs(option) {
    return valuesDiffer(desired, current, option);
  });
  if (hasDifferentOption) {
    return true;
  }
  return desired.cycle !== undefined && desired.cycle !== current.cycle;
}

export function getIdentityOptionChanges(
  desired: IdentityColumn,
  current: IdentityColumn
): IdentityOptionChange[] {
  const changes: IdentityOptionChange[] = [];

  for (const option of NUMERIC_OPTIONS) {
    const desiredValue = desired[option];
    if (desiredValue === undefined || !valuesDiffer(desired, current, option)) {
      continue;
    }

    let order = 30;
    if (option === "minValue" || option === "maxValue") {
      order = boundaryOrder(option, desiredValue, current[option]);
    } else if (option === "increment") {
      order = 20;
    } else if (option === "start") {
      order = 30;
    } else if (option === "cache") {
      order = 50;
    }
    changes.push({ clause: optionClause(option, desiredValue), order });
  }

  if (desired.cycle !== undefined && desired.cycle !== current.cycle) {
    changes.push({
      clause: desired.cycle ? "CYCLE" : "NO CYCLE",
      order: 60,
    });
  }

  return changes.sort(function sortIdentityChanges(left, right) {
    return left.order - right.order || left.clause.localeCompare(right.clause);
  });
}

export function identitySequenceNamesDiffer(
  desired: IdentitySequenceName | undefined,
  current: IdentitySequenceName | undefined
): boolean {
  return namesDiffer(desired, current);
}
