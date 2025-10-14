/**
 * Table Parser
 *
 * Handles parsing of CREATE TABLE statements from pgsql-parser AST.
 * Coordinates column and constraint extraction.
 */

import { Logger } from "../../../../utils/logger";
import { extractColumns } from "./column-parser";
import { extractAllConstraints } from "./constraint-parser";
import type { Table } from "../../../../types/schema";

/**
 * Parse CREATE TABLE statement from pgsql-parser AST
 */
export function parseCreateTable(stmt: any): Table | null {
  try {
    const relation = stmt.relation;
    if (!relation) return null;

    const tableName = relation.relname;
    if (!tableName) return null;

    const schema = relation.schemaname || undefined;

    const columns = extractColumns(stmt.tableElts || []);

    const constraints = extractAllConstraints(stmt.tableElts || [], tableName);

    return {
      name: tableName,
      schema,
      columns,
      primaryKey: constraints.primaryKey,
      foreignKeys:
        constraints.foreignKeys.length > 0
          ? constraints.foreignKeys
          : undefined,
      checkConstraints:
        constraints.checkConstraints.length > 0
          ? constraints.checkConstraints
          : undefined,
      uniqueConstraints:
        constraints.uniqueConstraints.length > 0
          ? constraints.uniqueConstraints
          : undefined,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE TABLE: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
