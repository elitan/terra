/**
 * ENUM Type Parser
 *
 * Handles parsing of PostgreSQL ENUM types from pgsql-parser AST.
 */

import { Logger } from "../../../utils/logger";
import type { EnumType } from "../../../types/schema";

/**
 * Parse CREATE TYPE (ENUM) statement from pgsql-parser AST
 */
export function parseCreateType(stmt: any): EnumType | null {
  try {
    if (!stmt.typeName || !stmt.vals) return null;

    const typeNames = stmt.typeName.map((n: any) => n.String?.sval || '');

    let typeName: string;
    let schema: string | undefined;

    if (typeNames.length > 1) {
      schema = typeNames[0];
      typeName = typeNames[typeNames.length - 1];
    } else {
      typeName = typeNames[0];
    }

    if (!typeName) return null;

    const values = stmt.vals.map((v: any) => v.String?.sval || '').filter(Boolean);

    if (values.length === 0) {
      throw new Error(
        `Invalid ENUM type '${typeName}': ENUM types must have at least one value. ` +
          `Empty ENUM types are not allowed in PostgreSQL.`
      );
    }

    return {
      name: typeName,
      schema,
      values,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Invalid ENUM type")) {
      throw error;
    }

    Logger.warning(
      `Failed to parse CREATE TYPE: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
