/**
 * Schema Definition Parser
 *
 * Handles parsing of PostgreSQL CREATE SCHEMA statements from pgsql-parser AST.
 */

import { Logger } from "../../../utils/logger";
import type { SchemaDefinition } from "../../../types/schema";

/**
 * Parse CREATE SCHEMA statement from pgsql-parser AST
 */
export function parseCreateSchema(stmt: any): SchemaDefinition | null {
  try {
    const name = stmt.schemaname;
    if (!name) return null;

    return {
      name,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE SCHEMA: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
