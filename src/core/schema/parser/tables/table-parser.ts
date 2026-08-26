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
import { parseStorageParameterOptions } from "../../../../utils/storage-parameters";

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
    const unlogged = relation.relpersistence === "u" ? true : undefined;
    const storageParameters = parseStorageParameterOptions(stmt.options);
    const accessMethod = stmt.accessMethod || undefined;
    const inherits = (stmt.inhRelations || [])
      .map(function parseParent(item: any) {
        const parent = item?.RangeVar;
        if (!parent?.relname) {
          return undefined;
        }
        return {
          name: parent.relname,
          schema: parent.schemaname || undefined,
        };
      })
      .filter(Boolean);
    const tablespace =
      stmt.tablespacename && stmt.tablespacename !== "pg_default"
        ? stmt.tablespacename
        : undefined;

    const columns = extractColumns(stmt.tableElts || []);

    const constraints = extractAllConstraints(stmt.tableElts || [], tableName);

    return {
      name: tableName,
      schema,
      columns,
      unlogged,
      storageParameters,
      accessMethod,
      inherits: inherits.length > 0 ? inherits : undefined,
      tablespace,
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
      exclusionConstraints:
        constraints.exclusionConstraints.length > 0
          ? constraints.exclusionConstraints
          : undefined,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE TABLE: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
