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

    return {
      name: viewName,
      schema,
      definition,
      materialized,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE VIEW: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
