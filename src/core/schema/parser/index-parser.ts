/**
 * INDEX Parser
 *
 * Handles parsing of PostgreSQL CREATE INDEX statements from pgsql-parser AST.
 */

import { Logger } from "../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type {
  Index,
  IndexTerm,
  QualifiedName,
} from "../../../types/schema";
import { parseStorageParameterOptions } from "../../../utils/storage-parameters";
import { synchronizeLegacyIndexFields } from "../../../utils/postgres-index";

function parseOrdering(
  ordering: string | number | undefined
): 'ASC' | 'DESC' {
  if (ordering === 'SORTBY_DESC' || ordering === 2) return 'DESC';
  return 'ASC';
}

function parseNullsOrdering(
  nullsOrdering: string | number | undefined,
  sortOrder: 'ASC' | 'DESC'
): 'FIRST' | 'LAST' {
  if (nullsOrdering === 'SORTBY_NULLS_FIRST' || nullsOrdering === 1) {
    return 'FIRST';
  }
  if (nullsOrdering === 'SORTBY_NULLS_LAST' || nullsOrdering === 2) {
    return 'LAST';
  }
  return sortOrder === 'DESC' ? 'FIRST' : 'LAST';
}

function parseQualifiedName(
  nodes: any[] | undefined
): QualifiedName | undefined {
  const nameParts = (nodes || [])
    .map(function getNamePart(node: any) {
      return node.String?.sval;
    })
    .filter(function hasNamePart(value: unknown): value is string {
      return typeof value === "string" && value.length > 0;
    });
  const name = nameParts.at(-1);
  if (!name) {
    return undefined;
  }
  const schema = nameParts.length > 1 ? nameParts.at(-2) : undefined;
  return schema ? { name, schema } : { name };
}

function parseOpclassOptionValue(node: any): string {
  if (node?.Integer) {
    return String(node.Integer.ival ?? 0);
  }
  if (node?.Float && typeof node.Float.fval === "string") {
    return node.Float.fval;
  }
  if (node?.String && typeof node.String.sval === "string") {
    return node.String.sval;
  }
  if (node?.A_Const) {
    return parseOpclassOptionValue(node.A_Const);
  }
  return deparseSync([node]).trim();
}

function parseOpclassOptions(
  options: any[] | undefined
): Record<string, string> | undefined {
  let parsed: Record<string, string> | undefined;
  for (const option of options || []) {
    const definition = option.DefElem;
    if (!definition?.defname || !definition.arg) {
      continue;
    }
    if (!parsed) {
      parsed = {};
    }
    parsed[definition.defname] = parseOpclassOptionValue(definition.arg);
  }
  return parsed;
}

function parseIndexTerm(param: any): IndexTerm | undefined {
  const element = param.IndexElem;
  if (!element) {
    return undefined;
  }
  const order = parseOrdering(element.ordering);
  const collation = parseQualifiedName(element.collation);
  const opclass = parseQualifiedName(element.opclass);
  const opclassOptions = parseOpclassOptions(element.opclassopts);
  const common = {
    ...(collation ? { collation } : {}),
    ...(opclass ? { opclass } : {}),
    ...(opclassOptions ? { opclassOptions } : {}),
    order,
    nullsOrder: parseNullsOrdering(element.nulls_ordering, order),
  };
  if (element.name) {
    return { column: element.name, ...common };
  }
  if (element.expr) {
    return {
      expression: deparseSync([element.expr]).trim(),
      ...common,
    };
  }
  return undefined;
}

/**
 * Parse CREATE INDEX statement from pgsql-parser AST
 */
export function parseCreateIndex(stmt: any): Index | null {
  try {
    const indexName = stmt.idxname;
    if (!indexName) return null;

    const tableName = stmt.relation?.relname;
    if (!tableName) return null;

    const schema = stmt.relation?.schemaname || undefined;

    const indexParams = stmt.indexParams || [];
    const include = (stmt.indexIncludingParams || [])
      .map(function getIncludedColumn(param: any) {
        return param.IndexElem?.name;
      })
      .filter(Boolean);

    const terms = indexParams.flatMap(function getIndexTerm(param: any) {
      const term = parseIndexTerm(param);
      return term ? [term] : [];
    });

    const type = (stmt.accessMethod || 'btree').toLowerCase() as Index["type"];

    const unique = stmt.unique || false;

    const concurrent = stmt.concurrent || false;

    const whereClause = stmt.whereClause ? deparseSync([stmt.whereClause]).trim() : undefined;

    const storageParameters = parseStorageParameterOptions(stmt.options);

    let tablespace: string | undefined;
    if (stmt.tableSpace) {
      if (typeof stmt.tableSpace === 'string') {
        const tsName = stmt.tableSpace;
        if (tsName.includes('-') || tsName.includes(' ') || /[A-Z]/.test(tsName)) {
          tablespace = '"' + tsName + '"';
        } else {
          tablespace = tsName;
        }
      } else if (stmt.tableSpace.String?.sval) {
        const sval = stmt.tableSpace.String.sval;
        if (sval.includes('-') || sval.includes(' ') || /[A-Z]/.test(sval)) {
          tablespace = '"' + sval + '"';
        } else {
          tablespace = sval;
        }
      } else {
        tablespace = deparseSync([stmt.tableSpace]).trim();
      }
    }

    const index: Index = {
      name: indexName,
      tableName,
      schema,
      columns: [],
      ...(include.length > 0 ? { include } : {}),
      terms,
      type,
      unique,
      ...(stmt.nulls_not_distinct ? { nullsNotDistinct: true } : {}),
      concurrent,
      where: whereClause,
      storageParameters,
      tablespace,
    };
    synchronizeLegacyIndexFields(index);
    return index;
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE INDEX: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
