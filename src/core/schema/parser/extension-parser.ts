/**
 * Extension Parser
 *
 * Handles parsing of PostgreSQL CREATE EXTENSION statements from pgsql-parser AST.
 */

import { Logger } from "../../../utils/logger";
import type { Extension } from "../../../types/schema";

/**
 * Parse CREATE EXTENSION statement from pgsql-parser AST
 */
export function parseCreateExtension(stmt: any): Extension | null {
  try {
    const name = stmt.extname;
    if (!name) return null;

    return {
      name,
      schema: stmt.options?.find((o: any) => o.DefElem?.defname === 'schema')?.DefElem?.arg?.String?.sval,
      version: stmt.options?.find((o: any) => o.DefElem?.defname === 'new_version')?.DefElem?.arg?.String?.sval,
      cascade: stmt.options?.some((o: any) => o.DefElem?.defname === 'cascade') || false,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE EXTENSION: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
