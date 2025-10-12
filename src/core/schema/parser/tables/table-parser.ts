/**
 * Table Parser
 *
 * Handles parsing of CREATE TABLE statements from CST.
 * Coordinates column and constraint extraction.
 */

import { Logger } from "../../../../utils/logger";
import { extractTableNameFromCST } from "../cst-utils";
import { extractColumns } from "./column-parser";
import { extractAllConstraints } from "./constraint-parser";
import type { Table } from "../../../../types/schema";

/**
 * Parse CREATE TABLE statement from CST
 */
export function parseCreateTable(node: any): Table | null {
  try {
    // Extract table name
    const tableName = extractTableNameFromCST(node);
    if (!tableName) return null;

    // Extract columns
    const columns = extractColumns(node);

    // Extract ALL constraints in a unified way
    const constraints = extractAllConstraints(node, tableName);

    return {
      name: tableName,
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
      `Failed to parse CREATE TABLE from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
