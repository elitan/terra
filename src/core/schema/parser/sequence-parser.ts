import { Logger } from "../../../utils/logger";
import type { Sequence } from "../../../types/schema";

export function parseCreateSequence(node: any): Sequence | null {
  try {
    const name = node.sequence?.relname || null;
    const schema = node.sequence?.schemaname || undefined;
    if (!name) return null;

    const options = getOptions(node);
    const dataType = extractDataType(options);
    const increment = extractNumericOption(options, "increment");
    const minValue = extractNumericOption(options, "minvalue");
    const maxValue = extractNumericOption(options, "maxvalue");
    const start = extractNumericOption(options, "start");
    const cache = extractNumericOption(options, "cache");
    const cycle = extractCycle(options);
    const ownedBy = extractOwnedBy(options);

    return {
      name,
      schema,
      dataType,
      increment,
      minValue,
      maxValue,
      start,
      cache,
      cycle,
      ownedBy,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE SEQUENCE from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function getOptions(node: any): any[] {
  try {
    return Array.isArray(node.options) ? node.options : [];
  } catch {
    return [];
  }
}

function extractDataType(options: any[]): Sequence["dataType"] | undefined {
  try {
    for (const option of options) {
      const defElem = option.DefElem;
      if (defElem?.defname !== "as") continue;

      const names = defElem.arg?.TypeName?.names || [];
      const typeNames = names.map((n: any) => n.String?.sval).filter(Boolean);
      const typeName = typeNames.length > 0 ? typeNames[typeNames.length - 1] : undefined;

      if (typeName === "int2") return "SMALLINT";
      if (typeName === "int4") return "INTEGER";
      if (typeName === "int8") return "BIGINT";
      if (typeName === "smallint") return "SMALLINT";
      if (typeName === "integer") return "INTEGER";
      if (typeName === "bigint") return "BIGINT";
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function extractNumericOption(options: any[], key: string): number | undefined {
  try {
    for (const option of options) {
      const defElem = option.DefElem;
      if (defElem?.defname !== key) continue;

      if (typeof defElem.arg?.Integer?.ival === "number") {
        return defElem.arg.Integer.ival;
      }

      if (typeof defElem.arg?.Float?.fval === "number") {
        return defElem.arg.Float.fval;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function extractCycle(options: any[]): boolean | undefined {
  try {
    for (const option of options) {
      const defElem = option.DefElem;
      if (defElem?.defname !== "cycle") continue;

      if (typeof defElem.arg?.Boolean?.boolval === "boolean") {
        return defElem.arg.Boolean.boolval;
      }

      if (typeof defElem.arg?.Integer?.ival === "number") {
        return defElem.arg.Integer.ival === 1;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function extractOwnedBy(options: any[]): string | undefined {
  try {
    for (const option of options) {
      const defElem = option.DefElem;
      if (defElem?.defname !== "owned_by") continue;

      const items = defElem.arg?.List?.items || [];
      const names = items.map((item: any) => item.String?.sval).filter(Boolean);

      if (names.length === 1 && String(names[0]).toLowerCase() === "none") {
        return undefined;
      }

      if (names.length >= 2) {
        return names
          .map(function (name: string) {
            if (/^[a-z_][a-z0-9_]*$/.test(name)) {
              return name;
            }
            return `"${name.replace(/"/g, '""')}"`;
          })
          .join(".");
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
