/**
 * Procedure Parser
 *
 * Handles parsing of PostgreSQL CREATE PROCEDURE statements from CST.
 */

import { Logger } from "../../../utils/logger";
import type { Procedure, FunctionParameter } from "../../../types/schema";

/**
 * Parse CREATE PROCEDURE statement from pgsql-parser AST
 */
export function parseCreateProcedure(node: any): Procedure | null {
  Logger.warning("Procedure parsing not yet fully implemented for pgsql-parser");
  return null;
  try {
    const fullName = node.name?.text || node.name?.name || null;
    const name = fullName;
    const schema: string | undefined = undefined;
    if (!name) return null;

    const parameters = extractProcedureParameters(node);

    const language = extractLanguage(node);
    if (!language) {
      Logger.warning(`Procedure '${name}' missing language specification`);
      return null;
    }

    const body = extractProcedureBody(node);
    if (!body) {
      Logger.warning(`Procedure '${name}' missing body`);
      return null;
    }

    const securityDefiner = extractSecurityDefiner(node);

    return {
      name,
      schema,
      parameters,
      language: language as string,
      body: body as string,
      securityDefiner,
    };
  } catch (error) {
    Logger.warning(
      // @ts-expect-error - error is unknown but String() handles it
      `Failed to parse CREATE PROCEDURE from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Extract procedure name from CST node
 */
function extractProcedureName(node: any): string | null {
  try {
    return node.name?.name || node.name?.text || null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract procedure parameters from CST node
 */
function extractProcedureParameters(node: any): FunctionParameter[] {
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
      `Failed to extract procedure parameters: ${error instanceof Error ? error.message : String(error)}`
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
 * Extract procedure body from AS clause
 */
function extractProcedureBody(node: any): string | null {
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
