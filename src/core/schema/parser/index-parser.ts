/**
 * INDEX Parser
 *
 * Handles parsing of PostgreSQL CREATE INDEX statements from pgsql-parser AST.
 */

import { Logger } from "../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type { Index } from "../../../types/schema";

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
    let expression: string | undefined;

    if (indexParams.length === 1 && indexParams[0].IndexElem?.expr) {
      expression = deparseSync([indexParams[0].IndexElem.expr]).trim();
    } else {
      for (const param of indexParams) {
        if (param.IndexElem) {
          const colName = param.IndexElem.name;
          if (colName) {
            columns.push(colName);
          } else if (param.IndexElem.expr) {
            expression = deparseSync([param.IndexElem.expr]).trim();
            break;
          }
        }
      }
    }

    const type = (stmt.accessMethod || 'btree').toLowerCase() as Index["type"];

    const unique = stmt.unique || false;

    const concurrent = stmt.concurrent || false;

    const whereClause = stmt.whereClause ? deparseSync([stmt.whereClause]).trim() : undefined;

    let storageParameters: Record<string, string> | undefined;
    if (stmt.options && stmt.options.length > 0) {
      storageParameters = {};
      for (const opt of stmt.options) {
        if (opt.DefElem) {
          const key = opt.DefElem.defname;
          let value: string | undefined;
          if (opt.DefElem.arg?.Integer) {
            value = String(opt.DefElem.arg.Integer.ival);
          } else if (opt.DefElem.arg?.String) {
            value = opt.DefElem.arg.String.sval;
          }
          if (key && value) {
            storageParameters[key] = value;
          }
        }
      }
      if (Object.keys(storageParameters).length === 0) {
        storageParameters = undefined;
      }
    }

    const tablespace = stmt.tableSpaceName || undefined;

    return {
      name: indexName,
      tableName,
      schema,
      columns,
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
