/**
 * INDEX Parser
 *
 * Handles parsing of PostgreSQL CREATE INDEX statements from CST.
 * Supports: basic indexes, unique indexes, partial indexes, expression indexes,
 * concurrent indexes, storage parameters, and various index types (btree, gin, gist, etc.)
 */

import { Logger } from "../../../utils/logger";
import { serializeExpression } from "./expressions";
import type { Index } from "../../../types/schema";

/**
 * Parse CREATE INDEX statement from CST
 */
export function parseCreateIndex(node: any): Index | null {
  try {
    // Extract index name
    const indexName = extractIndexName(node);
    if (!indexName) return null;

    // Extract table name and schema
    const tableName = extractIndexTableName(node);
    if (!tableName) return null;

    const schema = extractIndexSchema(node);

    // Extract columns and detect expressions
    const indexColumnInfo = extractIndexColumnsAndExpressions(node);
    if (indexColumnInfo.columns.length === 0 && !indexColumnInfo.expression) {
      return null;
    }

    // Extract index type (default is btree)
    const indexType = extractIndexType(node);

    // Extract unique flag
    const unique = extractIndexUnique(node);

    // Extract concurrent flag
    const concurrent = extractIndexConcurrent(node);

    // Extract WHERE clause for partial indexes
    const whereClause = extractIndexWhereClause(node);

    // Extract storage parameters
    const storageParameters = extractIndexStorageParameters(node);

    // Extract tablespace
    const tablespace = extractIndexTablespace(node);

    return {
      name: indexName,
      tableName,
      schema,
      columns: indexColumnInfo.columns,
      type: indexType,
      unique,
      concurrent,
      where: whereClause,
      expression: indexColumnInfo.expression,
      storageParameters:
        storageParameters && Object.keys(storageParameters).length > 0
          ? storageParameters
          : undefined,
      tablespace,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE INDEX from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Extract index name from CST
 */
function extractIndexName(node: any): string | null {
  try {
    return node.name?.text || node.name?.name || null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract table name from CST (without schema qualifier)
 */
function extractIndexTableName(node: any): string | null {
  try {
    const fullName = node.table?.text || node.table?.name || null;
    if (!fullName) return null;

    // If qualified (schema.table), extract only the table name
    if (fullName.includes('.')) {
      const parts = fullName.split('.');
      return parts[parts.length - 1];
    }

    return fullName;
  } catch (error) {
    return null;
  }
}

/**
 * Extract schema name from CST (for qualified table names)
 */
function extractIndexSchema(node: any): string | undefined {
  try {
    const fullName = node.table?.text || node.table?.name || null;
    if (!fullName) return undefined;

    // If qualified (schema.table), extract the schema
    if (fullName.includes('.')) {
      const parts = fullName.split('.');
      if (parts.length === 2) {
        return parts[0];
      }
    }

    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract columns and detect if this is an expression index
 */
function extractIndexColumnsAndExpressions(node: any): {
  columns: string[];
  expression?: string;
} {
  const columns: string[] = [];
  let expression: string | undefined;

  try {
    // Index columns are typically in node.columns.expr.items
    const columnItems = node.columns?.expr?.items || [];

    // Check if we have exactly one item and it's an expression (not just a simple column)
    if (columnItems.length === 1) {
      const singleItem = columnItems[0];

      // Check if this looks like an expression (function call, complex expression, etc.)
      if (isIndexExpression(singleItem)) {
        expression = serializeExpression(singleItem.expr || singleItem);
        return { columns: [], expression };
      }
    }

    // Handle regular column names or multiple columns
    for (const columnNode of columnItems) {
      let columnName: string | undefined;

      // Handle different CST structures for index columns
      if (columnNode.type === "index_specification" && columnNode.expr) {
        // Check if expr is a simple identifier (column name) vs expression
        if (
          columnNode.expr.type === "identifier" ||
          columnNode.expr.type === "column_ref"
        ) {
          columnName = columnNode.expr.text || columnNode.expr.name;
        } else {
          // This is an expression, not a simple column
          Logger.info(
            "Found expression in multi-column context, treating as complex expression"
          );
          expression = serializeExpression(columnNode.expr);
          return { columns: [], expression };
        }
      } else {
        columnName =
          columnNode.text || columnNode.name?.text || columnNode.name?.name;
      }

      if (columnName) {
        columns.push(columnName);
      }
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract index columns: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return { columns, expression };
}

/**
 * Check if a CST node represents an expression rather than a simple column
 */
function isIndexExpression(node: any): boolean {
  // Function calls are definitely expressions
  if (
    node.type === "function_call" ||
    node.expr?.type === "function_call" ||
    node.type === "func_call" ||
    node.expr?.type === "func_call"
  ) {
    return true;
  }

  // Parenthesized expressions
  if (
    node.type === "parenthesized_expr" ||
    node.expr?.type === "parenthesized_expr"
  ) {
    return true;
  }

  // Binary operations
  if (node.type === "binary_expr" || node.expr?.type === "binary_expr") {
    return true;
  }

  // Type casts
  if (node.type === "cast_expr" || node.expr?.type === "cast_expr") {
    return true;
  }

  // Case expressions
  if (node.type === "case_expr" || node.expr?.type === "case_expr") {
    return true;
  }

  // For index_specification nodes, check the inner expr
  if (node.type === "index_specification" && node.expr) {
    return isIndexExpression(node.expr);
  }

  return false;
}

/**
 * Extract index type from CST
 */
function extractIndexType(node: any): Index["type"] {
  try {
    // Look for USING clause to determine index type
    const method = node.using?.method?.text || node.using?.method?.name;

    if (method) {
      const type = method.toLowerCase();
      if (["btree", "hash", "gist", "spgist", "gin", "brin"].includes(type)) {
        return type as Index["type"];
      }
    }

    // Default to btree if no USING clause specified
    return "btree";
  } catch (error) {
    return "btree";
  }
}

/**
 * Extract UNIQUE flag from CST
 */
function extractIndexUnique(node: any): boolean {
  try {
    // Check if the index has UNIQUE keyword (stored in indexTypeKw)
    return node.indexTypeKw?.name === "UNIQUE" || false;
  } catch (error) {
    return false;
  }
}

/**
 * Extract CONCURRENTLY flag from CST
 */
function extractIndexConcurrent(node: any): boolean {
  try {
    // Check if the index has CONCURRENTLY keyword
    return node.concurrentlyKw?.name === "CONCURRENTLY" || false;
  } catch (error) {
    return false;
  }
}

/**
 * Extract WHERE clause for partial indexes
 */
function extractIndexWhereClause(node: any): string | undefined {
  try {
    // Look for WHERE clause in the clauses array
    if (node.clauses && Array.isArray(node.clauses)) {
      for (const clause of node.clauses) {
        if (clause.type === "where_clause" && clause.expr) {
          // Serialize the WHERE expression back to SQL string
          return serializeExpression(clause.expr);
        }
      }
    }
    return undefined;
  } catch (error) {
    Logger.warning(
      `Failed to extract WHERE clause: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/**
 * Extract storage parameters from WITH clause
 */
function extractIndexStorageParameters(
  node: any
): Record<string, string> | undefined {
  try {
    const parameters: Record<string, string> = {};

    // Look for WITH clause in the clauses array
    if (node.clauses && Array.isArray(node.clauses)) {
      for (const clause of node.clauses) {
        if (
          clause.type === "postgresql_with_options" &&
          clause.options?.expr?.items
        ) {
          // Extract storage parameters from the WITH clause
          for (const option of clause.options.expr.items) {
            if (option.type === "table_option") {
              // Extract parameter name and value
              const key = option.name?.text || option.name?.name;
              let value: string | undefined;

              if (option.value) {
                if (option.value.text) {
                  value = option.value.text;
                } else if (option.value.valueKw?.text) {
                  value = option.value.valueKw.text;
                } else {
                  value = serializeExpression(option.value);
                }
              }

              if (key && value !== undefined) {
                parameters[key] = value;
              }
            }
          }
        }
      }
    }

    return Object.keys(parameters).length > 0 ? parameters : undefined;
  } catch (error) {
    Logger.warning(
      `Failed to extract storage parameters: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/**
 * Extract TABLESPACE clause
 */
function extractIndexTablespace(node: any): string | undefined {
  try {
    // Look for TABLESPACE clause in the clauses array
    if (node.clauses && Array.isArray(node.clauses)) {
      for (const clause of node.clauses) {
        if (clause.type === "tablespace_clause") {
          // Extract tablespace name
          return (
            clause.name?.text ||
            clause.name?.name ||
            clause.tablespace?.text ||
            clause.tablespace?.name
          );
        }
      }
    }
    return undefined;
  } catch (error) {
    Logger.warning(
      `Failed to extract tablespace: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}
