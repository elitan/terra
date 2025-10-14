/**
 * Expression Functions Serialization
 *
 * Handles serialization of function calls and complex expressions:
 * - Function calls (NOW(), LOWER(), etc.)
 * - CASE expressions
 * - List expressions
 */

/**
 * Serialize function call from CST
 */
export function serializeFunctionCall(expr: any, serializeExpr: (e: any) => string): string {
  const funcName = expr.name?.text || expr.name?.name || "unknown_func";

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

  // Handle function arguments
  let args = "";

  // PostgreSQL CST structure: args.expr.args.items
  if (expr.args?.expr?.args?.items) {
    const argStrings = expr.args.expr.args.items.map((arg: any) => serializeExpr(arg));
    args = argStrings.join(", ");
  }
  // Alternative structure: args.expr.items
  else if (expr.args?.expr?.items) {
    const argStrings = expr.args.expr.items.map((arg: any) => serializeExpr(arg));
    args = argStrings.join(", ");
  }
  // Simple array structure
  else if (expr.args && Array.isArray(expr.args)) {
    const argStrings = expr.args.map((arg: any) => serializeExpr(arg));
    args = argStrings.join(", ");
  }

  return `${funcName}(${args})`;
}

/**
 * Serialize CASE expression from CST
 */
export function serializeCaseExpr(expr: any, serializeExpr: (e: any) => string): string {
  let result = "CASE";

  // Handle CASE expr WHEN ... (simple case)
  if (expr.expr) {
    result += ` ${serializeExpr(expr.expr)}`;
  }

  // Handle clauses (when/else)
  if (expr.clauses && Array.isArray(expr.clauses)) {
    for (const clause of expr.clauses) {
      if (clause.type === "case_when") {
        const condition = serializeExpr(clause.condition);
        const clauseResult = serializeExpr(clause.result);
        result += ` WHEN ${condition} THEN ${clauseResult}`;
      } else if (clause.type === "case_else") {
        result += ` ELSE ${serializeExpr(clause.result)}`;
      }
    }
  }
  // Legacy support for whenList structure
  else if (expr.whenList && Array.isArray(expr.whenList)) {
    for (const whenClause of expr.whenList) {
      const when = serializeExpr(whenClause.when);
      const then = serializeExpr(whenClause.then);
      result += ` WHEN ${when} THEN ${then}`;
    }
  }

  // Legacy support for else property
  if (expr.else) {
    result += ` ELSE ${serializeExpr(expr.else)}`;
  }

  result += " END";
  return result;
}

/**
 * Serialize list expression from CST (for IN clauses, function args, etc.)
 */
export function serializeListExpr(expr: any, serializeExpr: (e: any) => string): string {
  const items = expr.items?.map((item: any) => serializeExpr(item)) || [];
  return items.join(", ");
}
