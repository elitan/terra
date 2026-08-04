import { Logger } from "../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type { Procedure, FunctionParameter } from "../../../types/schema";
import { ParserError } from "../../../types/errors";
import {
  extractRoutineConfiguration,
  validateRoutineDefinition,
} from "./routine-option-parser";

const SUPPORTED_PROCEDURE_OPTIONS = new Set([
  "as",
  "language",
  "security",
  "set",
]);

export function parseCreateProcedure(
  node: any,
  originalSql: string = "",
  filePath?: string
): Procedure | null {
  try {
    validateRoutineDefinition(
      node,
      "procedure",
      SUPPORTED_PROCEDURE_OPTIONS,
      originalSql,
      filePath
    );
    const { name, schema } = extractProcedureNameAndSchema(node);
    if (!name) return null;

    const parameters = extractProcedureParameters(node);

    const language = extractLanguage(node);
    if (!language) {
      Logger.warning(`Procedure '${name}' missing language specification`);
      return null;
    }

    const body = extractProcedureBody(node);
    if (body === null) {
      Logger.warning(`Procedure '${name}' missing body`);
      return null;
    }

    const securityDefiner = extractSecurityDefiner(node);
    const configuration = extractRoutineConfiguration(
      node,
      "procedure",
      originalSql,
      filePath
    );

    return {
      name,
      schema,
      parameters,
      language: language as string,
      body: body as string,
      securityDefiner,
      configuration,
    };
  } catch (error) {
    if (error instanceof ParserError) {
      throw error;
    }
    Logger.warning(
      `Failed to parse CREATE PROCEDURE from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function extractProcedureNameAndSchema(node: any): { name: string | null; schema: string | undefined } {
  try {
    if (!node.funcname || !Array.isArray(node.funcname)) {
      return { name: null, schema: undefined };
    }

    const names = node.funcname.map((n: any) => n.String?.sval).filter(Boolean);
    if (names.length === 0) {
      return { name: null, schema: undefined };
    }

    return {
      name: names[names.length - 1] as string,
      schema: names.length > 1 ? (names[names.length - 2] as string) : undefined,
    };
  } catch {
    return { name: null, schema: undefined };
  }
}

function extractProcedureParameters(node: any): FunctionParameter[] {
  const parameters: FunctionParameter[] = [];

  try {
    if (!node.parameters || !Array.isArray(node.parameters)) {
      return parameters;
    }

    for (const parameter of node.parameters) {
      const fpNode = parameter.FunctionParameter;
      if (!fpNode) continue;

      const param: FunctionParameter = {
        name: fpNode.name || undefined,
        type: extractDataType(fpNode.argType),
      };

      if (fpNode.mode) {
        const mode = fpNode.mode.replace("FUNC_PARAM_", "");
        if (mode !== "DEFAULT") {
          param.mode = mode as FunctionParameter["mode"];
        }
      }

      if (fpNode.defexpr) {
        param.default = extractDefaultValue(fpNode.defexpr);
      }

      parameters.push(param);
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract procedure parameters: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return parameters;
}

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
  } catch {
    return "unknown";
  }
}

function quoteTypeIdentifier(value: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

function extractDefaultValue(defaultNode: any): string | undefined {
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

    return sql || undefined;
  } catch {
    return undefined;
  }
}

function extractLanguage(node: any): string | null {
  try {
    if (!node.options || !Array.isArray(node.options)) return null;

    for (const option of node.options) {
      const defElem = option.DefElem;
      if (defElem && defElem.defname === "language") {
        return defElem.arg?.String?.sval || null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function extractProcedureBody(node: any): string | null {
  try {
    if (!node.options || !Array.isArray(node.options)) return null;

    for (const option of node.options) {
      const defElem = option.DefElem;
      if (defElem && defElem.defname === "as") {
        const listItems = defElem.arg?.List?.items;
        if (!listItems || !Array.isArray(listItems)) {
          return null;
        }

        const bodyParts = listItems
          .map(function extractString(item: any) {
            return item.String?.sval;
          })
          .filter(function isString(value: unknown): value is string {
            return typeof value === "string";
          });
        return bodyParts.length > 0 ? bodyParts.join("\n") : null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function extractSecurityDefiner(node: any): boolean | undefined {
  try {
    if (!node.options || !Array.isArray(node.options)) return undefined;

    for (const option of node.options) {
      const defElem = option.DefElem;
      if (defElem && defElem.defname === "security") {
        if (typeof defElem.arg?.Boolean?.boolval === "boolean") {
          return defElem.arg.Boolean.boolval;
        }
        if (typeof defElem.arg?.Integer?.ival === "number") {
          return defElem.arg.Integer.ival === 1;
        }
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}
