import type {
  Index,
  PostgresColumnStatistics,
  SqlObject,
  Table,
  View,
} from "../../../types/schema";
import { ParserError } from "../../../types/errors";
import {
  getPostgresIndexTerms,
  synchronizeLegacyIndexFields,
} from "../../../utils/postgres-index";

type StatisticsField =
  | "statisticsTarget"
  | "nDistinct"
  | "nDistinctInherited";

type RelationKind = "table" | "materialized-view" | "index";

export interface PendingPostgresStatisticsChange {
  schemaName?: string;
  relationName: string;
  relationKind: RelationKind;
  columnName?: string;
  indexPosition?: number;
  field: StatisticsField;
  value?: number;
  includeDescendants: boolean;
}

const STATISTICS_SUBTYPES = new Set([
  "AT_SetStatistics",
  "AT_SetOptions",
  "AT_ResetOptions",
]);

const ATTRIBUTE_OPTION_FIELDS = new Map<string, StatisticsField>([
  ["n_distinct", "nDistinct"],
  ["n_distinct_inherited", "nDistinctInherited"],
]);

export function isPostgresStatisticsSubtype(subtype: unknown): boolean {
  return typeof subtype === "string" && STATISTICS_SUBTYPES.has(subtype);
}

function relationKindFromObjectType(objectType: unknown): RelationKind | undefined {
  if (objectType === "OBJECT_TABLE") return "table";
  if (objectType === "OBJECT_MATVIEW") return "materialized-view";
  if (objectType === "OBJECT_INDEX") return "index";
  return undefined;
}

function numericNodeValue(node: any): number | undefined {
  if (node?.Integer) {
    return Number(node.Integer.ival ?? 0);
  }
  if (node?.Float && typeof node.Float.fval === "string") {
    return Number(node.Float.fval);
  }
  if (node?.A_Const?.Integer) {
    return Number(node.A_Const.Integer.ival ?? 0);
  }
  if (
    node?.A_Const?.Float &&
    typeof node.A_Const.Float.fval === "string"
  ) {
    return Number(node.A_Const.Float.fval);
  }
  return undefined;
}

function parseStatisticsTarget(
  command: any,
  relationKind: RelationKind,
  filePath?: string
): number | undefined {
  if (!command.def) {
    if (relationKind === "index") {
      throw new ParserError(
        "PostgreSQL ALTER INDEX SET STATISTICS DEFAULT is not supported by PostgreSQL 14-18; use -1 to select the default target",
        filePath
      );
    }
    return undefined;
  }
  const value = numericNodeValue(command.def);
  if (value === -1) {
    return undefined;
  }
  if (!Number.isInteger(value) || value! < 0 || value! > 10000) {
    throw new ParserError(
      "PostgreSQL statistics targets must be -1/default or an integer from 0 through 10000",
      filePath
    );
  }
  return value;
}

function parseAttributeOptionValue(
  optionName: string,
  node: any,
  filePath?: string
): number {
  const value = numericNodeValue(node);
  if (value === undefined || !Number.isFinite(value) || value < -1) {
    throw new ParserError(
      `PostgreSQL ${optionName} must be a finite number greater than or equal to -1`,
      filePath
    );
  }
  return value;
}

function parseAttributeOptions(
  command: any,
  reset: boolean,
  base: Omit<PendingPostgresStatisticsChange, "field" | "value">,
  filePath?: string
): PendingPostgresStatisticsChange[] {
  const items = command.def?.List?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ParserError(
      "PostgreSQL per-column attribute options must name n_distinct or n_distinct_inherited",
      filePath
    );
  }

  const changes: PendingPostgresStatisticsChange[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const option = item?.DefElem;
    const optionName = option?.defname;
    const field = ATTRIBUTE_OPTION_FIELDS.get(optionName);
    if (!field) {
      throw new ParserError(
        `Unsupported PostgreSQL per-column attribute option '${String(optionName)}'; TerraDB supports only n_distinct and n_distinct_inherited`,
        filePath
      );
    }
    if (seen.has(optionName)) {
      throw new ParserError(
        `PostgreSQL per-column attribute option '${optionName}' is declared more than once`,
        filePath
      );
    }
    seen.add(optionName);
    changes.push({
      ...base,
      field,
      ...(reset
        ? {}
        : {
            value: parseAttributeOptionValue(
              optionName,
              option.arg,
              filePath
            ),
          }),
    });
  }
  return changes;
}

