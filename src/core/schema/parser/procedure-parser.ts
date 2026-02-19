import { Logger } from "../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type { Procedure, FunctionParameter } from "../../../types/schema";

export function parseCreateProcedure(node: any): Procedure | null {
  try {
    const { name, schema } = extractProcedureNameAndSchema(node);
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
      const typeName = typeNames.length > 0 ? typeNames[typeNames.length - 1] : "unknown";

      const typeMap: Record<string, string> = {
        int4: "integer",
        int2: "smallint",
        int8: "bigint",
        float4: "real",
        float8: "double precision",
        bool: "boolean",
        varchar: "character varying",
      };

      return typeMap[typeName] || typeName;
    }

    return "unknown";
  } catch {
    return "unknown";
  }
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

        const bodyParts = listItems.map((item: any) => item.String?.sval).filter(Boolean);
        return bodyParts.join("\n") || null;
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
