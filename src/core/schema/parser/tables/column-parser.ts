/**
 * Column Parser
 *
 * Handles parsing of table columns from CST.
 */

import { Logger } from "../../../../utils/logger";
import { serializeDefaultValue } from "../expressions";
import type { Column } from "../../../../types/schema";

/**
 * Extract all columns from a CREATE TABLE CST node
 */
export function extractColumns(node: any): Column[] {
  const columns: Column[] = [];

  try {
    // Based on CST structure: node.columns.expr.items contains column_definition objects
    const columnItems = node.columns?.expr?.items || [];

    for (const columnNode of columnItems) {
      if (columnNode.type === "column_definition") {
        const column = parseColumn(columnNode);
        if (column) {
          columns.push(column);
        }
      }
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract columns: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return columns;
}

/**
 * Parse a single column definition from CST
 */
export function parseColumn(node: any): Column | null {
  try {
    // Extract column name from the node
    let name = node.name?.text || node.name?.name;
    if (!name) return null;

    // Strip surrounding quotes from identifiers (e.g., "year" -> year)
    if (name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1);
    }

    // Extract data type
    const type = extractDataType(node);

    // Extract basic constraints (just for column properties)
    const constraints = extractBasicConstraints(node);

    // Extract default value
    const defaultValue = extractDefaultValue(node);

    return {
      name,
      type,
      nullable: !constraints.notNull && !constraints.primary,
      default: defaultValue,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse column from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Extract data type from column CST node
 */
function extractDataType(node: any): string {
  try {
    // Extract data type from dataType property
    const dataType = node.dataType;
    if (!dataType) return "UNKNOWN";

    // Get the type name
    let type = dataType.name?.text || dataType.name?.name || "UNKNOWN";
    type = type.toUpperCase();

    // Handle type parameters (e.g., VARCHAR(255), DECIMAL(10,2))
    if (dataType.params?.expr?.items) {
      const params = dataType.params.expr.items
        .map((item: any) => {
          // Handle string literals (including PostGIS types preprocessed as strings)
          if (item.type === 'string_literal') {
            return item.value;
          }
          return item.text || item.value;
        })
        .join(",");
      type += `(${params})`;
    }

    return type;
  } catch (error) {
    return "UNKNOWN";
  }
}

/**
 * Extract basic column-level constraints (NOT NULL, PRIMARY KEY)
 * Note: This only extracts constraints that affect column properties,
 * not constraints that need to be stored separately
 */
function extractBasicConstraints(node: any): {
  notNull: boolean;
  primary: boolean;
} {
  let notNull = false;
  let primary = false;

  try {
    if (node.constraints && Array.isArray(node.constraints)) {
      for (const constraint of node.constraints) {
        if (constraint.type === "constraint_not_null") {
          notNull = true;
        } else if (constraint.type === "constraint_primary_key") {
          primary = true;
        }
      }
    }
  } catch (error) {
    // Ignore extraction errors
  }

  return { notNull, primary };
}

/**
 * Extract default value from column CST node
 */
function extractDefaultValue(node: any): string | undefined {
  try {
    if (node.constraints && Array.isArray(node.constraints)) {
      for (const constraint of node.constraints) {
        if (constraint.type === "constraint_default" && constraint.expr) {
          return serializeDefaultValue(constraint.expr);
        }
      }
    }
  } catch (error) {
    // Ignore extraction errors
  }

  return undefined;
}