export function parseAlterPostgresStatistics(
  stmt: any,
  filePath?: string
): PendingPostgresStatisticsChange[] {
  const commands = (stmt?.cmds || []).filter(function isStatisticsCommand(
    item: any
  ) {
    return isPostgresStatisticsSubtype(item?.AlterTableCmd?.subtype);
  });
  if (commands.length === 0) {
    return [];
  }

  const relationKind = relationKindFromObjectType(stmt.objtype);
  if (!relationKind) {
    throw new ParserError(
      "PostgreSQL per-column statistics are supported only for ordinary tables, materialized views, and expression indexes",
      filePath
    );
  }
  const relation = stmt.relation;
  if (!relation?.relname) {
    throw new ParserError(
      "PostgreSQL per-column statistics target is missing a relation name",
      filePath
    );
  }

  const changes: PendingPostgresStatisticsChange[] = [];
  for (const wrapper of commands) {
    const command = wrapper.AlterTableCmd;
    const subtype = command.subtype;
    if (relationKind === "index") {
      if (subtype !== "AT_SetStatistics") {
        throw new ParserError(
          "PostgreSQL expression indexes support SET STATISTICS, not per-column attribute options",
          filePath
        );
      }
      changes.push({
        schemaName: relation.schemaname,
        relationName: relation.relname,
        relationKind,
        indexPosition: Number(command.num ?? 0),
        field: "statisticsTarget",
        value: parseStatisticsTarget(command, relationKind, filePath),
        includeDescendants: false,
      });
      continue;
    }

    if (typeof command.name !== "string" || command.name.length === 0) {
      throw new ParserError(
        "PostgreSQL per-column statistics target is missing a column name",
        filePath
      );
    }
    const base = {
      schemaName: relation.schemaname,
      relationName: relation.relname,
      relationKind,
      columnName: command.name,
      includeDescendants:
        relationKind === "table" && relation.inh === true &&
        subtype === "AT_SetStatistics",
    } satisfies Omit<
      PendingPostgresStatisticsChange,
      "field" | "value"
    >;

    if (subtype === "AT_SetStatistics") {
      changes.push({
        ...base,
        field: "statisticsTarget",
        value: parseStatisticsTarget(command, relationKind, filePath),
      });
    } else {
      changes.push(
        ...parseAttributeOptions(
          command,
          subtype === "AT_ResetOptions",
          base,
          filePath
        )
      );
    }
  }
  return changes;
}

function relationKey(name: string, schema?: string): string {
  return `${schema || "public"}.${name}`;
}

function mapRelations<T extends { name: string; schema?: string }>(
  relations: T[]
): Map<string, T> {
  return new Map(
    relations.map(function mapRelation(relation) {
      return [relationKey(relation.name, relation.schema), relation] as const;
    })
  );
}

function getParentKey(table: Table, parent: { name: string; schema?: string }): string {
  return relationKey(parent.name, parent.schema || table.schema);
}

function tableHasColumn(
  table: Table,
  columnName: string,
  tables: Map<string, Table>,
  visited: Set<string>
): boolean {
  const key = relationKey(table.name, table.schema);
  if (visited.has(key)) {
    return false;
  }
  visited.add(key);
  if (
    [...table.columns, ...(table.inheritedColumns || [])].some(
      function hasColumn(column) {
        return column.name === columnName;
      }
    )
  ) {
    return true;
  }
  return (table.inherits || []).some(function parentHasColumn(parent) {
    const parentTable = tables.get(getParentKey(table, parent));
    return Boolean(
      parentTable &&
      tableHasColumn(parentTable, columnName, tables, new Set(visited))
    );
  });
}

function buildDescendants(tables: Table[]): Map<string, Table[]> {
  const descendants = new Map<string, Table[]>();
  for (const table of tables) {
    for (const parent of table.inherits || []) {
      const key = getParentKey(table, parent);
      const children = descendants.get(key) || [];
      children.push(table);
      descendants.set(key, children);
    }
  }
  for (const children of descendants.values()) {
    children.sort(function compareTables(first, second) {
      return relationKey(first.name, first.schema).localeCompare(
        relationKey(second.name, second.schema)
      );
    });
  }
  return descendants;
}

function collectDescendants(
  table: Table,
  descendants: Map<string, Table[]>,
  result: Table[],
  visited: Set<string>
): void {
  const key = relationKey(table.name, table.schema);
  if (visited.has(key)) return;
  visited.add(key);
  for (const child of descendants.get(key) || []) {
    result.push(child);
    collectDescendants(child, descendants, result, visited);
  }
}

function applyColumnChange(
  relation: Table | View,
  columnName: string,
  field: StatisticsField,
  value: number | undefined
): void {
  const entries = relation.columnStatistics || [];
  let entry = entries.find(function findEntry(candidate) {
    return candidate.column === columnName;
  });
  if (!entry) {
    entry = { column: columnName };
    entries.push(entry);
  }
  if (value === undefined) {
    delete entry[field];
  } else {
    entry[field] = value;
  }
  relation.columnStatistics = entries
    .filter(function hasCustomState(candidate) {
      return candidate.statisticsTarget !== undefined ||
        candidate.nDistinct !== undefined ||
        candidate.nDistinctInherited !== undefined;
    })
    .sort(function compareEntries(first, second) {
      return first.column.localeCompare(second.column);
    });
  if (relation.columnStatistics.length === 0) {
    delete relation.columnStatistics;
  }
}

