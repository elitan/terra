/**
 * Column Parser
 *
 * Handles parsing of table columns from pgsql-parser AST.
 */

import { Logger } from "../../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type { Column } from "../../../../types/schema";

/**
 * Extract all columns from CREATE TABLE tableElts array
 */
export function extractColumns(tableElts: any[]): Column[] {
  const columns: Column[] = [];

  try {
    for (const elt of tableElts) {
      if (elt.ColumnDef) {
        const column = parseColumn(elt.ColumnDef);
        if (column) {
          columns.push(column);
        }
      }
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract columns: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return columns;
}

/**
 * Parse a single column definition from pgsql-parser AST
 */
export function parseColumn(columnDef: any): Column | null {
  try {
    const name = columnDef.colname;
    if (!name) return null;

    const type = extractDataType(columnDef.typeName);

    const constraints = extractBasicConstraints(columnDef.constraints || []);

    const defaultValue = extractDefaultValue(columnDef.constraints || []);

    const generated = extractGeneratedColumn(columnDef.constraints || []);

    const isSerial = ["SERIAL", "SMALLSERIAL", "BIGSERIAL"].includes(type.toUpperCase());
    return {
      name,
      type,
      nullable: !constraints.notNull && !constraints.primary && !isSerial,
      default: defaultValue,
      generated,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse column: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Extract data type from typeName node
 */
function extractDataType(typeName: any): string {
  try {
    if (!typeName || !typeName.names) return "UNKNOWN";

    const names = typeName.names.map((n: any) => n.String?.sval || '');

    let type: string;
    if (names.length > 1 && names[0] === 'pg_catalog') {
      type = names[names.length - 1].toUpperCase();
    } else if (names.length > 1) {
      type = names.join('.');
    } else {
      type = names[0].toUpperCase();
    }

    if (typeName.typmods && typeName.typmods.length > 0) {
      const params = typeName.typmods.map((mod: any) => {
        if (mod.A_Const?.ival !== undefined) {
          return mod.A_Const.ival.ival;
        }
        if (mod.A_Const?.sval !== undefined) {
          return mod.A_Const.sval.sval;
        }
        if (mod.ColumnRef) {
          const fields = mod.ColumnRef.fields || [];
          return fields.map((f: any) => f.String?.sval || '').join('.');
        }
        try {
          return deparseSync([mod]).trim();
        } catch {
          return '';
        }
      }).filter(Boolean);

      if (params.length > 0) {
        type += `(${params.join(',')})`;
      }
    }

    if (typeName.arrayBounds && typeName.arrayBounds.length > 0) {
      for (const bound of typeName.arrayBounds) {
        const boundVal = bound?.Integer?.ival ?? bound;
        if (boundVal === -1) {
          type += '[]';
        } else if (typeof boundVal === 'number' && boundVal > 0) {
          type += `[${boundVal}]`;
        } else {
          type += '[]';
        }
      }
    }

    return type;
  } catch (error) {
    Logger.warning(
      `Failed to extract data type: ${error instanceof Error ? error.message : String(error)}`
    );
    return "UNKNOWN";
  }
}

/**
 * Extract basic column-level constraints (NOT NULL, PRIMARY KEY)
 */
function extractBasicConstraints(constraints: any[]): {
  notNull: boolean;
  primary: boolean;
} {
  let notNull = false;
  let primary = false;

  try {
    for (const constraint of constraints) {
      if (constraint.Constraint) {
        const contype = constraint.Constraint.contype;
        if (contype === "CONSTR_NOTNULL") {
          notNull = true;
        } else if (contype === "CONSTR_PRIMARY") {
          primary = true;
        }
      }
    }
  } catch (error) {
    // Ignore extraction errors
  }

  return { notNull, primary };
}

/**
 * Extract default value from constraints
 */
function extractDefaultValue(constraints: any[]): string | undefined {
  try {
    for (const constraint of constraints) {
      if (constraint.Constraint?.contype === "CONSTR_DEFAULT") {
        const rawExpr = constraint.Constraint.raw_expr;
        if (rawExpr) {
          return deparseSync([rawExpr]).trim();
        }
      }
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract default value: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return undefined;
}

/**
 * Extract generated column info from constraints
 */
function extractGeneratedColumn(constraints: any[]): Column['generated'] | undefined {
  try {
    for (const constraint of constraints) {
      if (constraint.Constraint?.contype === "CONSTR_GENERATED") {
        const c = constraint.Constraint;

        // generated_when can be 'a' (ALWAYS) or 's' (BY DEFAULT/ON STORAGE)
        // In pgsql-parser, 'a' = ALWAYS, but we need to check the actual value
        const always = c.generated_when === 'a' || c.generated_when === 97; // 97 is ASCII 'a'

        const stored = true;

        const expression = c.raw_expr ? deparseSync([c.raw_expr]).trim() : "";

        return {
          always,
          expression,
          stored,
        };
      }
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract generated column info: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return undefined;
}
