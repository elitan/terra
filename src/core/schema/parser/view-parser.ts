/**
 * VIEW Parser
 *
 * Handles parsing of PostgreSQL VIEWs from pgsql-parser AST.
 */

import { Logger } from "../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type { View } from "../../../types/schema";

function parseBooleanOption(value: any): boolean | undefined {
  if (!value) {
    return true;
  }

  if (typeof value.Boolean?.boolval === "boolean") {
    return value.Boolean.boolval;
  }

  if (typeof value.Integer?.ival === "number") {
    return value.Integer.ival !== 0;
  }

  if (typeof value.String?.sval === "string") {
    const normalized = value.String.sval.toLowerCase();
    if (normalized === "true" || normalized === "on" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "off" || normalized === "0") {
      return false;
    }
  }

  if (typeof value.A_Const?.String?.sval === "string") {
    const normalized = value.A_Const.String.sval.toLowerCase();
    if (normalized === "true" || normalized === "on" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "off" || normalized === "0") {
      return false;
    }
  }

  if (typeof value.A_Const?.Integer?.ival === "number") {
    return value.A_Const.Integer.ival !== 0;
  }

  const typeName = value.TypeName?.names?.[0]?.String?.sval;
  if (typeof typeName === "string") {
    const normalized = typeName.toLowerCase();
    if (normalized === "true" || normalized === "on" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "off" || normalized === "0") {
      return false;
    }
  }

  return undefined;
}

/**
 * Parse CREATE VIEW statement from pgsql-parser AST
 */
export function parseCreateView(stmt: any, originalSql: string): View | null {
  try {
    const view = stmt.view;
    if (!view) return null;

    const viewName = view.relname;
    if (!viewName) return null;

    const schema = view.schemaname || undefined;

    const definition = stmt.query ? deparseSync([stmt.query]).trim() : '';
    if (!definition) return null;

    const materialized = false;

    let checkOption: 'CASCADED' | 'LOCAL' | undefined = undefined;
    if (stmt.withCheckOption) {
      if (stmt.withCheckOption === 'CASCADED_CHECK_OPTION') {
        checkOption = 'CASCADED';
      } else if (stmt.withCheckOption === 'LOCAL_CHECK_OPTION') {
        checkOption = 'LOCAL';
      }
    }

    let securityBarrier: boolean | undefined = undefined;
    if (stmt.options && Array.isArray(stmt.options)) {
      for (const option of stmt.options) {
        const defElem = option.DefElem;
        if (defElem?.defname !== "security_barrier") continue;
        securityBarrier = parseBooleanOption(defElem.arg);
      }
    }

    return {
      name: viewName,
      schema,
      definition,
      materialized,
      checkOption,
      securityBarrier,
    };
  } catch (error) {
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

    return {
      name: viewName,
      schema,
      definition,
      materialized: true,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE MATERIALIZED VIEW: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
