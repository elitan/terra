/**
 * INDEX Parser
 *
 * Handles parsing of PostgreSQL CREATE INDEX statements from pgsql-parser AST.
 */

import { Logger } from "../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type { Index } from "../../../types/schema";
import { parseStorageParameterOptions } from "../../../utils/storage-parameters";

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

    const columns: string[] = [];
    const sortOrders: ('ASC' | 'DESC')[] = [];
    let opclasses: Record<string, string> | undefined;
    let expression: string | undefined;
    let expressionOpclass: string | undefined;

    function parseOrdering(ordering: string | number | undefined): 'ASC' | 'DESC' {
      if (ordering === 'SORTBY_DESC' || ordering === 2) return 'DESC';
      return 'ASC';
    }

    function parseOpclass(opclass: any[] | undefined): string | undefined {
      if (!opclass || opclass.length === 0) {
        return undefined;
      }

      return opclass
        .map((node: any) => node.String?.sval)
        .filter(Boolean)
        .join('.') || undefined;
    }

    if (indexParams.length === 1 && indexParams[0].IndexElem?.expr) {
      expression = deparseSync([indexParams[0].IndexElem.expr]).trim();
      expressionOpclass = parseOpclass(indexParams[0].IndexElem.opclass);
      const ordering = indexParams[0].IndexElem.ordering;
      sortOrders.push(parseOrdering(ordering));
    } else {
      for (const param of indexParams) {
        if (param.IndexElem) {
          const colName = param.IndexElem.name;
          const ordering = param.IndexElem.ordering;
          if (colName) {
            columns.push(colName);
            sortOrders.push(parseOrdering(ordering));
            const opclassName = parseOpclass(param.IndexElem.opclass);
            if (opclassName) {
              if (!opclasses) opclasses = {};
              opclasses[colName] = opclassName;
            }
          } else if (param.IndexElem.expr) {
            expression = deparseSync([param.IndexElem.expr]).trim();
            expressionOpclass = parseOpclass(param.IndexElem.opclass);
            sortOrders.push(parseOrdering(ordering));
            break;
          }
        }
      }
    }
    const hasNonDefaultSort = sortOrders.some(s => s === 'DESC');

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

    return {
      name: indexName,
      tableName,
      schema,
      columns,
      sortOrders: hasNonDefaultSort ? sortOrders : undefined,
      opclasses,
      ...(expressionOpclass ? { expressionOpclass } : {}),
      type,
      unique,
      concurrent,
      where: whereClause,
      expression,
      storageParameters,
      tablespace,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE INDEX: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