function resolveTableTarget(
  key: string,
  tableMap: Map<string, Table>,
  materializedViewMap: Map<string, View>,
  indexMap: Map<string, Index>,
  filePath?: string
): Table {
  const table = tableMap.get(key);
  if (table) return table;
  if (materializedViewMap.has(key) || indexMap.has(key)) {
    throw new ParserError(
      `PostgreSQL statistics target '${key}' must use ALTER TABLE for an ordinary table`,
      filePath
    );
  }
  throw new ParserError(
    `PostgreSQL statistics target '${key}' was not found in the desired schema`,
    filePath
  );
}

export function mergePendingPostgresStatistics(
  tables: Table[],
  views: View[],
  indexes: Index[],
  sqlObjects: SqlObject[],
  pending: PendingPostgresStatisticsChange[],
  filePath?: string
): void {
  const tableMap = mapRelations(tables);
  const materializedViewMap = mapRelations(
    views.filter(function isMaterialized(view) {
      return view.materialized === true;
    })
  );
  const ordinaryViewMap = mapRelations(
    views.filter(function isOrdinary(view) {
      return view.materialized !== true;
    })
  );
  const indexMap = mapRelations(indexes);
  const partitionKeys = new Set(
    sqlObjects
      .filter(function isPartition(object) {
        return object.kind === "partition";
      })
      .map(function getPartitionKey(object) {
        return relationKey(object.name, object.schema);
      })
  );
  const descendants = buildDescendants(tables);
  const seen = new Set<string>();

  for (const change of pending) {
    const key = relationKey(change.relationName, change.schemaName);
    if (partitionKeys.has(key)) {
      throw new ParserError(
        `PostgreSQL partition column statistics for '${key}' are not supported because partition relations are not represented as independently managed tables`,
        filePath
      );
    }

    if (change.relationKind === "index") {
      const index = indexMap.get(key);
      if (!index) {
        throw new ParserError(
          `PostgreSQL expression-index statistics target '${key}' was not found in the desired schema`,
          filePath
        );
      }
      const terms = getPostgresIndexTerms(index);
      const position = change.indexPosition!;
      const term = terms[position - 1];
      if (!term) {
        throw new ParserError(
          `PostgreSQL index statistics target '${key}' does not have key position ${position}`,
          filePath
        );
      }
      if (!term.expression) {
        throw new ParserError(
          `PostgreSQL index statistics target '${key}' position ${position} must select an expression key`,
          filePath
        );
      }
      const seenKey = `${key}:index:${position}:statisticsTarget`;
      if (seen.has(seenKey)) {
        throw new ParserError(
          `PostgreSQL expression-index statistics target for '${key}' is declared more than once`,
          filePath
        );
      }
      seen.add(seenKey);
      index.terms = terms;
      if (change.value === undefined) {
        delete term.statisticsTarget;
      } else {
        term.statisticsTarget = change.value;
      }
      synchronizeLegacyIndexFields(index);
      continue;
    }

    const columnName = change.columnName!;
    if (change.relationKind === "materialized-view") {
      const view = materializedViewMap.get(key);
      if (!view) {
        if (tableMap.has(key) || ordinaryViewMap.has(key)) {
          throw new ParserError(
            `PostgreSQL statistics target '${key}' must use ALTER MATERIALIZED VIEW for a materialized view`,
            filePath
          );
        }
        throw new ParserError(
          `PostgreSQL statistics target '${key}' was not found in the desired schema`,
          filePath
        );
      }
      if (!view.columnNames) {
        throw new ParserError(
          `Materialized view '${key}' must declare an explicit output-column list before TerraDB can validate statistics for column '${columnName}'`,
          filePath
        );
      }
      if (!view.columnNames.includes(columnName)) {
        throw new ParserError(
          `PostgreSQL statistics target '${key}.${columnName}' does not name an output column of the materialized view`,
          filePath
        );
      }
      const seenKey = `${key}:${columnName}:${change.field}`;
      if (seen.has(seenKey)) {
        throw new ParserError(
          `PostgreSQL statistics field '${change.field}' for '${key}.${columnName}' is declared more than once`,
          filePath
        );
      }
      seen.add(seenKey);
      applyColumnChange(view, columnName, change.field, change.value);
      continue;
    }

    const table = resolveTableTarget(
      key,
      tableMap,
      materializedViewMap,
      indexMap,
      filePath
    );
    const targets = [table];
    if (change.includeDescendants) {
      collectDescendants(table, descendants, targets, new Set());
    }
    for (const target of targets) {
      const targetKey = relationKey(target.name, target.schema);
      if (!tableHasColumn(target, columnName, tableMap, new Set())) {
        throw new ParserError(
          `PostgreSQL statistics target '${targetKey}.${columnName}' does not name a local or inherited column of the table`,
          filePath
        );
      }
      const seenKey = `${targetKey}:${columnName}:${change.field}`;
      if (seen.has(seenKey)) {
        throw new ParserError(
          `PostgreSQL statistics field '${change.field}' for '${targetKey}.${columnName}' is declared more than once`,
          filePath
        );
      }
      seen.add(seenKey);
      applyColumnChange(target, columnName, change.field, change.value);
    }
  }
}
