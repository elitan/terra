/**
 * Expression Serializer
 *
 * Main entry point for serializing expressions from CST to SQL strings.
 * Coordinates the various expression type serializers.
 */

import { Logger } from "../../../../utils/logger";
import {
  serializeNumberLiteral,
  serializeStringLiteral,
  serializeBooleanLiteral,
  serializeNullLiteral,
  serializeKeyword,
  serializeIntervalExpr,
  serializeDefaultValue,
} from "./literals";
import {
  serializeBinaryExpr,
  serializeUnaryExpr,
  serializeCastExpr,
  serializeBetweenExpr,
  serializeInExpr,
  serializeIsExpr,
  serializeMatchExpr,
  serializePostgresOperatorExpr,
  serializeSubscriptExpr,
  serializeParenExpr,
} from "./operators";
import {
  serializeFunctionCall,
  serializeCaseExpr,
  serializeListExpr,
} from "./functions";

/**
 * Serialize any expression from CST to SQL string
 */
export function serializeExpression(expr: any): string {
  try {
    // Handle different expression types
    if (typeof expr === "string") {
      return expr;
    }

    // Direct text property
    if (expr.text) {
      return expr.text;
    }

    // Binary expressions (comparison, logical operators, etc.)
    if (expr.type === "binary_expr" || expr.type === "binary_op_expr") {
      return serializeBinaryExpr(expr, serializeExpression);
    }

    // Column references
    if (expr.type === "identifier" || expr.type === "column_ref") {
      return expr.name || expr.text || expr.column || "unknown_column";
    }

    // Literals
    if (expr.type === "number_literal") {
      return serializeNumberLiteral(expr);
    }

    if (expr.type === "string_literal") {
      return serializeStringLiteral(expr);
    }

    if (expr.type === "boolean_literal") {
      return serializeBooleanLiteral(expr);
    }

    // NULL values
    if (expr.type === "null_literal") {
      return serializeNullLiteral();
    }

    // Function calls (handle both "function_call" and "func_call" types)
    if (expr.type === "function_call" || expr.type === "func_call") {
      return serializeFunctionCall(expr, serializeExpression);
    }

    // Parenthesized expressions (handle both "parenthesized_expr" and "paren_expr")
    if (
      (expr.type === "parenthesized_expr" || expr.type === "paren_expr") &&
      expr.expr
    ) {
      return serializeParenExpr(expr, serializeExpression);
    }

    // Unary expressions (e.g., NOT)
    if (expr.type === "unary_op_expr" || expr.type === "prefix_op_expr") {
      return serializeUnaryExpr(expr, serializeExpression);
    }

    // INTERVAL expressions
    if (expr.type === "interval_expr" || expr.type === "interval_literal") {
      return serializeIntervalExpr(expr);
    }

    // Keywords (CURRENT_DATE, CURRENT_TIMESTAMP, etc.)
    if (expr.type === "keyword") {
      return serializeKeyword(expr);
    }

    // BETWEEN expressions
    if (expr.type === "between_expr") {
      return serializeBetweenExpr(expr, serializeExpression);
    }

    // IN expressions
    if (expr.type === "in_expr") {
      return serializeInExpr(expr, serializeExpression);
    }

    // IS NULL / IS NOT NULL expressions
    if (expr.type === "is_expr") {
      return serializeIsExpr(expr, serializeExpression);
    }

    // Regular expressions (~, ~*, !~, !~*)
    if (expr.type === "match_expr") {
      return serializeMatchExpr(expr, serializeExpression);
    }

    // Cast expressions (e.g., '{}' :: jsonb, value::type)
    if (expr.type === "cast_operator_expr" || expr.type === "cast_expr") {
      return serializeCastExpr(expr, serializeExpression);
    }

    // Named data types (for cast expressions)
    if (expr.type === "named_data_type") {
      return expr.name?.text || expr.name?.name || "unknown_type";
    }

    // JSON/JSONB operators (?, ?&, ?|, ->, ->>, #>, #>>, @>, <@, etc.)
    if (expr.type === "json_expr" || expr.type === "jsonb_expr") {
      return serializePostgresOperatorExpr(expr, serializeExpression);
    }

    // PostgreSQL-specific operators (including JSON operators)
    if (expr.type === "pg_operator_expr" || expr.type === "postfix_op_expr") {
      return serializePostgresOperatorExpr(expr, serializeExpression);
    }

    // Array/subscript expressions [index] and JSON path access
    if (expr.type === "subscript_expr" || expr.type === "array_subscript") {
      return serializeSubscriptExpr(expr, serializeExpression);
    }

    // List expressions (for IN clauses, function arguments, etc.)
    if (expr.type === "list_expr") {
      return serializeListExpr(expr, serializeExpression);
    }

    // CASE expressions
    if (expr.type === "case_expr") {
      return serializeCaseExpr(expr, serializeExpression);
    }

    // Fallback: try to extract any available text
    if (expr.value !== undefined) {
      return String(expr.value);
    }

    // Log what we're missing for debugging
    Logger.warning(
      `Unhandled expression type: ${expr.type || "undefined"}, structure: ${JSON.stringify(expr, null, 2)}`
    );

    // Final fallback
    return "unknown_expression";
  } catch (error) {
    Logger.warning(
      `Failed to serialize expression: ${error instanceof Error ? error.message : String(error)}`
    );
    return "unknown_expression";
  }
}

// Re-export serializeDefaultValue for convenience
export { serializeDefaultValue };
