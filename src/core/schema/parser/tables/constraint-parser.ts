/**
 * Constraint Parser
 *
 * Handles parsing of table constraints from pgsql-parser AST:
 * - PRIMARY KEY (column-level and table-level)
 * - FOREIGN KEY
 * - CHECK
 * - UNIQUE
 * - EXCLUDE
 */

import { Logger } from "../../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type {
  PrimaryKeyConstraint,
  ForeignKeyConstraint,
  CheckConstraint,
  UniqueConstraint,
  ExclusionConstraint,
  QualifiedName,
} from "../../../../types/schema";
import { parseStorageParameterOptions } from "../../../../utils/storage-parameters";

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
  exclusionConstraints: ExclusionConstraint[];
} {
  const foreignKeys: ForeignKeyConstraint[] = [];
  const checkConstraints: CheckConstraint[] = [];
  const uniqueConstraints: UniqueConstraint[] = [];
  const exclusionConstraints: ExclusionConstraint[] = [];
  const columnPrimaryKeys: string[] = [];
  let columnPrimaryKeyOptions: Partial<PrimaryKeyConstraint> = {};
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
              const options = getDeferrableOptions(c.Constraint);
              columnPrimaryKeyOptions = {
                name: c.Constraint.conname,
                ...getConstraintIndexOptions(c.Constraint),
                ...(options.deferrable === undefined
                  ? {}
                  : { deferrable: options.deferrable }),
                ...(options.initiallyDeferred === undefined
                  ? {}
                  : { initiallyDeferred: options.initiallyDeferred }),
              };
            } else if (contype === "CONSTR_CHECK") {
              const check = parseCheckConstraintFromNode(c.Constraint);
              if (check) checkConstraints.push(check);
            } else if (contype === "CONSTR_UNIQUE") {
              const options = getDeferrableOptions(c.Constraint);
              uniqueConstraints.push({
                name: c.Constraint.conname,
                columns: [colName],
                ...(c.Constraint.nulls_not_distinct
                  ? { nullsNotDistinct: true }
                  : {}),
                ...getConstraintIndexOptions(c.Constraint),
                ...(options.deferrable === undefined ? {} : { deferrable: options.deferrable }),
                ...(options.initiallyDeferred === undefined
                  ? {}
                  : { initiallyDeferred: options.initiallyDeferred }),
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
          const options = getDeferrableOptions(elt.Constraint);
          tableLevelPrimaryKey = {
            name: elt.Constraint.conname,
            columns: extractColumnNames(elt.Constraint.keys || []),
            ...getConstraintIndexOptions(elt.Constraint),
            ...(options.deferrable === undefined
              ? {}
              : { deferrable: options.deferrable }),
            ...(options.initiallyDeferred === undefined
              ? {}
              : { initiallyDeferred: options.initiallyDeferred }),
          };
        } else if (contype === "CONSTR_FOREIGN") {
          const columns = extractColumnNames(elt.Constraint.fk_attrs || []);
          const fk = parseForeignKeyFromNode(elt.Constraint, columns);
          if (fk) foreignKeys.push(fk);
        } else if (contype === "CONSTR_CHECK") {
          const check = parseCheckConstraintFromNode(elt.Constraint);
          if (check) checkConstraints.push(check);
        } else if (contype === "CONSTR_UNIQUE") {
          const options = getDeferrableOptions(elt.Constraint);
          uniqueConstraints.push({
            name: elt.Constraint.conname,
            columns: extractColumnNames(elt.Constraint.keys || []),
            ...(elt.Constraint.nulls_not_distinct
              ? { nullsNotDistinct: true }
              : {}),
            ...getConstraintIndexOptions(elt.Constraint),
            ...(options.deferrable === undefined ? {} : { deferrable: options.deferrable }),
            ...(options.initiallyDeferred === undefined
              ? {}
              : { initiallyDeferred: options.initiallyDeferred }),
          });
        } else if (contype === "CONSTR_EXCLUSION") {
          const exclusion = parseExclusionConstraintFromNode(elt.Constraint);
          if (exclusion) exclusionConstraints.push(exclusion);
        }
      }
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract constraints: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const primaryKey =
    tableLevelPrimaryKey ||
    (columnPrimaryKeys.length > 0
      ? { columns: columnPrimaryKeys, ...columnPrimaryKeyOptions }
      : undefined);
  const filteredUniqueConstraints = uniqueConstraints.filter(function (constraint) {
    if (!primaryKey) {
      return true;
    }

    if (constraint.columns.length !== primaryKey.columns.length) {
      return true;
    }

    return !constraint.columns.every(function (columnName, index) {
      return primaryKey.columns[index] === columnName;
    });
  });

  return {
    primaryKey,
    foreignKeys,
    checkConstraints,
    uniqueConstraints: filteredUniqueConstraints,
    exclusionConstraints,
  };
}

