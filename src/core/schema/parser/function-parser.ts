/**
 * Function Parser
 *
 * Handles parsing of PostgreSQL CREATE FUNCTION statements from CST.
 */

import { Logger } from "../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type { Function, FunctionParameter } from "../../../types/schema";

/**
 * Parse CREATE FUNCTION statement from pgsql-parser AST
 */
export function parseCreateFunction(node: any): Function | null {
  try {
    const name = extractFunctionName(node);
    if (!name) {
      Logger.warning("Function missing name");
      return null;
    }
    const schema = extractFunctionSchema(node);

    const parameters = extractFunctionParameters(node);
    const returnType = extractReturnType(node, parameters);
    if (!returnType) {
      Logger.warning(`Function '${name}' missing return type`);
      return null;
    }

    const language = extractLanguage(node);
    if (!language) {
      Logger.warning(`Function '${name}' missing language specification`);
      return null;
    }

    const body = extractFunctionBody(node);
    if (!body) {
      Logger.warning(`Function '${name}' missing body`);
      return null;
    }

    const volatility = extractVolatility(node);
    const parallel = extractParallel(node);
    const securityDefiner = extractSecurityDefiner(node);
    const strict = extractStrict(node);
    const cost = extractCost(node);
    const rows = extractRows(node);

    return {
      name,
      schema,
      parameters,
      returnType,
      language,
      body,
      volatility,
      parallel,
      securityDefiner,
      strict,
      cost,
      rows,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE FUNCTION: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function extractFunctionSchema(node: any): string | undefined {
  try {
    if (!node.funcname || !Array.isArray(node.funcname)) return undefined;
    const names = node.funcname.map((n: any) => n.String?.sval).filter(Boolean);
    if (names.length <= 1) return undefined;
    return names[names.length - 2];
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract function name from pgsql-parser AST node
 * funcname is an array of String nodes
 */
function extractFunctionName(node: any): string | null {
  try {
    if (!node.funcname || !Array.isArray(node.funcname)) return null;

    // Extract the last element which is the function name
    // (earlier elements would be schema names)
    const names = node.funcname.map((n: any) => n.String?.sval).filter(Boolean);
    return names.length > 0 ? names[names.length - 1] : null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract function parameters from pgsql-parser AST node
 */
function extractFunctionParameters(node: any): FunctionParameter[] {
  const parameters: FunctionParameter[] = [];

  try {
    if (!node.parameters || !Array.isArray(node.parameters)) {
      return parameters;
    }

    for (const paramNode of node.parameters) {
      const fpNode = paramNode.FunctionParameter;
      if (!fpNode) continue;

      const param: FunctionParameter = {
        name: fpNode.name || undefined,
        type: extractDataType(fpNode.argType),
      };

      // Mode is stored as FUNC_PARAM_IN, FUNC_PARAM_OUT, etc.
      if (fpNode.mode) {
        const modeStr = fpNode.mode.replace('FUNC_PARAM_', '');
        if (modeStr === 'TABLE') {
          param.mode = "OUT";
        } else if (modeStr !== 'DEFAULT') {
          param.mode = modeStr as 'IN' | 'OUT' | 'INOUT' | 'VARIADIC';
        }
      }

      if (fpNode.defexpr) {
        param.default = extractDefaultValue(fpNode.defexpr);
      }

      parameters.push(param);
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract function parameters: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return parameters;
}

/**
 * Extract data type from pgsql-parser AST node
 * Type info is in names array: ["pg_catalog", "int4"] -> "integer"
 */
function extractDataType(dataTypeNode: any): string {
  if (!dataTypeNode) return "unknown";

  try {
    if (dataTypeNode.names && Array.isArray(dataTypeNode.names)) {
      const typeNames = dataTypeNode.names.map((n: any) => n.String?.sval).filter(Boolean);
      if (typeNames.length === 0) {
        return "unknown";
      }

      const typeName = typeNames[typeNames.length - 1] as string;
      const schemaParts = typeNames.slice(0, -1) as string[];
      const typeMap: Record<string, string> = {
        int4: "integer",
        int2: "smallint",
        int8: "bigint",
        float4: "real",
        float8: "double precision",
        bool: "boolean",
        varchar: "character varying",
      };
      const mappedType = typeMap[typeName.toLowerCase()];
      const normalizedSchema = schemaParts.join(".").toLowerCase();
      const arraySuffix = Array.isArray(dataTypeNode.arrayBounds) && dataTypeNode.arrayBounds.length > 0
        ? "[]".repeat(dataTypeNode.arrayBounds.length)
        : "";

      if (schemaParts.length === 0 || normalizedSchema === "pg_catalog") {
        return `${mappedType || quoteTypeIdentifier(typeName)}${arraySuffix}`;
      }

      return `${schemaParts.map(quoteTypeIdentifier).join(".")}.${quoteTypeIdentifier(typeName)}${arraySuffix}`;
    }

    return "unknown";
  } catch (error) {
    return "unknown";
  }
}

function quoteTypeIdentifier(value: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Extract default value from CST node
 */
function extractDefaultValue(defaultNode: any): string {
  try {
    const sql = deparseSync([
      {
        SelectStmt: {
          targetList: [
            {
              ResTarget: {
                val: defaultNode,
              },
            },
          ],
          op: "SETOP_NONE",
          limitOption: "LIMIT_OPTION_DEFAULT",
        },
      },
    ]).trim();

    if (sql.startsWith("SELECT ")) {
      return sql.slice(7).trim();
    }

    return sql || "";
  } catch (error) {
  }

  try {
    const deparsed = deparseSync([defaultNode]).trim();
    if (deparsed) {
      return deparsed;
    }
  } catch (error) {
  }

  try {
    if (defaultNode?.expr) {
      return defaultNode.expr.text || defaultNode.expr.value || "";
    }
  } catch (error) {
  }

  return "";
}

/**
 * Extract return type from pgsql-parser AST
 */
function extractReturnType(node: any, parameters: FunctionParameter[]): string | null {
  try {
    if (node.returnType) {
      const type = extractDataType(node.returnType);
      if (!type) {
        return null;
      }

      if (node.returnType.setof === true) {
        return `SETOF ${type}`;
      }

      return type;
    }

    const outputParams = parameters.filter(function (parameter) {
      return parameter.mode === "OUT" || parameter.mode === "INOUT";
    });

    if (outputParams.length === 0) {
      return null;
    }

    if (outputParams.length === 1) {
      return outputParams[0]?.type || null;
    }

    return "record";
  } catch (error) {
    return null;
  }
}

/**
 * Extract language from options array in pgsql-parser AST
 */
function extractLanguage(node: any): string | null {
  try {
    if (!node.options || !Array.isArray(node.options)) return null;

    for (const option of node.options) {
      const defElem = option.DefElem;
      if (defElem && defElem.defname === 'language') {
        return defElem.arg?.String?.sval || null;
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract function body from options array (AS clause)
 */
function extractFunctionBody(node: any): string | null {
  try {
    if (!node.options || !Array.isArray(node.options)) return null;

    for (const option of node.options) {
      const defElem = option.DefElem;
      if (defElem && defElem.defname === 'as') {
        // Body is in a List with items containing String nodes
        const listItems = defElem.arg?.List?.items;
        if (listItems && Array.isArray(listItems)) {
          const bodyParts = listItems.map((item: any) => item.String?.sval).filter(Boolean);
          return bodyParts.join('\n') || null;
        }
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract volatility from options (VOLATILE, STABLE, IMMUTABLE)
 */
function extractVolatility(node: any): Function['volatility'] | undefined {
  try {
    if (!node.options || !Array.isArray(node.options)) return undefined;

    for (const option of node.options) {
      const defElem = option.DefElem;
      if (defElem && defElem.defname === 'volatility') {
        const value = defElem.arg?.String?.sval?.toUpperCase();
        if (value === "VOLATILE" || value === "STABLE" || value === "IMMUTABLE") {
          return value as Function['volatility'];
        }
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract parallel setting from options (SAFE, UNSAFE, RESTRICTED)
 */
function extractParallel(node: any): Function['parallel'] | undefined {
  try {
    if (!node.options || !Array.isArray(node.options)) return undefined;

    for (const option of node.options) {
      const defElem = option.DefElem;
      if (defElem && defElem.defname === 'parallel') {
        const value = defElem.arg?.String?.sval?.toUpperCase();
        if (value === "SAFE" || value === "UNSAFE" || value === "RESTRICTED") {
          return value as Function['parallel'];
        }
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract SECURITY DEFINER flag from options
 */
function extractSecurityDefiner(node: any): boolean | undefined {
  try {
    if (!node.options || !Array.isArray(node.options)) return undefined;

    for (const option of node.options) {
      const defElem = option.DefElem;
      if (defElem && defElem.defname === 'security') {
        if (typeof defElem.arg?.Boolean?.boolval === "boolean") {
          return defElem.arg.Boolean.boolval;
        }
        if (typeof defElem.arg?.Integer?.ival === "number") {
          return defElem.arg.Integer.ival === 1;
        }
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract STRICT flag from options
 */
function extractStrict(node: any): boolean | undefined {
  try {
    if (!node.options || !Array.isArray(node.options)) return undefined;

    for (const option of node.options) {
      const defElem = option.DefElem;
      if (defElem && defElem.defname === 'strict') {
        if (typeof defElem.arg?.Boolean?.boolval === "boolean") {
          return defElem.arg.Boolean.boolval;
        }
        if (typeof defElem.arg?.Integer?.ival === "number") {
          return defElem.arg.Integer.ival === 1;
        }
        return true;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract COST value from options
 */
function extractCost(node: any): number | undefined {
  try {
    if (!node.options || !Array.isArray(node.options)) return undefined;

    for (const option of node.options) {
      const defElem = option.DefElem;
      if (defElem && defElem.defname === 'cost') {
        return defElem.arg?.Integer?.ival || defElem.arg?.Float?.fval;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract ROWS value from options
 */
function extractRows(node: any): number | undefined {
  try {
    if (!node.options || !Array.isArray(node.options)) return undefined;

    for (const option of node.options) {
      const defElem = option.DefElem;
      if (defElem && defElem.defname === 'rows') {
        return defElem.arg?.Integer?.ival || defElem.arg?.Float?.fval;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}
