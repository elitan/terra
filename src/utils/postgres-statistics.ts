import type {
  PostgresColumnStatistics,
  QualifiedName,
} from "../types/schema";
import { ValidationError } from "../types/errors";

const ATTRIBUTE_OPTION_FIELDS = [
  ["n_distinct", "nDistinct"],
  ["n_distinct_inherited", "nDistinctInherited"],
] as const;

type AttributeOptionName = (typeof ATTRIBUTE_OPTION_FIELDS)[number][0];
type AttributeOptionField = (typeof ATTRIBUTE_OPTION_FIELDS)[number][1];

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function qualifyName(relation: QualifiedName): string {
  return `${quoteIdentifier(relation.schema || "public")}.${quoteIdentifier(relation.name)}`;
}

function renderNumber(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

export function validatePostgresStatisticsTarget(
  value: number,
  identity: string
): void {
  if (!Number.isInteger(value) || value < 0 || value > 10000) {
    throw new ValidationError(
      `PostgreSQL statistics target for ${identity} must be an integer from 0 through 10000`,
      identity,
      "statisticsTarget",
      value
    );
  }
}

export function validatePostgresDistinctOverride(
  value: number,
  identity: string,
  optionName: AttributeOptionName
): void {
  if (!Number.isFinite(value) || value < -1) {
    throw new ValidationError(
      `PostgreSQL ${optionName} for ${identity} must be a finite number greater than or equal to -1`,
      identity,
      optionName,
      value
    );
  }
}

export function postgresStatisticsTargetFromCatalog(
  value: unknown,
  identity: string
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed < 0) {
    return undefined;
  }
  validatePostgresStatisticsTarget(parsed, identity);
  return parsed;
}

export function postgresAttributeOptionsFromCatalog(
  options: unknown,
  identity: string
): Pick<PostgresColumnStatistics, AttributeOptionField> {
  if (options === null || options === undefined) {
    return {};
  }
  if (!Array.isArray(options)) {
    throw new ValidationError(
      `PostgreSQL attribute options for ${identity} have an unsupported catalog representation`,
      identity,
      "attoptions",
      options
    );
  }

  const parsed: Pick<PostgresColumnStatistics, AttributeOptionField> = {};
  const knownFields = new Map<string, AttributeOptionField>(
    ATTRIBUTE_OPTION_FIELDS
  );
  for (const rawOption of options) {
    const option = String(rawOption);
    const separator = option.indexOf("=");
    const optionName = separator >= 0 ? option.slice(0, separator) : option;
    const field = knownFields.get(optionName);
    if (!field || separator < 0 || parsed[field] !== undefined) {
      throw new ValidationError(
        `Unsupported PostgreSQL attribute option '${option}' is present on ${identity}; TerraDB supports only n_distinct and n_distinct_inherited`,
        identity,
        "attoptions",
        options
      );
    }
    const value = Number(option.slice(separator + 1));
    validatePostgresDistinctOverride(
      value,
      identity,
      optionName as AttributeOptionName
    );
    parsed[field] = value;
  }
  return parsed;
}

export function postgresColumnStatisticsFromCatalog(
  column: string,
  target: unknown,
  options: unknown,
  relationIdentity: string
): PostgresColumnStatistics | undefined {
  const identity = `${relationIdentity}.${column}`;
  const statisticsTarget = postgresStatisticsTargetFromCatalog(
    target,
    identity
  );
  const attributeOptions = postgresAttributeOptionsFromCatalog(
    options,
    identity
  );
  if (
    statisticsTarget === undefined &&
    attributeOptions.nDistinct === undefined &&
    attributeOptions.nDistinctInherited === undefined
  ) {
    return undefined;
  }
  return {
    column,
    ...(statisticsTarget !== undefined ? { statisticsTarget } : {}),
    ...attributeOptions,
  };
}

export function validatePostgresColumnStatistics(
  entries: PostgresColumnStatistics[] | undefined,
  relationIdentity: string,
  availableColumns?: ReadonlySet<string>
): void {
  const seen = new Set<string>();
  for (const entry of entries || []) {
    const identity = `${relationIdentity}.${entry.column}`;
    if (seen.has(entry.column)) {
      throw new ValidationError(
        `PostgreSQL column statistics for ${identity} are declared more than once`,
        identity,
        "columnStatistics",
        entry
      );
    }
    seen.add(entry.column);
    if (availableColumns && !availableColumns.has(entry.column)) {
      throw new ValidationError(
        `PostgreSQL column statistics target ${identity} does not name a column on the relation`,
        identity,
        "columnStatistics",
        entry
      );
    }
    if (entry.statisticsTarget !== undefined) {
      validatePostgresStatisticsTarget(entry.statisticsTarget, identity);
    }
    if (entry.nDistinct !== undefined) {
      validatePostgresDistinctOverride(
        entry.nDistinct,
        identity,
        "n_distinct"
      );
    }
    if (entry.nDistinctInherited !== undefined) {
      validatePostgresDistinctOverride(
        entry.nDistinctInherited,
        identity,
        "n_distinct_inherited"
      );
    }
  }
}

