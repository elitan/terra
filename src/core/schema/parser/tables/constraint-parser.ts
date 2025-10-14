/**
 * Constraint Parser
 *
 * Handles parsing of table constraints from CST:
 * - PRIMARY KEY (column-level and table-level)
 * - FOREIGN KEY
 * - CHECK
 * - UNIQUE
 */

import { Logger } from "../../../../utils/logger";
import { serializeExpression } from "../expressions";
import type {
  PrimaryKeyConstraint,
  ForeignKeyConstraint,
  CheckConstraint,
  UniqueConstraint,
} from "../../../../types/schema";

/**
 * Extract all constraints from a CREATE TABLE CST node
 */
export function extractAllConstraints(
  node: any,
  tableName: string
): {
  primaryKey?: PrimaryKeyConstraint;
  foreignKeys: ForeignKeyConstraint[];
  checkConstraints: CheckConstraint[];
  uniqueConstraints: UniqueConstraint[];
} {
  const foreignKeys: ForeignKeyConstraint[] = [];
  const checkConstraints: CheckConstraint[] = [];
  const uniqueConstraints: UniqueConstraint[] = [];
  const columnPrimaryKeys: string[] = [];
  let tableLevelPrimaryKey: PrimaryKeyConstraint | undefined;

  try {
    const columnItems = node.columns?.expr?.items || [];

    for (const item of columnItems) {
      if (item.type === "column_definition") {
        // Extract column-level constraints
        extractColumnConstraints(
          item,
          columnPrimaryKeys,
          checkConstraints,
          uniqueConstraints
        );
      } else if (item.type === "constraint") {
        // Extract named table-level constraints
        const pk = extractNamedConstraint(
          item,
          tableLevelPrimaryKey,
          foreignKeys,
          checkConstraints,
          uniqueConstraints
        );
        if (pk) tableLevelPrimaryKey = pk;
      } else if (item.type === "constraint_primary_key") {
        // Extract direct table-level primary key
        tableLevelPrimaryKey = parseTablePrimaryKey(item) || undefined;
      } else if (item.type === "constraint_foreign_key") {
        // Extract direct table-level foreign key
        const fk = parseForeignKey(item);
        if (fk) foreignKeys.push(fk);
      } else if (item.type === "constraint_check") {
        // Extract direct table-level check constraint
        const check = parseCheckConstraint(item);
        if (check) checkConstraints.push(check);
      } else if (item.type === "constraint_unique") {
        // Extract direct table-level unique constraint
        const unique = parseUniqueConstraint(item);
        if (unique) uniqueConstraints.push(unique);
      }
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract constraints: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Build final primary key constraint
  const primaryKey = buildPrimaryKey(
    columnPrimaryKeys,
    tableLevelPrimaryKey || null,
    tableName
  );

  return {
    primaryKey,
    foreignKeys,
    checkConstraints,
    uniqueConstraints,
  };
}

/**
 * Extract column-level constraints
 */
function extractColumnConstraints(
  columnNode: any,
  columnPrimaryKeys: string[],
  checkConstraints: CheckConstraint[],
  uniqueConstraints: UniqueConstraint[]
): void {
  const columnName = columnNode.name?.text || columnNode.name?.name;
  if (!columnName) return;

  try {
    if (columnNode.constraints && Array.isArray(columnNode.constraints)) {
      for (const constraint of columnNode.constraints) {
        if (constraint.type === "constraint_primary_key") {
          columnPrimaryKeys.push(columnName);
        } else if (constraint.type === "constraint_check") {
          const check = parseColumnCheckConstraint(constraint, columnName);
          if (check) checkConstraints.push(check);
        } else if (constraint.type === "constraint_unique") {
          const unique = parseColumnUniqueConstraint(constraint, columnName);
          if (unique) uniqueConstraints.push(unique);
        }
      }
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract column constraints for ${columnName}`
    );
  }
}

/**
 * Extract named table-level constraints
 */
function extractNamedConstraint(
  item: any,
  tableLevelPrimaryKey: PrimaryKeyConstraint | undefined,
  foreignKeys: ForeignKeyConstraint[],
  checkConstraints: CheckConstraint[],
  uniqueConstraints: UniqueConstraint[]
): PrimaryKeyConstraint | undefined {
  const constraintName = item.name?.name?.text || item.name?.name?.name;
  const constraint = item.constraint;

  if (!constraint) return tableLevelPrimaryKey;

  try {
    if (constraint.type === "constraint_primary_key") {
      const pk = parseTablePrimaryKey(constraint);
      if (pk) {
        pk.name = constraintName;
        return pk; // Return the primary key to be assigned
      }
    } else if (constraint.type === "constraint_foreign_key") {
      const fk = parseForeignKey(constraint);
      if (fk) {
        fk.name = constraintName;
        foreignKeys.push(fk);
      }
    } else if (constraint.type === "constraint_check") {
      const check = parseCheckConstraint(constraint);
      if (check) {
        check.name = constraintName;
        checkConstraints.push(check);
      }
    } else if (constraint.type === "constraint_unique") {
      const unique = parseUniqueConstraint(constraint);
      if (unique) {
        unique.name = constraintName;
        uniqueConstraints.push(unique);
      }
    }
  } catch (error) {
    Logger.warning(`Failed to extract named constraint ${constraintName}`);
  }

  return tableLevelPrimaryKey;
}

/**
 * Parse CHECK constraint from CST
 */
export function parseCheckConstraint(node: any): CheckConstraint | null {
  try {
    // Extract constraint name if present
    let constraintName: string | undefined;
    if (node.name) {
      constraintName = node.name.text || node.name.name;
    }

    // Extract the check expression
    // The expression might be wrapped in parentheses, so handle paren_expr
    let exprNode = node.expr;
    if (exprNode?.type === "paren_expr" && exprNode.expr) {
      exprNode = exprNode.expr;
    }

    const expression = serializeExpression(exprNode);
    if (!expression || expression === "unknown_expression") {
      return null;
    }

    return {
      name: constraintName,
      expression,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse check constraint: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Parse column-level CHECK constraint
 */
function parseColumnCheckConstraint(
  node: any,
  columnName: string
): CheckConstraint | null {
  try {
    // Column-level check constraints usually don't have explicit names
    // We'll generate a name based on the column
    const constraintName = `${columnName}_check`;

    // Extract the check expression
    let exprNode = node.expr;
    if (exprNode?.type === "paren_expr" && exprNode.expr) {
      exprNode = exprNode.expr;
    }

    const expression = serializeExpression(exprNode);
    if (!expression || expression === "unknown_expression") {
      return null;
    }

    return {
      name: constraintName,
      expression,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse column-level check constraint: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Parse FOREIGN KEY constraint from CST
 */
export function parseForeignKey(node: any): ForeignKeyConstraint | null {
  try {
    // Extract constraint name if present
    let constraintName: string | undefined;
    if (node.name) {
      constraintName = node.name.text || node.name.name;
    }

    // Extract column list from the columns property
    const columns: string[] = [];
    const columnList = node.columns;

    if (columnList?.expr?.items) {
      for (const col of columnList.expr.items) {
        let colName: string | undefined;
        if (col.type === "index_specification" && col.expr) {
          colName = col.expr.text || col.expr.name;
        } else {
          colName = col.text || col.name?.text || col.name?.name;
        }

        if (colName) {
          // Strip surrounding quotes from identifiers (e.g., "year" -> year)
          if (colName.startsWith('"') && colName.endsWith('"')) {
            colName = colName.slice(1, -1);
          }
          columns.push(colName);
        }
      }
    }

    // Extract referenced table and columns from references property
    let referencedTable: string | undefined;
    const referencedColumns: string[] = [];

    if (node.references) {
      referencedTable =
        node.references.table?.text || node.references.table?.name;

      if (node.references.columns?.expr?.items) {
        for (const col of node.references.columns.expr.items) {
          let colName: string | undefined;
          if (col.type === "index_specification" && col.expr) {
            colName = col.expr.text || col.expr.name;
          } else {
            colName = col.text || col.name?.text || col.name?.name;
          }

          if (colName) {
            referencedColumns.push(colName);
          }
        }
      }
    }

    if (!referencedTable || columns.length === 0 || referencedColumns.length === 0) {
      return null;
    }

    // Extract ON DELETE and ON UPDATE actions from references.options
    const onDelete = extractReferentialAction(node.references, "DELETE");
    const onUpdate = extractReferentialAction(node.references, "UPDATE");

    return {
      name: constraintName,
      columns,
      referencedTable,
      referencedColumns,
      onDelete,
      onUpdate,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse foreign key constraint: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Extract referential action (CASCADE, RESTRICT, etc.) from references node
 */
function extractReferentialAction(
  references: any,
  actionType: "DELETE" | "UPDATE"
): "CASCADE" | "RESTRICT" | "SET NULL" | "SET DEFAULT" | undefined {
  try {
    // Look for referential actions in the references.options array
    if (!references?.options || !Array.isArray(references.options)) {
      return undefined;
    }

    for (const option of references.options) {
      // Check if this option matches the action type we're looking for
      if (option.type === "referential_action") {
        const eventType = option.eventKw?.name || option.eventKw?.text;
        if (eventType === actionType) {
          const actionName = option.actionKw?.name || option.actionKw?.text;
          return mapActionName(actionName);
        }
      }
    }

    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Map action name string to typed value
 */
function mapActionName(
  actionName: string | undefined
): "CASCADE" | "RESTRICT" | "SET NULL" | "SET DEFAULT" | undefined {
  if (!actionName) return undefined;

  switch (actionName.toUpperCase()) {
    case "CASCADE":
      return "CASCADE";
    case "RESTRICT":
      return "RESTRICT";
    case "SET NULL":
    case "SETNULL":
      return "SET NULL";
    case "SET DEFAULT":
    case "SETDEFAULT":
      return "SET DEFAULT";
    default:
      return undefined;
  }
}

/**
 * Parse UNIQUE constraint from CST
 */
export function parseUniqueConstraint(node: any): UniqueConstraint | null {
  try {
    // Extract constraint name if present
    let constraintName: string | undefined;
    if (node.name) {
      constraintName = node.name.text || node.name.name;
    }

    // Extract column list from the columns property
    const columns: string[] = [];
    const columnList = node.columns;

    if (columnList?.expr?.items) {
      for (const col of columnList.expr.items) {
        let colName: string | undefined;
        if (col.type === "index_specification" && col.expr) {
          colName = col.expr.text || col.expr.name;
        } else {
          colName = col.text || col.name?.text || col.name?.name;
        }

        if (colName) {
          // Strip surrounding quotes from identifiers (e.g., "year" -> year)
          if (colName.startsWith('"') && colName.endsWith('"')) {
            colName = colName.slice(1, -1);
          }
          columns.push(colName);
        }
      }
    }

    if (columns.length === 0) {
      return null;
    }

    // Extract deferrable properties
    let deferrable: boolean | undefined;
    let initiallyDeferred: boolean | undefined;

    // Look for DEFERRABLE and INITIALLY DEFERRED keywords
    if (node.deferrable || node.deferrableKw) {
      deferrable = true;
    }

    if (node.initiallyDeferred || node.initiallyDeferredKw || node.initially) {
      initiallyDeferred = true;
    }

    return {
      name: constraintName,
      columns,
      deferrable,
      initiallyDeferred,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse unique constraint: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Parse column-level UNIQUE constraint
 */
function parseColumnUniqueConstraint(
  node: any,
  columnName: string
): UniqueConstraint | null {
  try {
    // Column-level unique constraints usually don't have explicit names
    // We'll generate a name based on the column
    const constraintName = `${columnName}_unique`;

    return {
      name: constraintName,
      columns: [columnName],
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse column-level unique constraint: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Parse table-level PRIMARY KEY constraint from CST
 */
export function parseTablePrimaryKey(node: any): PrimaryKeyConstraint | null {
  try {
    // Check if this is a primary key constraint
    if (node.type === "constraint_primary_key") {
      // Extract constraint name if present
      let constraintName: string | undefined;
      if (node.name) {
        constraintName = node.name.text || node.name.name;
      }

      // Extract column list from the columns property
      const columns: string[] = [];
      const columnList = node.columns;

      if (columnList?.expr?.items) {
        for (const col of columnList.expr.items) {
          // Handle index_specification type which contains the column reference
          let colName: string | undefined;
          if (col.type === "index_specification" && col.expr) {
            colName = col.expr.text || col.expr.name;
          } else {
            colName = col.text || col.name?.text || col.name?.name;
          }

          if (colName) {
            columns.push(colName);
          }
        }
      }

      if (columns.length > 0) {
        return {
          name: constraintName,
          columns,
        };
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Build final primary key constraint from column-level and table-level definitions
 */
function buildPrimaryKey(
  columnPrimaryKeys: string[],
  tableLevelPrimaryKey: PrimaryKeyConstraint | null,
  tableName: string
): PrimaryKeyConstraint | undefined {
  // Validate that we don't have both column-level and table-level primary keys
  if (columnPrimaryKeys.length > 0 && tableLevelPrimaryKey) {
    Logger.warning(
      `Table ${tableName} has both column-level and table-level primary key definitions. Using table-level definition.`
    );
    return tableLevelPrimaryKey;
  }

  // Return table-level primary key if it exists
  if (tableLevelPrimaryKey) {
    return tableLevelPrimaryKey;
  }

  // Convert column-level primary keys to table-level representation
  if (columnPrimaryKeys.length > 0) {
    return {
      columns: columnPrimaryKeys,
    };
  }

  // No primary key found
  return undefined;
}
