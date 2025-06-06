import type { Table } from "../../types/schema";
import {
  generateCreateTableStatement,
  columnsAreDifferent,
} from "../../utils/sql";

export class SchemaDiffer {
  generateMigrationPlan(
    desiredSchema: Table[],
    currentSchema: Table[]
  ): string[] {
    const statements: string[] = [];

    // Create a map of current tables for easy lookup
    const currentTables = new Map(currentSchema.map((t) => [t.name, t]));
    const desiredTables = new Map(desiredSchema.map((t) => [t.name, t]));

    // Handle new tables
    for (const table of desiredSchema) {
      if (!currentTables.has(table.name)) {
        statements.push(generateCreateTableStatement(table));
      } else {
        // Handle column changes for existing tables
        const currentTable = currentTables.get(table.name)!;
        const columnStatements = this.generateColumnStatements(
          table,
          currentTable
        );
        statements.push(...columnStatements);
      }
    }

    // Handle dropped tables
    for (const table of currentSchema) {
      if (!desiredTables.has(table.name)) {
        statements.push(`DROP TABLE ${table.name};`);
      }
    }

    return statements;
  }

  private generateColumnStatements(
    desiredTable: Table,
    currentTable: Table
  ): string[] {
    const statements: string[] = [];

    const currentColumns = new Map(
      currentTable.columns.map((c) => [c.name, c])
    );
    const desiredColumns = new Map(
      desiredTable.columns.map((c) => [c.name, c])
    );

    // Add new columns
    for (const column of desiredTable.columns) {
      if (!currentColumns.has(column.name)) {
        let statement = `ALTER TABLE ${desiredTable.name} ADD COLUMN ${column.name} ${column.type}`;
        if (!column.nullable) statement += " NOT NULL";
        if (column.default) statement += ` DEFAULT ${column.default}`;
        statements.push(statement + ";");
      } else {
        // Check for column modifications
        const currentColumn = currentColumns.get(column.name)!;
        if (columnsAreDifferent(column, currentColumn)) {
          // For simplicity, we'll just note that column modification is needed
          // In a real implementation, you'd handle type changes, nullable changes, etc.
          statements.push(
            `-- TODO: Modify column ${desiredTable.name}.${column.name}`
          );
        }
      }
    }

    // Drop removed columns
    for (const column of currentTable.columns) {
      if (!desiredColumns.has(column.name)) {
        statements.push(
          `ALTER TABLE ${desiredTable.name} DROP COLUMN ${column.name};`
        );
      }
    }

    return statements;
  }
}
