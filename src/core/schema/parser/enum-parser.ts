/**
 * ENUM Type Parser
 *
 * Handles parsing of PostgreSQL ENUM types from CST.
 */

import { Logger } from "../../../utils/logger";
import { extractStringValueFromCST, extractNameAndSchema } from "./cst-utils";
import type { EnumType } from "../../../types/schema";

/**
 * Parse CREATE TYPE (ENUM) statement from CST
 */
export function parseCreateType(node: any): EnumType | null {
  try {
    // Extract type name and schema
    let fullName: string | null = null;
    let schema: string | undefined;
    let typeName: string | null = null;

    // Handle member_expr (schema.typename)
    if (node.name?.type === 'member_expr') {
      schema = node.name.object?.text || node.name.object?.name || undefined;
      typeName = node.name.property?.text || node.name.property?.name || null;
    } else {
      // Handle simple identifier or fallback
      fullName = node.name?.text || node.name?.name || null;
      const result = extractNameAndSchema(fullName);
      typeName = result.name;
      schema = result.schema;
    }

    if (!typeName) return null;

    // Check if this is an ENUM type
    if (!isEnumType(node)) {
      // For now, we only support ENUM types
      Logger.warning(
        `Unsupported type definition: ${typeName}. Only ENUM types are currently supported.`
      );
      return null;
    }

    // Extract ENUM values
    const enumValues = extractEnumValues(node);
    if (enumValues.length === 0) {
      throw new Error(
        `Invalid ENUM type '${typeName}': ENUM types must have at least one value. ` +
          `Empty ENUM types are not allowed in PostgreSQL.`
      );
    }

    return {
      name: typeName,
      schema,
      values: enumValues,
    };
  } catch (error) {
    // If it's a validation error (e.g., empty ENUM), propagate it
    if (error instanceof Error && error.message.includes("Invalid ENUM type")) {
      throw error;
    }

    // For other parsing errors, log and return null
    Logger.warning(
      `Failed to parse CREATE TYPE from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Extract type name from CST node
 */
function extractTypeName(node: any): string | null {
  try {
    return node.name?.text || node.name?.name || null;
  } catch (error) {
    return null;
  }
}

/**
 * Check if the CST node represents an ENUM type
 */
function isEnumType(node: any): boolean {
  try {
    // Check if the node has an enum_type_definition
    return node.definition?.type === "enum_type_definition";
  } catch (error) {
    return false;
  }
}

/**
 * Extract ENUM values from CST node
 */
function extractEnumValues(node: any): string[] {
  const values: string[] = [];

  try {
    // ENUM values are in node.definition.values.expr.items
    const enumItems = node.definition?.values?.expr?.items || [];

    for (const valueNode of enumItems) {
      const value = extractStringValueFromCST(valueNode);
      if (value) {
        values.push(value);
      }
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract ENUM values: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return values;
}