/**
 * Extract column names from keys array
 */
function extractColumnNames(keys: any[]): string[] {
  return keys.map(k => k.String?.sval || '').filter(Boolean);
}

function getConstraintIndexOptions(constraint: any): Partial<UniqueConstraint> {
  const include = extractColumnNames(constraint.including || []);
  const storageParameters = parseStorageParameterOptions(constraint.options);
  return {
    ...(include.length > 0 ? { include } : {}),
    ...(storageParameters ? { storageParameters } : {}),
    ...(constraint.indexspace ? { tablespace: constraint.indexspace } : {}),
  };
}

function parseOperatorName(operatorNode: any): QualifiedName | undefined {
  const parts = (operatorNode?.List?.items || [])
    .map(function getOperatorPart(item: any) {
      return item?.String?.sval;
    })
    .filter(Boolean);
  const name = parts.at(-1);
  if (!name) return undefined;

  const schema = parts.length > 1 ? parts.slice(0, -1).join(".") : undefined;
  return { name, ...(schema ? { schema } : {}) };
}

function parseExclusionConstraintFromNode(
  constraint: any
): ExclusionConstraint | null {
  try {
    const elements = (constraint.exclusions || [])
      .map(function parseElement(item: any) {
        const parts = item?.List?.items || [];
        const indexElement = parts[0];
        const operator = parseOperatorName(parts[1]);
        if (!indexElement?.IndexElem || !operator) return undefined;

        const definition = deparseSync([indexElement]).trim();
        if (!definition) return undefined;
        return { definition, operator };
      })
      .filter(Boolean);
    if (elements.length === 0) return null;

    const options = getDeferrableOptions(constraint);
    const include = extractColumnNames(constraint.including || []);
    const where = constraint.where_clause
      ? deparseSync([constraint.where_clause]).trim()
      : undefined;

    return {
      name: constraint.conname,
      method: constraint.access_method || undefined,
      elements,
      include: include.length > 0 ? include : undefined,
      storageParameters: parseStorageParameterOptions(constraint.options),
      tablespace: constraint.indexspace || undefined,
      where,
      ...(options.deferrable === undefined
        ? {}
        : { deferrable: options.deferrable }),
      ...(options.initiallyDeferred === undefined
        ? {}
        : { initiallyDeferred: options.initiallyDeferred }),
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse exclusion constraint: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function getDeferrableOptions(constraint: any): {
  deferrable?: boolean;
  initiallyDeferred?: boolean;
} {
  const options: {
    deferrable?: boolean;
    initiallyDeferred?: boolean;
  } = {};

  if (constraint?.deferrable === true) {
    options.deferrable = true;
  }

  if (constraint?.initdeferred === true) {
    options.initiallyDeferred = true;
  }

  return options;
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
    const matchType = constraint.fk_matchtype === "f" ? "FULL" : undefined;

    const options = getDeferrableOptions(constraint);

    return {
      name: constraint.conname,
      columns,
      referencedTable: referencedSchema ? `${referencedSchema}.${referencedTable}` : referencedTable,
      referencedColumns,
      ...(matchType ? { matchType } : {}),
      onDelete,
      onUpdate,
      ...(options.deferrable === undefined ? {} : { deferrable: options.deferrable }),
      ...(options.initiallyDeferred === undefined
        ? {}
        : { initiallyDeferred: options.initiallyDeferred }),
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
    const options = getDeferrableOptions(node);
    return {
      name: node.conname,
      columns: extractColumnNames(node.keys || []),
      ...(node.nulls_not_distinct ? { nullsNotDistinct: true } : {}),
      ...getConstraintIndexOptions(node),
      ...(options.deferrable === undefined ? {} : { deferrable: options.deferrable }),
      ...(options.initiallyDeferred === undefined
        ? {}
        : { initiallyDeferred: options.initiallyDeferred }),
    };
  } catch (error) {
    return null;
  }
}

export function parseTablePrimaryKey(node: any): PrimaryKeyConstraint | null {
  try {
    const options = getDeferrableOptions(node);
    return {
      name: node.conname,
      columns: extractColumnNames(node.keys || []),
      ...getConstraintIndexOptions(node),
      ...(options.deferrable === undefined
        ? {}
        : { deferrable: options.deferrable }),
      ...(options.initiallyDeferred === undefined
        ? {}
        : { initiallyDeferred: options.initiallyDeferred }),
    };
  } catch (error) {
    return null;
  }
}
