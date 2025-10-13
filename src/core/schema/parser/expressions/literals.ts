/**
 * Expression Literals Serialization
 *
 * Handles serialization of literal values from CST:
 * - Numbers (integers, decimals)
 * - Strings (with quotes)
 * - Booleans (true/false)
 * - NULL values
 * - Keywords (CURRENT_DATE, etc.)
 */

import { Logger } from "../../../../utils/logger";

/**
 * Serialize number literal from CST
 */
export function serializeNumberLiteral(expr: any): string {
  return String(expr.value !== undefined ? expr.value : expr.text);
}

/**
 * Serialize string literal from CST (preserves quotes)
 */
export function serializeStringLiteral(expr: any): string {
  return expr.text || `'${expr.value}'`;
}

/**
 * Serialize boolean literal from CST
 */
export function serializeBooleanLiteral(expr: any): string {
  return String(expr.value || expr.valueKw?.text || expr.text);
}

/**
 * Serialize NULL literal from CST
 */
export function serializeNullLiteral(): string {
  return "NULL";
}

/**
 * Serialize keyword from CST (e.g., CURRENT_DATE, CURRENT_TIMESTAMP)
 */
export function serializeKeyword(expr: any): string {
  return expr.text || expr.name || String(expr.value);
}

/**
 * Serialize INTERVAL expression from CST
 */
export function serializeIntervalExpr(expr: any): string {
  if (expr.type === "interval_literal") {
    // Handle interval_literal structure: INTERVAL 'value'
    const value = expr.string?.text || expr.string?.value || "'1 day'";
    return `INTERVAL ${value}`;
  } else {
    // Handle interval_expr structure: INTERVAL value unit
    const value = expr.value?.text || expr.expr?.text || "'1 day'";
    const unit = expr.unit?.text || expr.unit?.name || "DAY";
    return `INTERVAL ${value} ${unit}`;
  }
}

/**
 * Serialize default value from CST (used in column definitions)
 */
export function serializeDefaultValue(expr: any): string {
  try {
    if (expr.type === "number_literal") {
      return serializeNumberLiteral(expr);
    } else if (expr.type === "string_literal") {
      return serializeStringLiteral(expr);
    } else if (expr.type === "boolean_literal") {
      return serializeBooleanLiteral(expr);
    } else if (expr.type === "null_literal") {
      return serializeNullLiteral();
    } else if (expr.type === "keyword") {
      return serializeKeyword(expr);
    } else if (expr.type === "function_call" || expr.type === "func_call") {
      const funcName = expr.name?.text || expr.name?.name || expr.name;
      if (funcName) {
        // Special cases for PostgreSQL keywords that look like functions but aren't
        const keywordFunctions = [
          "CURRENT_DATE",
          "CURRENT_TIME",
          "CURRENT_TIMESTAMP",
          "LOCALTIME",
          "LOCALTIMESTAMP",
        ];
        if (keywordFunctions.includes(funcName.toUpperCase()) && !expr.args) {
          return funcName;
        }
        return `${funcName}()`;
      }
      if (expr.text) {
        return expr.text;
      }
    } else if (expr.type === "prefix_op_expr") {
      // Handle negative numbers and other prefix operations
      const operator = expr.operator || "";
      // Recursive call would need the full serializer, so we'll keep it simple
      const operand = expr.expr?.text || expr.expr?.value || "";
      return `${operator}${operand}`;
    } else if (expr.type === "cast_operator_expr" || expr.type === "cast_expr") {
      // Handle cast expressions like '{}'::jsonb
      const left = expr.left?.text || expr.expr?.text || "''";
      const right =
        expr.right?.name?.text ||
        expr.right?.name?.name ||
        expr.type_name?.name?.text ||
        "unknown_type";
      return `${left}::${right}`;
    } else if (expr.type === "named_data_type") {
      // Handle named data types in cast expressions
      return expr.name?.text || expr.name?.name || "unknown_type";
    } else if (expr.text) {
      return expr.text;
    }

    if (typeof expr === "string") {
      return expr;
    }

    Logger.warning(`Unable to serialize default value: ${JSON.stringify(expr)}`);
    return "NULL";
  } catch (error) {
    Logger.warning(
      `Error serializing default value: ${error instanceof Error ? error.message : String(error)}`
    );
    return "NULL";
  }
}
