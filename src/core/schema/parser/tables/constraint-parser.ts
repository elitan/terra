/**
 * Constraint Parser
 *
 * Handles parsing of table constraints from pgsql-parser AST:
 * - PRIMARY KEY (column-level and table-level)
 * - FOREIGN KEY
 * - CHECK
 * - UNIQUE
 */

import { Logger } from "../../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type {
  PrimaryKeyConstraint,
  ForeignKeyConstraint,
  CheckConstraint,
  UniqueConstraint,
} from "../../../../types/schema";

/**
 * Extract all constraints from CREATE TABLE tableElts array
 */
export function extractAllConstraints(
  tableElts: any[],
  tableName: string
): {
  primaryKey?: PrimaryKeyConstraint;
  foreignKeys: ForeignKeyConstraint[];
  checkConstraints: CheckConstraint[];
  uniqueConstraints: UniqueConstraint[];
} {
  const foreignKeys: ForeignKeyConstraint[] = [];
  const checkConstraints: CheckConstraint[] = [];
  const uniqueConstraints: UniqueConstraint[] = [];
  const columnPrimaryKeys: string[] = [];
  let tableLevelPrimaryKey: PrimaryKeyConstraint | undefined;

  try {
    for (const elt of tableElts) {
      if (elt.ColumnDef) {
        const colName = elt.ColumnDef.colname;
        const constraints = elt.ColumnDef.constraints || [];

        for (const c of constraints) {
          if (c.Constraint) {
            const contype = c.Constraint.contype;
            if (contype === "CONSTR_PRIMARY") {
              columnPrimaryKeys.push(colName);
            } else if (contype === "CONSTR_CHECK") {
              const check = parseCheckConstraintFromNode(c.Constraint);
              if (check) checkConstraints.push(check);
            } else if (contype === "CONSTR_UNIQUE") {
              uniqueConstraints.push({
                name: c.Constraint.conname || `${colName}_unique`,
                columns: [colName],
              });
            } else if (contype === "CONSTR_FOREIGN") {
              const fk = parseForeignKeyFromNode(c.Constraint, [colName]);
              if (fk) foreignKeys.push(fk);
            }
          }
        }
      } else if (elt.Constraint) {
        const contype = elt.Constraint.contype;
        if (contype === "CONSTR_PRIMARY") {
          tableLevelPrimaryKey = {
            name: elt.Constraint.conname,
            columns: extractColumnNames(elt.Constraint.keys || []),
          };
        } else if (contype === "CONSTR_FOREIGN") {
          const columns = extractColumnNames(elt.Constraint.fk_attrs || []);
          const fk = parseForeignKeyFromNode(elt.Constraint, columns);
          if (fk) foreignKeys.push(fk);
        } else if (contype === "CONSTR_CHECK") {
          const check = parseCheckConstraintFromNode(elt.Constraint);
          if (check) checkConstraints.push(check);
        } else if (contype === "CONSTR_UNIQUE") {
          uniqueConstraints.push({
            name: elt.Constraint.conname,
            columns: extractColumnNames(elt.Constraint.keys || []),
          });
        }
      }
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract constraints: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const primaryKey = tableLevelPrimaryKey || (columnPrimaryKeys.length > 0 ? { columns: columnPrimaryKeys } : undefined);

  return {
    primaryKey,
    foreignKeys,
    checkConstraints,
    uniqueConstraints,
  };
}

/**
 * Extract column names from keys array
 */
function extractColumnNames(keys: any[]): string[] {
  return keys.map(k => k.String?.sval || '').filter(Boolean);
}

/**
 * Parse CHECK constraint from Constraint node
 */
function parseCheckConstraintFromNode(constraint: any): CheckConstraint | null {
  try {
    const expression = constraint.raw_expr ? deparseSync([constraint.raw_expr]).trim() : null;
    if (!expression) return null;

    return {
      name: constraint.conname,
      expression,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse check constraint: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Parse FOREIGN KEY constraint from Constraint node
 */
function parseForeignKeyFromNode(constraint: any, columns: string[]): ForeignKeyConstraint | null {
  try {
    if (!constraint.pktable) return null;

    const referencedTable = constraint.pktable.relname;
    const referencedSchema = constraint.pktable.schemaname;
    const referencedColumns = extractColumnNames(constraint.pk_attrs || []);

    if (!referencedTable || columns.length === 0 || referencedColumns.length === 0) {
      return null;
    }

    const fk_action_map: Record<string, "CASCADE" | "RESTRICT" | "SET NULL" | "SET DEFAULT"> = {
      'a': 'NO ACTION',
      'r': 'RESTRICT',
      'c': 'CASCADE',
      'n': 'SET NULL',
      'd': 'SET DEFAULT',
    } as any;

    const onDelete = constraint.fk_del_action ? fk_action_map[constraint.fk_del_action] : undefined;
    const onUpdate = constraint.fk_upd_action ? fk_action_map[constraint.fk_upd_action] : undefined;

    return {
      name: constraint.conname,
      columns,
      referencedTable: referencedSchema ? `${referencedSchema}.${referencedTable}` : referencedTable,
      referencedColumns,
      onDelete,
      onUpdate,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse foreign key constraint: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export function parseCheckConstraint(node: any): CheckConstraint | null {
  return parseCheckConstraintFromNode(node);
}

export function parseForeignKey(node: any): ForeignKeyConstraint | null {
  const columns = extractColumnNames(node.fk_attrs || []);
  return parseForeignKeyFromNode(node, columns);
}

export function parseUniqueConstraint(node: any): UniqueConstraint | null {
  try {
    return {
      name: node.conname,
      columns: extractColumnNames(node.keys || []),
    };
  } catch (error) {
    return null;
  }
}

export function parseTablePrimaryKey(node: any): PrimaryKeyConstraint | null {
  try {
    return {
      name: node.conname,
      columns: extractColumnNames(node.keys || []),
    };
  } catch (error) {
    return null;
  }
}
