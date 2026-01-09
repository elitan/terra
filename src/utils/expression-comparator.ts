import { parseSync } from "pgsql-parser";

function normalizeAstNode(node: unknown): unknown {
  if (node === null || node === undefined) return node;
  if (typeof node !== "object") return node;

  if (Array.isArray(node)) {
    return node.map(normalizeAstNode);
  }

  const obj = node as Record<string, unknown>;

  // Unwrap TypeCast - extract the inner value and convert string numbers
  if (obj.TypeCast) {
    const typeCast = obj.TypeCast as Record<string, unknown>;
    const innerValue = normalizeAstNode(typeCast.arg) as Record<string, unknown>;
    if (innerValue?.A_Const) {
      const aConst = innerValue.A_Const as Record<string, unknown>;
      if (aConst.sval) {
        const sval = aConst.sval as Record<string, string | undefined>;
        const strVal = sval.sval;
        if (strVal && strVal !== '' && /^-?\d+(\.\d+)?$/.test(strVal)) {
          const numVal = Number(strVal);
          if (Number.isInteger(numVal)) {
            return { A_Const: { ival: { ival: numVal } } };
          }
          return { A_Const: { fval: { fval: String(numVal) } } };
        }
      }
    }
    return innerValue;
  }

  // Convert BETWEEN to >= AND <= for consistent comparison
  // BETWEEN: A_Expr { kind: "AEXPR_BETWEEN", lexpr: col, rexpr: List { items: [low, high] } }
  // Becomes: BoolExpr { boolop: "AND_EXPR", args: [col >= low, col <= high] }
  if (obj.A_Expr) {
    const aExpr = obj.A_Expr as Record<string, unknown>;
    if (aExpr.kind === "AEXPR_BETWEEN") {
      const col = normalizeAstNode(aExpr.lexpr);
      const rexpr = aExpr.rexpr as Record<string, unknown>;
      const list = rexpr?.List as Record<string, unknown[]>;
      const items = list?.items;
      if (items && items.length === 2) {
        const low = normalizeAstNode(items[0]);
        const high = normalizeAstNode(items[1]);
        return {
          BoolExpr: {
            boolop: "AND_EXPR",
            args: [
              {
                A_Expr: {
                  kind: "AEXPR_OP",
                  name: [{ String: { sval: ">=" } }],
                  lexpr: col,
                  rexpr: low,
                },
              },
              {
                A_Expr: {
                  kind: "AEXPR_OP",
                  name: [{ String: { sval: "<=" } }],
                  lexpr: col,
                  rexpr: high,
                },
              },
            ],
          },
        };
      }
    }

    // Convert = ANY (ARRAY[...]) to IN (...) for consistent comparison
    // ANY: A_Expr { kind: "AEXPR_OP_ANY", lexpr: col, rexpr: A_ArrayExpr { elements: [...] } }
    // Or: A_Expr { kind: "AEXPR_OP_ANY", lexpr: col, rexpr: TypeCast { arg: A_ArrayExpr { elements: [...] } } }
    // Becomes: A_Expr { kind: "AEXPR_IN", lexpr: col, rexpr: List { items: [...] } }
    if (aExpr.kind === "AEXPR_OP_ANY") {
      const col = normalizeAstNode(aExpr.lexpr);
      let rexpr = aExpr.rexpr as Record<string, unknown>;

      // Unwrap TypeCast if present (PostgreSQL wraps array in ::text[] cast)
      if (rexpr?.TypeCast) {
        const typeCast = rexpr.TypeCast as Record<string, unknown>;
        rexpr = typeCast.arg as Record<string, unknown>;
      }

      const arrayExpr = rexpr?.A_ArrayExpr as Record<string, unknown[]>;
      const elements = arrayExpr?.elements;
      if (elements) {
        const normalizedItems = elements.map(e => normalizeAstNode(e));
        return {
          A_Expr: {
            kind: "AEXPR_IN",
            name: aExpr.name,
            lexpr: col,
            rexpr: { List: { items: normalizedItems } },
          },
        };
      }
    }

    // Normalize LIKE/ILIKE to AEXPR_OP (PostgreSQL stores LIKE as ~~ with AEXPR_OP)
    if (aExpr.kind === "AEXPR_LIKE" || aExpr.kind === "AEXPR_ILIKE") {
      return {
        A_Expr: {
          kind: "AEXPR_OP",
          name: aExpr.name,
          lexpr: normalizeAstNode(aExpr.lexpr),
          rexpr: normalizeAstNode(aExpr.rexpr),
        },
      };
    }
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "location") continue;
    result[key] = normalizeAstNode(value);
  }
  return result;
}

function parseExpression(expr: string): unknown {
  const ast = parseSync(`SELECT * FROM t WHERE ${expr}`) as {
    stmts?: Array<{ stmt?: { SelectStmt?: { whereClause?: unknown } } }>;
  };
  return ast.stmts?.[0]?.stmt?.SelectStmt?.whereClause;
}

export function expressionsEqual(expr1: string, expr2: string): boolean {
  // Fast path: if strings are identical after basic whitespace normalization
  const basicNorm = (s: string) => s.replace(/\s+/g, " ").trim();
  if (basicNorm(expr1) === basicNorm(expr2)) {
    return true;
  }

  try {
    const where1 = parseExpression(expr1);
    const where2 = parseExpression(expr2);

    if (!where1 || !where2) {
      return false;
    }

    const norm1 = normalizeAstNode(where1);
    const norm2 = normalizeAstNode(where2);

    return JSON.stringify(norm1) === JSON.stringify(norm2);
  } catch {
    // If parsing fails, fall back to string comparison
    return basicNorm(expr1) === basicNorm(expr2);
  }
}
