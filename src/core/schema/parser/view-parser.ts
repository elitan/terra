/**
 * VIEW Parser
 *
 * Handles parsing of PostgreSQL VIEWs from pgsql-parser AST.
 */

import { Logger } from "../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type { View } from "../../../types/schema";
import { ParserError } from "../../../types/errors";
import { parseStorageParameterOptions } from "../../../utils/storage-parameters";

function parseColumnNames(nodes: any[] | undefined): string[] | undefined {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return undefined;
  }

  const names = nodes.map(function parseColumnName(node) {
    return node.String?.sval;
  }).filter(function hasColumnName(name): name is string {
    return typeof name === "string";
  });
  return names.length > 0 ? names : undefined;
}

function parseBooleanOption(value: any): boolean | undefined {
  if (!value) {
    return true;
  }

  if (typeof value.Boolean?.boolval === "boolean") {
    return value.Boolean.boolval;
  }

  const integer = value.Integer?.ival ?? value.A_Const?.Integer?.ival;
  if (typeof integer === "number") {
    return integer !== 0;
  }

  const token = value.String?.sval ??
    value.A_Const?.String?.sval ??
    value.TypeName?.names?.[0]?.String?.sval;
  if (typeof token !== "string") {
    return undefined;
  }
  const normalized = token.toLowerCase();
  if (normalized === "true" || normalized === "on" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "off" || normalized === "0") {
    return false;
  }
  return undefined;
}

function parseCheckOption(value: any): 'CASCADED' | 'LOCAL' | undefined {
  const optionValue = value?.TypeName?.names?.[0]?.String?.sval ||
    value?.String?.sval ||
    value?.A_Const?.String?.sval;
  if (typeof optionValue !== "string") {
    return undefined;
  }

  const normalized = optionValue.toUpperCase();
  return normalized === "CASCADED" || normalized === "LOCAL"
    ? normalized
    : undefined;
}

function viewOptionError(
  message: string,
  originalSql: string,
  filePath?: string
): ParserError {
  return new ParserError(
    message,
    filePath,
    undefined,
    undefined,
    originalSql
  );
}

/**
 * Parse CREATE VIEW statement from pgsql-parser AST
 */
export function parseCreateView(
  stmt: any,
  originalSql: string,
  filePath?: string
): View | null {
  try {
    const view = stmt.view;
    if (!view) return null;

    const viewName = view.relname;
    if (!viewName) return null;

    const schema = view.schemaname || undefined;

    const definition = stmt.query ? deparseSync([stmt.query]).trim() : '';
    if (!definition) return null;

    const materialized = false;
    const columnNames = parseColumnNames(stmt.aliases);

    let checkOption: 'CASCADED' | 'LOCAL' | undefined = undefined;
    if (stmt.withCheckOption) {
      if (stmt.withCheckOption === 'CASCADED_CHECK_OPTION') {
        checkOption = 'CASCADED';
      } else if (stmt.withCheckOption === 'LOCAL_CHECK_OPTION') {
        checkOption = 'LOCAL';
      }
    }

    let securityBarrier: boolean | undefined = undefined;
    let securityInvoker: boolean | undefined = undefined;
    const seenOptions = new Set<string>();
    if (stmt.options && Array.isArray(stmt.options)) {
      for (const option of stmt.options) {
        const defElem = option.DefElem;
        const optionName = defElem?.defname;
        if (!optionName) continue;
        if (seenOptions.has(optionName)) {
          throw viewOptionError(
            `PostgreSQL view option "${optionName}" is specified more than once`,
            originalSql,
            filePath
          );
        }
        seenOptions.add(optionName);

        if (optionName === "check_option") {
          if (checkOption) {
            throw viewOptionError(
              'PostgreSQL view option "check_option" is specified more than once',
              originalSql,
              filePath
            );
          }
          checkOption = parseCheckOption(defElem.arg);
          if (!checkOption) {
            throw viewOptionError(
              'PostgreSQL view option "check_option" must be LOCAL or CASCADED',
              originalSql,
              filePath
            );
          }
          continue;
        }

        if (optionName !== "security_barrier" && optionName !== "security_invoker") {
          throw viewOptionError(
            `PostgreSQL view option "${optionName}" is unsupported; use check_option, security_barrier, or security_invoker`,
            originalSql,
            filePath
          );
        }

        const value = parseBooleanOption(defElem.arg);
        if (value === undefined) {
          throw viewOptionError(
            `PostgreSQL view option "${optionName}" requires a boolean value`,
            originalSql,
            filePath
          );
        }
        if (optionName === "security_barrier") {
          securityBarrier = value;
        } else {
          securityInvoker = value;
        }
      }
    }

    return {
      name: viewName,
      schema,
      definition,
      materialized,
      ...(columnNames ? { columnNames } : {}),
      checkOption,
      securityBarrier,
      securityInvoker,
    };
  } catch (error) {
    if (error instanceof ParserError) {
      throw error;
    }
    Logger.warning(
      `Failed to parse CREATE VIEW: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export function parseCreateMaterializedView(stmt: any): View | null {
  try {
    if (stmt.objtype !== 'OBJECT_MATVIEW') return null;

    const into = stmt.into;
    if (!into || !into.rel) return null;

    const viewName = into.rel.relname;
    if (!viewName) return null;

    const schema = into.rel.schemaname || undefined;

    const definition = stmt.query ? deparseSync([stmt.query]).trim() : '';
    if (!definition) return null;
    const columnNames = parseColumnNames(into.colNames);
    const storageParameters = parseStorageParameterOptions(into.options);
    const accessMethod = into.accessMethod || undefined;
    const tablespace =
      into.tableSpaceName && into.tableSpaceName !== "pg_default"
        ? into.tableSpaceName
        : undefined;

    return {
      name: viewName,
      schema,
      definition,
      materialized: true,
      ...(columnNames ? { columnNames } : {}),
      populated: !Boolean(into.skipData),
      storageParameters,
      accessMethod,
      tablespace,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE MATERIALIZED VIEW: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
