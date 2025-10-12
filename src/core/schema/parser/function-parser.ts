/**
 * Function Parser
 *
 * Handles parsing of PostgreSQL CREATE FUNCTION statements from CST.
 */

import { Logger } from "../../../utils/logger";
import type { Function, FunctionParameter } from "../../../types/schema";

/**
 * Parse CREATE FUNCTION statement from CST
 */
export function parseCreateFunction(node: any): Function | null {
  try {
    const name = extractFunctionName(node);
    if (!name) return null;

    const parameters = extractFunctionParameters(node);
    const returnType = extractReturnType(node);
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
      `Failed to parse CREATE FUNCTION from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Extract function name from CST node
 */
function extractFunctionName(node: any): string | null {
  try {
    return node.name?.name || node.name?.text || null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract function parameters from CST node
 */
function extractFunctionParameters(node: any): FunctionParameter[] {
  const parameters: FunctionParameter[] = [];

  try {
    const items = node.params?.expr?.items || [];

    for (const item of items) {
      if (item.type === "function_param") {
        const param: FunctionParameter = {
          name: item.name?.name || item.name?.text,
          type: extractDataType(item.dataType),
        };

        if (item.mode) {
          param.mode = item.mode.name || item.mode.text;
        }

        if (item.default) {
          param.default = extractDefaultValue(item.default);
        }

        parameters.push(param);
      }
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract function parameters: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return parameters;
}

/**
 * Extract data type from CST node
 */
function extractDataType(dataTypeNode: any): string {
  if (!dataTypeNode) return "unknown";

  try {
    if (dataTypeNode.type === "named_data_type") {
      let typeName = dataTypeNode.name?.name || dataTypeNode.name?.text || "unknown";

      if (dataTypeNode.size && dataTypeNode.size.expr) {
        const size = dataTypeNode.size.expr.text || dataTypeNode.size.expr.value;
        typeName += `(${size})`;
      }

      return typeName;
    }

    return "unknown";
  } catch (error) {
    return "unknown";
  }
}

/**
 * Extract default value from CST node
 */
function extractDefaultValue(defaultNode: any): string {
  try {
    if (defaultNode.expr) {
      return defaultNode.expr.text || defaultNode.expr.value || "";
    }
    return "";
  } catch (error) {
    return "";
  }
}

/**
 * Extract return type from RETURNS clause
 */
function extractReturnType(node: any): string | null {
  try {
    const clauses = node.clauses || [];
    for (const clause of clauses) {
      if (clause.type === "returns_clause") {
        return extractDataType(clause.dataType);
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract language from LANGUAGE clause
 */
function extractLanguage(node: any): string | null {
  try {
    const clauses = node.clauses || [];
    for (const clause of clauses) {
      if (clause.type === "language_clause") {
        return clause.name?.name || clause.name?.text || null;
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract function body from AS clause
 */
function extractFunctionBody(node: any): string | null {
  try {
    const clauses = node.clauses || [];
    for (const clause of clauses) {
      if (clause.type === "as_clause") {
        if (clause.expr && clause.expr.type === "string_literal") {
          return clause.expr.value || clause.expr.text || null;
        }
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract volatility (VOLATILE, STABLE, IMMUTABLE)
 */
function extractVolatility(node: any): Function['volatility'] | undefined {
  try {
    const clauses = node.clauses || [];
    for (const clause of clauses) {
      if (clause.type === "volatility_clause") {
        const value = clause.volatilityKw?.name || clause.volatilityKw?.text;
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
 * Extract parallel setting (SAFE, UNSAFE, RESTRICTED)
 */
function extractParallel(node: any): Function['parallel'] | undefined {
  try {
    const clauses = node.clauses || [];
    for (const clause of clauses) {
      if (clause.type === "parallel_clause") {
        const value = clause.parallelKw?.name || clause.parallelKw?.text;
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
 * Extract SECURITY DEFINER flag
 */
function extractSecurityDefiner(node: any): boolean | undefined {
  try {
    const clauses = node.clauses || [];
    for (const clause of clauses) {
      if (clause.type === "security_clause") {
        const security = clause.securityKw?.name || clause.securityKw?.text;
        return security === "DEFINER";
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract STRICT flag (RETURNS NULL ON NULL INPUT)
 */
function extractStrict(node: any): boolean | undefined {
  try {
    const clauses = node.clauses || [];
    for (const clause of clauses) {
      if (clause.type === "strict_clause" || clause.type === "null_input_clause") {
        return true;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract COST value
 */
function extractCost(node: any): number | undefined {
  try {
    const clauses = node.clauses || [];
    for (const clause of clauses) {
      if (clause.type === "cost_clause") {
        return clause.value?.value || clause.value?.text;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract ROWS value
 */
function extractRows(node: any): number | undefined {
  try {
    const clauses = node.clauses || [];
    for (const clause of clauses) {
      if (clause.type === "rows_clause") {
        return clause.value?.value || clause.value?.text;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}
