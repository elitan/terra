/**
 * Expression Operators Serialization
 *
 * Handles serialization of operator expressions from CST:
 * - Binary operators (=, <, >, AND, OR, etc.)
 * - Unary operators (NOT, -, +)
 * - Cast operators (::)
 * - BETWEEN expressions
 * - IN expressions
 * - IS NULL / IS NOT NULL
 * - Regular expression operators (~, ~*, etc.)
 * - PostgreSQL-specific operators (JSON operators, etc.)
 */

/**
 * Serialize binary expression from CST
 * Requires recursive serialization function from parent
 */
export function serializeBinaryExpr(expr: any, serializeExpr: (e: any) => string): string {
  const left = serializeExpr(expr.left);

  // Extract operator - it might be a string or an object with text/name
  let operator = "=";
  if (typeof expr.operator === "string") {
    operator = expr.operator;
  } else if (expr.operator?.text) {
    operator = expr.operator.text;
  } else if (expr.operator?.name) {
    operator = expr.operator.name;
  }

  const right = serializeExpr(expr.right);
  return `${left} ${operator} ${right}`;
}

/**
 * Serialize unary/prefix operator expression from CST
 */
export function serializeUnaryExpr(expr: any, serializeExpr: (e: any) => string): string {
  const operator = expr.operator?.text || expr.operator?.name || expr.operator || "";
  const operand = serializeExpr(expr.operand || expr.expr);
  return `${operator} ${operand}`;
}

/**
 * Serialize cast expression from CST (e.g., value::type)
 */
export function serializeCastExpr(expr: any, serializeExpr: (e: any) => string): string {
  const left = serializeExpr(expr.left || expr.expr);
  const right = serializeExpr(
    expr.right || expr.type_name || expr.dataType
  );
  return `${left}::${right}`;
}

/**
 * Serialize BETWEEN expression from CST
 */
export function serializeBetweenExpr(expr: any, serializeExpr: (e: any) => string): string {
  const value = serializeExpr(expr.left || expr.expr);
  const low = serializeExpr(expr.begin || expr.low);
  const high = serializeExpr(expr.end || expr.high);
  return `${value} BETWEEN ${low} AND ${high}`;
}

/**
 * Serialize IN expression from CST
 */
export function serializeInExpr(expr: any, serializeExpr: (e: any) => string): string {
  const value = serializeExpr(expr.expr);
  const list = expr.list?.expr?.items || [];
  const items = list.map((item: any) => serializeExpr(item)).join(", ");
  return `${value} IN (${items})`;
}

/**
 * Serialize IS NULL / IS NOT NULL expression from CST
 */
export function serializeIsExpr(expr: any, serializeExpr: (e: any) => string): string {
  const value = serializeExpr(expr.expr);
  const operator = expr.not ? "IS NOT" : "IS";
  const test = expr.test?.text || "NULL";
  return `${value} ${operator} ${test}`;
}

/**
 * Serialize regular expression match from CST (~, ~*, !~, !~*)
 */
export function serializeMatchExpr(expr: any, serializeExpr: (e: any) => string): string {
  const left = serializeExpr(expr.left);
  const operator = expr.operator?.text || "~";
  const right = serializeExpr(expr.right);
  return `${left} ${operator} ${right}`;
}

/**
 * Serialize PostgreSQL-specific operators (including JSON)
 */
export function serializePostgresOperatorExpr(expr: any, serializeExpr: (e: any) => string): string {
  const left = serializeExpr(expr.left || expr.expr);
  const operator = expr.operator?.text || expr.operator?.name || "?";

  // Handle binary operators
  if (expr.right) {
    const right = serializeExpr(expr.right);
    return `${left} ${operator} ${right}`;
  }

  // Handle postfix operators
  return `${left}${operator}`;
}

/**
 * Serialize array subscript / JSON path access
 */
export function serializeSubscriptExpr(expr: any, serializeExpr: (e: any) => string): string {
  const array = serializeExpr(expr.expr || expr.left);
  const index = serializeExpr(expr.index || expr.right);
  return `${array}[${index}]`;
}

/**
 * Serialize parenthesized expression from CST
 */
export function serializeParenExpr(expr: any, serializeExpr: (e: any) => string): string {
  return `(${serializeExpr(expr.expr)})`;
}