function mapStatistics(
  entries: PostgresColumnStatistics[] | undefined
): Map<string, PostgresColumnStatistics> {
  return new Map(
    (entries || []).map(function mapEntry(entry) {
      return [entry.column, entry] as const;
    })
  );
}

function renderAttributeChanges(
  column: string,
  desired: PostgresColumnStatistics,
  current: PostgresColumnStatistics
): { setCommands: string[]; resetCommands: string[] } {
  const setOptions: string[] = [];
  const resetOptions: string[] = [];
  for (const [optionName, field] of ATTRIBUTE_OPTION_FIELDS) {
    const desiredValue = desired[field];
    const currentValue = current[field];
    if (desiredValue === currentValue) {
      continue;
    }
    if (desiredValue === undefined) {
      resetOptions.push(optionName);
    } else {
      setOptions.push(`${optionName}=${renderNumber(desiredValue)}`);
    }
  }

  const quotedColumn = quoteIdentifier(column);
  const setCommands: string[] = [];
  const resetCommands: string[] = [];
  if (setOptions.length > 0) {
    setCommands.push(
      `ALTER COLUMN ${quotedColumn} SET (${setOptions.join(", ")})`
    );
  }
  if (resetOptions.length > 0) {
    resetCommands.push(
      `ALTER COLUMN ${quotedColumn} RESET (${resetOptions.join(", ")})`
    );
  }
  return { setCommands, resetCommands };
}

export function renderPostgresColumnStatisticsChanges(
  relation: QualifiedName,
  desiredEntries: PostgresColumnStatistics[] | undefined,
  currentEntries: PostgresColumnStatistics[] | undefined,
  relationKind: "table" | "materialized-view"
): string[] {
  const desired = mapStatistics(desiredEntries);
  const current = mapStatistics(currentEntries);
  const columns = [...new Set([...desired.keys(), ...current.keys()])].sort(
    function compareColumns(first, second) {
      return first.localeCompare(second);
    }
  );
  const setCommands: string[] = [];
  const resetCommands: string[] = [];

  for (const column of columns) {
    const desiredEntry = desired.get(column) || { column };
    const currentEntry = current.get(column) || { column };
    if (desiredEntry.statisticsTarget !== currentEntry.statisticsTarget) {
      if (desiredEntry.statisticsTarget === undefined) {
        resetCommands.push(
          `ALTER COLUMN ${quoteIdentifier(column)} SET STATISTICS -1`
        );
      } else {
        setCommands.push(
          `ALTER COLUMN ${quoteIdentifier(column)} SET STATISTICS ${renderNumber(
            desiredEntry.statisticsTarget
          )}`
        );
      }
    }
    const attributeChanges = renderAttributeChanges(
      column,
      desiredEntry,
      currentEntry
    );
    setCommands.push(...attributeChanges.setCommands);
    resetCommands.push(...attributeChanges.resetCommands);
  }

  if (setCommands.length === 0 && resetCommands.length === 0) {
    return [];
  }
  const prefix = relationKind === "table"
    ? `ALTER TABLE ONLY ${qualifyName(relation)}`
    : `ALTER MATERIALIZED VIEW ${qualifyName(relation)}`;
  const statements: string[] = [];
  if (setCommands.length > 0) {
    statements.push(`${prefix} ${setCommands.join(", ")};`);
  }
  for (const resetCommand of resetCommands) {
    statements.push(`${prefix} ${resetCommand};`);
  }
  return statements;
}

export function renderPostgresExpressionIndexStatistics(
  index: QualifiedName,
  target: number | undefined,
  position: number = 1
): string {
  return `ALTER INDEX ${qualifyName(index)} ALTER COLUMN ${position} SET STATISTICS ${
    target === undefined ? "-1" : renderNumber(target)
  };`;
}

export function remapPostgresColumnStatisticsByOrdinal(
  entries: PostgresColumnStatistics[] | undefined,
  currentColumns: string[] | undefined,
  desiredColumns: string[] | undefined
): PostgresColumnStatistics[] | undefined {
  if (!entries || !currentColumns || !desiredColumns) {
    return entries;
  }
  const desiredByCurrent = new Map<string, string>();
  const sharedLength = Math.min(currentColumns.length, desiredColumns.length);
  for (let index = 0; index < sharedLength; index++) {
    const current = currentColumns[index];
    const desired = desiredColumns[index];
    if (current && desired) {
      desiredByCurrent.set(current, desired);
    }
  }
  return entries.map(function remapEntry(entry) {
    return {
      ...entry,
      column: desiredByCurrent.get(entry.column) || entry.column,
    };
  });
}
