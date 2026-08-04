/**
 * Column Parser
 *
 * Handles parsing of table columns from pgsql-parser AST.
 */

import { Logger } from "../../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type { Column } from "../../../../types/schema";
import { normalizeIdentityColumn } from "../../../../utils/identity";
import { normalizeCollation } from "../../../../utils/collation";
import {
  normalizeColumnCompression,
  normalizeColumnStorage,
} from "../../../../utils/column-physical";

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

    const collation = extractColumnCollation(columnDef.collClause);

    const storage = normalizeColumnStorage(columnDef.storage_name);
    const compression = normalizeColumnCompression(columnDef.compression);

    const generated = extractGeneratedColumn(columnDef.constraints || []);

    const identity = extractIdentityColumn(columnDef.constraints || [], type);

    const isSerial = ["SERIAL", "SMALLSERIAL", "BIGSERIAL"].includes(type.toUpperCase());
    return {
      name,
      type,
      nullable: !constraints.notNull && !constraints.primary && !isSerial && !identity,
      default: defaultValue,
      collation,
      storage,
      compression,
      identity,
      generated,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse column: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export function extractColumnCollation(
  collClause: any
): Column['collation'] | undefined {
  const parts = (collClause?.collname || [])
    .map(function getCollationPart(item: any) {
      return item?.String?.sval;
    })
    .filter(function hasCollationPart(value: unknown): value is string {
      return typeof value === "string" && value.length > 0;
    });
  const name = parts.at(-1);
  if (!name) return undefined;

  return normalizeCollation({
    name,
    schema: parts.length > 1 ? parts.at(-2) : undefined,
  });
}

function renderTypeIdentifier(value: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Extract data type from typeName node
 */
export function extractDataType(typeName: any): string {
  try {
    if (!typeName || !typeName.names) return "UNKNOWN";

    const names = typeName.names.map((n: any) => n.String?.sval || '');
    if (names.length === 0) return "UNKNOWN";

    let type: string;
    if (names.length > 1 && names[0] === 'pg_catalog') {
      type = names[names.length - 1].toUpperCase();
    } else if (names.length > 1) {
      type = names.map(renderTypeIdentifier).join('.');
    } else {
      const name = names[0];
      type = /^[a-z_][a-z0-9_$]*$/.test(name)
        ? name.toUpperCase()
        : renderTypeIdentifier(name);
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
        if (type === "INTERVAL" && params.length === 2 && params[0] === 32767) {
          type += `(${params[1]})`;
        } else {
          type += `(${params.join(',')})`;
        }
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

        // generated_when uses 'a' for ALWAYS. PostgreSQL 18 adds
        // generated_kind, where 's' is stored and 'v' is virtual.
        const always = c.generated_when === 'a' || c.generated_when === 97; // 97 is ASCII 'a'
        const stored =
          c.generated_kind === undefined ||
          c.generated_kind === 's' ||
          c.generated_kind === 115;

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

function extractIdentityOptionValue(arg: any): string | undefined {
  const value =
    arg?.Integer?.ival ??
    arg?.Float?.fval ??
    arg?.A_Const?.ival?.ival ??
    arg?.A_Const?.fval?.fval;
  return value === undefined ? undefined : String(value);
}

function extractIdentitySequenceName(
  arg: any
): NonNullable<Column['identity']>['sequenceName'] {
  const names = (arg?.List?.items || [])
    .map(function getNamePart(item: any) {
      return item?.String?.sval;
    })
    .filter(function hasNamePart(value: unknown): value is string {
      return typeof value === "string" && value.length > 0;
    });

  const name = names.at(-1);
  if (!name) return undefined;
  return {
    name,
    schema: names.length > 1 ? names.at(-2) : undefined,
  };
}

function extractIdentityColumn(
  constraints: any[],
  columnType: string
): Column['identity'] | undefined {
  try {
    for (const constraint of constraints) {
      const definition = constraint.Constraint;
      if (definition?.contype !== "CONSTR_IDENTITY") continue;

      const generatedWhen = definition.generated_when;
      const identity: NonNullable<Column['identity']> = {
        generation:
          generatedWhen === "a" || generatedWhen === 97
            ? "ALWAYS"
            : "BY DEFAULT",
      };

      for (const option of definition.options || []) {
        const element = option.DefElem;
        if (!element) continue;

        switch (element.defname) {
          case "sequence_name":
            identity.sequenceName = extractIdentitySequenceName(element.arg);
            break;
          case "logged":
            identity.sequencePersistence = "logged";
            break;
          case "unlogged":
            identity.sequencePersistence = "unlogged";
            break;
          case "start":
            identity.start = extractIdentityOptionValue(element.arg);
            break;
          case "increment":
            identity.increment = extractIdentityOptionValue(element.arg);
            break;
          case "minvalue":
            identity.minValue = extractIdentityOptionValue(element.arg);
            break;
          case "maxvalue":
            identity.maxValue = extractIdentityOptionValue(element.arg);
            break;
          case "cache":
            identity.cache = extractIdentityOptionValue(element.arg);
            break;
          case "cycle":
            identity.cycle = Boolean(element.arg?.Boolean?.boolval);
            break;
        }
      }

      return normalizeIdentityColumn(columnType, identity);
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract identity column info: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return undefined;
}
