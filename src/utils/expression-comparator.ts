import { parseSync } from "pgsql-parser";

const AST_LOCATION_FIELDS = new Set([
  "location",
  "list_start",
  "list_end",
  "rexpr_list_start",
  "rexpr_list_end",
]);

function getTypeCastName(typeCast: Record<string, unknown>): string | undefined {
  const typeName = typeCast.typeName as Record<string, unknown> | undefined;
  const names = typeName?.names as Array<Record<string, unknown>> | undefined;
  const parts = names
    ?.map((item) => item.String as { sval?: string } | undefined)
    .map((item) => item?.sval)
    .filter((item): item is string => Boolean(item));

  if (!parts || parts.length === 0) {
    return undefined;
  }

  return parts[parts.length - 1]?.toLowerCase();
}

function isNumericType(typeName: string | undefined): boolean {
  if (!typeName) {
    return false;
  }

  return [
    "int",
    "int2",
    "int4",
    "int8",
    "integer",
    "smallint",
    "bigint",
    "numeric",
    "decimal",
    "real",
    "float4",
    "float8",
    "double precision",
  ].includes(typeName);
}

function flattenBoolExprArgs(
  boolop: string,
  args: unknown[]
): unknown[] {
  return args.flatMap((arg) => {
    const boolExpr = (arg as Record<string, unknown> | undefined)?.BoolExpr as
      | Record<string, unknown>
      | undefined;

    if (boolExpr?.boolop === boolop && Array.isArray(boolExpr.args)) {
      return flattenBoolExprArgs(boolop, boolExpr.args);
    }

    return [arg];
  });
}

function getFunctionName(funcCall: Record<string, unknown>): string | undefined {
  const names = funcCall.funcname as Array<Record<string, unknown>> | undefined;
  const parts = names
    ?.map((item) => item.String as { sval?: string } | undefined)
    .map((item) => item?.sval)
    .filter((item): item is string => Boolean(item));

  if (!parts || parts.length === 0) {
    return undefined;
  }

  return parts[parts.length - 1]?.toLowerCase();
}

function normalizeFunctionNameParts(funcCall: Record<string, unknown>): unknown[] | undefined {
  const names = funcCall.funcname as unknown[] | undefined;

  if (!Array.isArray(names) || names.length === 0) {
    return names;
  }

  if (names.length === 2) {
    const schemaName = (names[0] as { String?: { sval?: string } } | undefined)?.String?.sval?.toLowerCase();
    if (schemaName === "pg_catalog") {
      return [names[1]];
    }
  }

  return names;
}

function normalizeRegexPattern(value: string): string {
  return value.replace(/\\([.^$|?*+(){}\[\]])/g, "$1");
}

function getOperatorName(aExpr: Record<string, unknown>): string | undefined {
  const names = aExpr.name as Array<Record<string, unknown>> | undefined;
  const firstName = names?.[0];
  const stringNode = firstName?.String as { sval?: string } | undefined;
  return stringNode?.sval;
}

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
    if (innerValue?.A_Const && isNumericType(getTypeCastName(typeCast))) {
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

    // Convert <> ALL (ARRAY[...]) to NOT IN (...) for consistent comparison
    // PostgreSQL normalizes "col NOT IN ('a', 'b')" to "col <> ALL (ARRAY['a', 'b'])"
    // ALL: A_Expr { kind: "AEXPR_OP_ALL", name: [<>], lexpr: col, rexpr: A_ArrayExpr }
    // NOT IN parses as: A_Expr { kind: "AEXPR_IN", name: [<>], lexpr: col, rexpr: List }
    if (aExpr.kind === "AEXPR_OP_ALL") {
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
        const normalizedItems = elements.map(function normalizeItem(element) {
          return normalizeAstNode(element);
        });
        if (getOperatorName(aExpr) === "<>") {
          return {
            BoolExpr: {
              boolop: "AND_EXPR",
              args: normalizedItems.map((item) => ({
                A_Expr: {
                  kind: "AEXPR_OP",
                  name: [{ String: { sval: "<>" } }],
                  lexpr: col,
                  rexpr: item,
                },
              })),
            },
          };
        }
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

    if (aExpr.kind === "AEXPR_IN" && getOperatorName(aExpr) === "<>") {
      const col = normalizeAstNode(aExpr.lexpr);
      const rexpr = aExpr.rexpr as Record<string, unknown>;
      const list = rexpr?.List as Record<string, unknown[]>;
      const items = list?.items;
      if (items) {
        const normalizedItems = items.map(function normalizeItem(item) {
          return normalizeAstNode(item);
        });
        return {
          BoolExpr: {
            boolop: "AND_EXPR",
            args: normalizedItems.map((item) => ({
              A_Expr: {
                kind: "AEXPR_OP",
                name: [{ String: { sval: "<>" } }],
                lexpr: col,
                rexpr: item,
              },
            })),
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
    if (AST_LOCATION_FIELDS.has(key)) continue;
    result[key] = normalizeAstNode(value);
  }
  if (result.FuncCall) {
    const funcCall = result.FuncCall as Record<string, unknown>;
    funcCall.funcname = normalizeFunctionNameParts(funcCall);
    if (getFunctionName(funcCall) === "regexp_replace" && Array.isArray(funcCall.args)) {
      const patternArg = funcCall.args[1] as Record<string, unknown> | undefined;
      const stringValue = patternArg?.A_Const as Record<string, unknown> | undefined;
      const sval = stringValue?.sval as { sval?: string } | undefined;
      if (typeof sval?.sval === "string") {
        sval.sval = normalizeRegexPattern(sval.sval);
      }
    }
  }
  if (result.BoolExpr) {
    const boolExpr = result.BoolExpr as Record<string, unknown>;
    if (typeof boolExpr.boolop === "string" && Array.isArray(boolExpr.args)) {
      boolExpr.args = flattenBoolExprArgs(boolExpr.boolop, boolExpr.args);
    }
  }
  return result;
}

function parseExpression(expr: string): unknown {
  const ast = parseSync(`SELECT ${expr} AS terradb_expression`) as {
    stmts?: Array<{
      stmt?: {
        SelectStmt?: {
          targetList?: Array<{
            ResTarget?: {
              val?: unknown;
            };
          }>;
        };
      };
    }>;
  };
  return ast.stmts?.[0]?.stmt?.SelectStmt?.targetList?.[0]?.ResTarget?.val;
}

export function expressionsEqual(expr1: string, expr2: string): boolean {
  const trimmedExpression1 = expr1.trim();
  const trimmedExpression2 = expr2.trim();
  if (trimmedExpression1 === trimmedExpression2) {
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
    return false;
  }
}
