import type { Table, Trigger, View } from "../types/schema";

export function normalizeSQLiteIdentifier(identifier: string): string {
  return identifier.replace(/[A-Z]/g, function (character) {
    return character.toLowerCase();
  });
}

export function collectSQLiteSchemaIdentifiers(
  tables: readonly Table[],
  views: readonly View[],
  triggers: readonly Trigger[]
): string[] {
  const identifiers = new Set<string>([
    "main",
    "temp",
    "new",
    "old",
    "rowid",
    "oid",
    "_rowid_",
  ]);

  function add(value: string | undefined): void {
    if (value) {
      identifiers.add(value);
    }
  }

  for (const table of tables) {
    add(table.name);
    add(table.schema);
    for (const column of table.columns) {
      add(column.name);
      add(column.collation?.name);
      add(column.collation?.schema);
    }
    add(table.primaryKey?.name);
    for (const column of table.primaryKey?.columns || []) {
      add(column);
    }
    for (const foreignKey of table.foreignKeys || []) {
      add(foreignKey.name);
      add(foreignKey.referencedTable);
      for (const column of [
        ...foreignKey.columns,
        ...foreignKey.referencedColumns,
      ]) {
        add(column);
      }
    }
    for (const constraint of table.checkConstraints || []) {
      add(constraint.name);
    }
    for (const constraint of table.uniqueConstraints || []) {
      add(constraint.name);
      for (const column of constraint.columns) {
        add(column);
      }
      for (const collation of constraint.collations || []) {
        add(collation);
      }
    }
    for (const index of table.indexes || []) {
      add(index.name);
      add(index.tableName);
      add(index.schema);
      add(index.constraint?.name);
      for (const column of index.columns) {
        add(column);
      }
      for (const term of index.terms || []) {
        add(term.column);
        add(typeof term.collation === "string" ? term.collation : undefined);
      }
    }
  }

  for (const view of views) {
    add(view.name);
    add(view.schema);
    for (const column of view.columnNames || []) {
      add(column);
    }
  }

  for (const trigger of triggers) {
    add(trigger.name);
    add(trigger.tableName);
    add(trigger.schema);
  }

  return Array.from(identifiers);
}
