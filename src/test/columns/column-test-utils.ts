import { expect } from "bun:test";
import { Client } from "pg";
import { SchemaParser } from "../../core/schema/parser";
import { SchemaDiffer } from "../../core/schema/differ";
import { DatabaseInspector } from "../../core/schema/inspector";
import { MigrationExecutor } from "../../core/migration/executor";
import { DatabaseService } from "../../core/database/client";
import type { MigrationPlan } from "../../types/migration";
import type { Column } from "../../types/schema";
import { getTableColumns, TEST_DB_CONFIG } from "../utils";

/**
 * Helper to create all the services needed for column testing
 */
export function createColumnTestServices() {
  const parser = new SchemaParser();
  const differ = new SchemaDiffer();
  const inspector = new DatabaseInspector();
  const databaseService = new DatabaseService(TEST_DB_CONFIG);
  const executor = new MigrationExecutor(databaseService);

  return { parser, differ, inspector, executor, databaseService };
}

/**
 * Execute a column migration from current state to desired state
 */
export async function executeColumnMigration(
  client: Client,
  desiredSQL: string,
  services: ReturnType<typeof createColumnTestServices>
): Promise<void> {
  const { parser, differ, inspector, executor } = services;

  const initialSchema = await inspector.getCurrentSchema(client);
  const desiredTables = parser.parseCreateTableStatements(desiredSQL);
  const migrationStatements = differ.generateMigrationPlan(
    desiredTables,
    initialSchema
  );

  const plan: MigrationPlan = {
    statements: migrationStatements,
    hasChanges: migrationStatements.length > 0,
  };

  await executor.executePlan(client, plan);
}

/**
 * Helper to find a column by name in a table
 */
export function findColumn(
  columns: Column[],
  columnName: string
): Column | undefined {
  return columns.find((col) => col.name === columnName);
}

/**
 * Helper to assert column properties
 */
export function assertColumn(
  columns: Column[],
  columnName: string,
  expectedProperties: Partial<Column> & { default?: string | null }
): void {
  const column = findColumn(columns, columnName);
  expect(column).toBeDefined();

  if (!column) return; // TypeScript guard

  if (expectedProperties.type !== undefined) {
    expect(column.type).toBe(expectedProperties.type);
  }

  if (expectedProperties.nullable !== undefined) {
    expect(column.nullable).toBe(expectedProperties.nullable);
  }

  if (expectedProperties.default !== undefined) {
    if (expectedProperties.default === null) {
      expect(column.default).toBeNull();
    } else {
      expect(column.default).toContain(expectedProperties.default);
    }
  }

  if (expectedProperties.primary !== undefined) {
    expect(column.primary).toBe(expectedProperties.primary);
  }
}

/**
 * Helper to assert that a column does NOT exist
 */
export function assertColumnNotExists(
  columns: Column[],
  columnName: string
): void {
  const column = findColumn(columns, columnName);
  expect(column).toBeUndefined();
}

/**
 * Helper to create a standard test table
 */
export async function createTestTable(
  client: Client,
  tableName: string,
  columns: string[]
): Promise<void> {
  const columnDefs = columns.join(",\n    ");
  await client.query(`
    CREATE TABLE ${tableName} (
      ${columnDefs}
    );
  `);
}

/**
 * Test data generators for different column types
 */
export const TestData = {
  /**
   * Generate test data for VARCHAR columns
   */
  varchar: (count: number = 10): string[] => {
    return Array.from({ length: count }, (_, i) => `'test_value_${i}'`);
  },

  /**
   * Generate test data for INTEGER columns
   */
  integer: (count: number = 10): number[] => {
    return Array.from({ length: count }, (_, i) => i + 1);
  },

  /**
   * Generate test data for DECIMAL columns
   */
  decimal: (count: number = 10): string[] => {
    return Array.from({ length: count }, (_, i) => `${(i + 1) * 10.5}`);
  },

  /**
   * Generate problematic data for type conversion testing
   */
  problematic: {
    // Strings that can't convert to numbers
    nonNumericStrings: ["'abc'", "'not_a_number'", "'special@chars'"],

    // Strings that can convert to numbers
    numericStrings: ["'123'", "'45.67'", "'0'", "'-89'"],

    // Edge case values
    edgeCases: ["NULL", "''", "'   '"],
  },
};

/**
 * Helper to insert test data into a table
 */
export async function insertTestData(
  client: Client,
  tableName: string,
  columnName: string,
  values: (string | number)[]
): Promise<void> {
  for (const value of values) {
    await client.query(
      `INSERT INTO ${tableName} (${columnName}) VALUES (${value});`
    );
  }
}

/**
 * Helper to verify data integrity after migration
 */
export async function verifyDataIntegrity(
  client: Client,
  tableName: string,
  expectedRowCount: number
): Promise<void> {
  const result = await client.query(`SELECT COUNT(*) FROM ${tableName};`);
  const actualCount = parseInt(result.rows[0].count);
  expect(actualCount).toBe(expectedRowCount);
}

/**
 * Common column test scenarios as reusable functions
 */
export const ColumnScenarios = {
  /**
   * Standard add column scenario
   */
  addColumn: async (
    client: Client,
    services: ReturnType<typeof createColumnTestServices>,
    tableName: string,
    initialColumns: string,
    newColumn: string,
    expectedColumnCount: number
  ) => {
    // 1. Initial state
    await createTestTable(client, tableName, [initialColumns]);

    // 2. Desired state
    const desiredSQL = `
      CREATE TABLE ${tableName} (
        ${initialColumns},
        ${newColumn}
      );
    `;

    // 3. Execute migration
    await executeColumnMigration(client, desiredSQL, services);

    // 4. Verify
    const finalColumns = await getTableColumns(client, tableName);
    expect(finalColumns).toHaveLength(expectedColumnCount);

    return finalColumns;
  },

  /**
   * Standard remove column scenario
   */
  removeColumn: async (
    client: Client,
    services: ReturnType<typeof createColumnTestServices>,
    tableName: string,
    initialColumns: string[],
    columnToRemove: string,
    expectedColumnCount: number
  ) => {
    // 1. Initial state
    await createTestTable(client, tableName, initialColumns);

    // 2. Desired state (without the column to remove)
    const remainingColumns = initialColumns.filter(
      (col) => !col.includes(columnToRemove)
    );
    const desiredSQL = `
      CREATE TABLE ${tableName} (
        ${remainingColumns.join(",\n        ")}
      );
    `;

    // 3. Execute migration
    await executeColumnMigration(client, desiredSQL, services);

    // 4. Verify
    const finalColumns = await getTableColumns(client, tableName);
    expect(finalColumns).toHaveLength(expectedColumnCount);
    assertColumnNotExists(finalColumns, columnToRemove);

    return finalColumns;
  },
};
