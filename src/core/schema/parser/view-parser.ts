/**
 * VIEW Parser
 *
 * Handles parsing of PostgreSQL VIEWs from pgsql-parser AST.
 */

import { Logger } from "../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type { View } from "../../../types/schema";

/**
 * Parse CREATE VIEW statement from pgsql-parser AST
 */
export function parseCreateView(stmt: any, originalSql: string): View | null {
  try {
    const view = stmt.view;
    if (!view) return null;

    const viewName = view.relname;
    if (!viewName) return null;

    const schema = view.schemaname || undefined;

    const definition = stmt.query ? deparseSync([stmt.query]).trim() : '';
    if (!definition) return null;

    const materialized = false;

    let checkOption: 'CASCADED' | 'LOCAL' | undefined = undefined;
    if (stmt.withCheckOption) {
      if (stmt.withCheckOption === 'CASCADED_CHECK_OPTION') {
        checkOption = 'CASCADED';
      } else if (stmt.withCheckOption === 'LOCAL_CHECK_OPTION') {
        checkOption = 'LOCAL';
      }
    }

    return {
      name: viewName,
      schema,
      definition,
      materialized,
      checkOption,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE VIEW: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export function parseCreateMaterializedView(stmt: any): View | null {
  try {
    if (stmt.objtype !== 'OBJECT_MATVIEW') return null;

    const into = stmt.into;
    if (!into || !into.rel) return null;

    const viewName = into.rel.relname;
    if (!viewName) return null;

    const schema = into.rel.schemaname || undefined;

    const definition = stmt.query ? deparseSync([stmt.query]).trim() : '';
    if (!definition) return null;

    return {
      name: viewName,
      schema,
      definition,
      materialized: true,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE MATERIALIZED VIEW: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
