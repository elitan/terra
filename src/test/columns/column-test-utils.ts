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
import {
  BoundaryValues,
  StringEdgeCases,
  BooleanEdgeCases,
  InvalidData,
  LargeDatasetGenerators,
  PerformanceTestData,
} from "./test-data-generators";

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

/**
 * Enhanced assertion helpers for comprehensive testing
 */
export const EnhancedAssertions = {
  /**
   * Assert column type with detailed error messages
   */
  assertColumnType(
    columns: Column[],
    columnName: string,
    expectedType: string,
    context?: string
  ): void {
    const column = findColumn(columns, columnName);
    expect(
      column,
      `Column '${columnName}' should exist${context ? ` in ${context}` : ""}`
    ).toBeDefined();
    expect(
      column?.type,
      `Column '${columnName}' should have type '${expectedType}'${
        context ? ` in ${context}` : ""
      }`
    ).toBe(expectedType);
  },

  /**
   * Assert data integrity with value comparison
   */
  async assertDataIntegrity(
    client: Client,
    tableName: string,
    columnName: string,
    expectedValues: (string | number | boolean | null)[],
    context?: string
  ): Promise<void> {
    const result = await client.query(
      `SELECT ${columnName} FROM ${tableName} ORDER BY ${columnName}`
    );
    const actualValues = result.rows.map((row) => row[columnName]);

    expect(
      actualValues.length,
      `Expected ${expectedValues.length} rows${context ? ` in ${context}` : ""}`
    ).toBe(expectedValues.length);

    for (let i = 0; i < expectedValues.length; i++) {
      expect(
        actualValues[i],
        `Row ${i} value mismatch${context ? ` in ${context}` : ""}`
      ).toEqual(expectedValues[i]);
    }
  },

  /**
   * Assert migration failure with specific error pattern
   */
  async assertMigrationFailure(
    migrationPromise: Promise<any>,
    expectedErrorPattern: RegExp,
    context?: string
  ): Promise<void> {
    try {
      await migrationPromise;
      throw new Error(
        `Expected migration to fail${context ? ` in ${context}` : ""}`
      );
    } catch (error: any) {
      // PostgreSQL errors have the message in the 'message' property
      const errorMessage = error.message || error.toString();
      expect(
        expectedErrorPattern.test(errorMessage),
        `Error message "${errorMessage}" should match pattern ${expectedErrorPattern}${
          context ? ` in ${context}` : ""
        }`
      ).toBe(true);
    }
  },

  /**
   * Assert transaction rollback integrity
   */
  async assertTransactionRollback(
    client: Client,
    tableName: string,
    originalRowCount: number,
    context?: string
  ): Promise<void> {
    const result = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
    const currentRowCount = parseInt(result.rows[0].count);
    expect(
      currentRowCount,
      `Row count should remain unchanged after rollback${
        context ? ` in ${context}` : ""
      }`
    ).toBe(originalRowCount);
  },
};

/**
 * Performance measurement utilities
 */
export const PerformanceUtils = {
  /**
   * Measure migration execution time
   */
  async measureMigrationTime<T>(
    operation: () => Promise<T>
  ): Promise<{ result: T; duration: number }> {
    const startTime = performance.now();
    const result = await operation();
    const endTime = performance.now();
    const duration = endTime - startTime;

    return { result, duration };
  },

  /**
   * Assert migration performance within expected bounds
   */
  assertPerformanceWithinBounds(
    actualDuration: number,
    maxExpectedDuration: number,
    context?: string
  ): void {
    expect(
      actualDuration,
      `Migration should complete within ${maxExpectedDuration}ms${
        context ? ` in ${context}` : ""
      }`
    ).toBeLessThan(maxExpectedDuration);
  },

  /**
   * Measure and log large dataset migration performance
   */
  async measureLargeDataMigration(
    client: Client,
    services: ReturnType<typeof createColumnTestServices>,
    tableName: string,
    initialSQL: string,
    targetSQL: string,
    dataSize: number
  ): Promise<{ migrationTime: number; dataIntact: boolean }> {
    // Create table and insert data
    await client.query(initialSQL);

    const testData = LargeDatasetGenerators.generateVarcharDataset(dataSize);
    for (const value of testData) {
      await client.query(
        `INSERT INTO ${tableName} (test_column) VALUES (${value})`
      );
    }

    // Measure migration
    const { duration } = await this.measureMigrationTime(async () => {
      await executeColumnMigration(client, targetSQL, services);
    });

    // Verify data integrity
    const result = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
    const finalRowCount = parseInt(result.rows[0].count);
    const dataIntact = finalRowCount === dataSize;

    return { migrationTime: duration, dataIntact };
  },
};

/**
 * Data integrity verification utilities
 */
export const DataIntegrityUtils = {
  /**
   * Compare data before and after migration
   */
  async captureTableSnapshot(
    client: Client,
    tableName: string,
    orderBy?: string
  ): Promise<any[]> {
    const orderClause = orderBy ? `ORDER BY ${orderBy}` : "";
    const result = await client.query(
      `SELECT * FROM ${tableName} ${orderClause}`
    );
    return result.rows;
  },

  /**
   * Verify data preservation across type conversion
   */
  async verifyDataPreservation(
    beforeSnapshot: any[],
    afterSnapshot: any[],
    columnName: string,
    conversionFunction?: (beforeValue: any, afterValue: any) => boolean
  ): Promise<void> {
    expect(afterSnapshot.length).toBe(beforeSnapshot.length);

    for (let i = 0; i < beforeSnapshot.length; i++) {
      const beforeValue = beforeSnapshot[i][columnName];
      const afterValue = afterSnapshot[i][columnName];

      if (conversionFunction) {
        // Use custom comparison function for type conversions
        const isEqual = conversionFunction(beforeValue, afterValue);
        expect(
          isEqual,
          `Data mismatch at row ${i}: before=${beforeValue}, after=${afterValue}`
        ).toBe(true);
      } else {
        // For same-type comparisons, handle numeric types specially
        if (typeof beforeValue === "number" && typeof afterValue === "string") {
          // PostgreSQL returns numbers as strings, convert for comparison
          expect(parseInt(afterValue)).toEqual(beforeValue);
        } else if (
          typeof beforeValue === "string" &&
          typeof afterValue === "number"
        ) {
          expect(afterValue).toEqual(parseInt(beforeValue));
        } else {
          expect(afterValue).toEqual(beforeValue);
        }
      }
    }
  },

  /**
   * Insert test data with transaction safety
   */
  async insertTestDataSafely(
    client: Client,
    tableName: string,
    columnName: string,
    testData: (string | number)[],
    batchSize: number = 100
  ): Promise<void> {
    // Process in batches to avoid overwhelming the database
    for (let i = 0; i < testData.length; i += batchSize) {
      const batch = testData.slice(i, i + batchSize);

      await client.query("BEGIN");
      try {
        for (const value of batch) {
          await client.query(
            `INSERT INTO ${tableName} (${columnName}) VALUES (${value})`
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  },

  /**
   * Verify specific edge case values are handled correctly
   */
  async verifyEdgeCaseHandling(
    client: Client,
    tableName: string,
    columnName: string,
    edgeCases: Array<{ input: string; expected: any; description: string }>
  ): Promise<void> {
    for (const testCase of edgeCases) {
      // Insert edge case value
      await client.query(`DELETE FROM ${tableName}`); // Clear table
      await client.query(
        `INSERT INTO ${tableName} (${columnName}) VALUES (${testCase.input})`
      );

      // Verify the stored value
      const result = await client.query(
        `SELECT ${columnName} FROM ${tableName}`
      );
      const actualValue = result.rows[0][columnName];

      expect(actualValue, `Edge case failed: ${testCase.description}`).toEqual(
        testCase.expected
      );
    }
  },
};

/**
 * Error scenario testing utilities
 */
export const ErrorScenarioUtils = {
  /**
   * Test invalid data conversion scenarios
   */
  async testInvalidConversion(
    client: Client,
    services: ReturnType<typeof createColumnTestServices>,
    tableName: string,
    initialSQL: string,
    targetSQL: string,
    invalidData: string[],
    expectedErrorPattern: RegExp
  ): Promise<void> {
    // Setup table with invalid data
    await client.query(initialSQL);

    for (const invalidValue of invalidData) {
      await client.query(
        `INSERT INTO ${tableName} (test_column) VALUES (${invalidValue})`
      );
    }

    // Attempt migration and expect failure
    await EnhancedAssertions.assertMigrationFailure(
      executeColumnMigration(client, targetSQL, services),
      expectedErrorPattern,
      `Invalid data conversion test`
    );
  },

  /**
   * Test boundary value overflow scenarios
   */
  async testBoundaryOverflow(
    client: Client,
    services: ReturnType<typeof createColumnTestServices>,
    tableName: string,
    dataType: "integer" | "smallint" | "bigint",
    overflowValues: (string | number)[]
  ): Promise<void> {
    const typeMap = {
      integer: "INTEGER",
      smallint: "SMALLINT",
      bigint: "BIGINT",
    };

    const initialSQL = `CREATE TABLE ${tableName} (test_column VARCHAR(50))`;
    const targetSQL = `CREATE TABLE ${tableName} (test_column ${typeMap[dataType]})`;

    await this.testInvalidConversion(
      client,
      services,
      tableName,
      initialSQL,
      targetSQL,
      overflowValues.map((v) => `'${v}'`),
      /out of range|overflow|invalid input/i
    );
  },

  /**
   * Test concurrent migration scenarios
   */
  async testConcurrentModification(
    client1: Client,
    client2: Client,
    services: ReturnType<typeof createColumnTestServices>,
    tableName: string,
    migrationSQL: string
  ): Promise<void> {
    // Setup table
    await client1.query(
      `CREATE TABLE ${tableName} (id SERIAL, data VARCHAR(100))`
    );

    // Start migration on client1
    const migrationPromise = executeColumnMigration(
      client1,
      migrationSQL,
      services
    );

    // Attempt concurrent modification on client2
    try {
      await client2.query(
        `INSERT INTO ${tableName} (data) VALUES ('concurrent_insert')`
      );
    } catch (error) {
      // This is expected - concurrent modifications should be blocked during migration
    }

    // Wait for migration to complete
    await migrationPromise;

    // Verify table is in expected state
    const columns = await getTableColumns(client1, tableName);
    expect(columns.length).toBeGreaterThan(0);
  },
};

/**
 * Test scenario factories for common patterns
 */
export const TestScenarioFactory = {
  /**
   * Create a standard 4-step type conversion test
   */
  createTypeConversionTest(
    fromType: string,
    toType: string,
    testData: string[],
    expectedValues?: any[],
    shouldFail: boolean = false
  ) {
    return async (
      client: Client,
      services: ReturnType<typeof createColumnTestServices>,
      tableName: string
    ) => {
      // 1. Setup with specific edge case data
      const initialSQL = `CREATE TABLE ${tableName} (test_column ${fromType})`;
      await client.query(initialSQL);

      await DataIntegrityUtils.insertTestDataSafely(
        client,
        tableName,
        "test_column",
        testData
      );
      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        tableName
      );

      // 2. Execute conversion
      const targetSQL = `CREATE TABLE ${tableName} (test_column ${toType})`;

      if (shouldFail) {
        await EnhancedAssertions.assertMigrationFailure(
          executeColumnMigration(client, targetSQL, services),
          /conversion|invalid|out of range/i,
          `${fromType} → ${toType} conversion`
        );
        return;
      }

      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, targetSQL, services);
        }
      );

      // 3. Verify type change AND data integrity
      const finalColumns = await getTableColumns(client, tableName);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "test_column",
        toType.toLowerCase()
      );

      const afterSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        tableName
      );

      if (expectedValues) {
        await EnhancedAssertions.assertDataIntegrity(
          client,
          tableName,
          "test_column",
          expectedValues,
          `${fromType} → ${toType} conversion`
        );
      } else {
        // Default: verify row count preservation
        expect(afterSnapshot.length).toBe(beforeSnapshot.length);
      }

      // 4. Verify performance characteristics
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        5000, // 5 second maximum for basic conversions
        `${fromType} → ${toType} conversion`
      );
    };
  },

  /**
   * Create boundary value test scenario
   */
  createBoundaryValueTest(
    dataType: "integer" | "bigint" | "smallint" | "varchar"
  ) {
    return async (
      client: Client,
      services: ReturnType<typeof createColumnTestServices>,
      tableName: string
    ) => {
      const boundaryData =
        BoundaryValues[dataType === "varchar" ? "integer" : dataType];
      if (!boundaryData) return;

      const typeMap = {
        integer: "INTEGER",
        bigint: "BIGINT",
        smallint: "SMALLINT",
        varchar: "VARCHAR(50)",
      };

      // Test valid boundary values
      if ("valid" in boundaryData) {
        await client.query(
          `CREATE TABLE ${tableName} (test_column ${typeMap[dataType]})`
        );

        for (const value of boundaryData.valid) {
          await client.query(
            `INSERT INTO ${tableName} (test_column) VALUES (${value})`
          );
        }

        const result = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
        expect(parseInt(result.rows[0].count)).toBe(boundaryData.valid.length);
      }

      // Test overflow values (should fail)
      if ("overflow" in boundaryData && boundaryData.overflow) {
        await client.query(`DROP TABLE IF EXISTS ${tableName}`);
        await client.query(
          `CREATE TABLE ${tableName} (test_column VARCHAR(50))`
        );

        await ErrorScenarioUtils.testBoundaryOverflow(
          client,
          services,
          tableName,
          dataType as "integer" | "smallint" | "bigint",
          boundaryData.overflow
        );
      }
    };
  },

  /**
   * Create comprehensive edge case test
   */
  createEdgeCaseTest(testType: "unicode" | "boolean" | "invalid_numeric") {
    return async (
      client: Client,
      services: ReturnType<typeof createColumnTestServices>,
      tableName: string
    ) => {
      switch (testType) {
        case "unicode":
          await client.query(`CREATE TABLE ${tableName} (test_column TEXT)`);

          for (const unicodeValue of StringEdgeCases.unicode) {
            await client.query(
              `INSERT INTO ${tableName} (test_column) VALUES (${unicodeValue})`
            );
          }

          const result = await client.query(
            `SELECT COUNT(*) FROM ${tableName}`
          );
          expect(parseInt(result.rows[0].count)).toBe(
            StringEdgeCases.unicode.length
          );
          break;

        case "boolean":
          // Test valid boolean conversions
          const conversionTest = this.createTypeConversionTest(
            "VARCHAR(10)",
            "BOOLEAN",
            BooleanEdgeCases.validTrue.concat(BooleanEdgeCases.validFalse),
            // Expected: all true values become true, all false values become false
            Array(BooleanEdgeCases.validTrue.length)
              .fill(true)
              .concat(Array(BooleanEdgeCases.validFalse.length).fill(false))
          );
          await conversionTest(client, services, tableName);
          break;

        case "invalid_numeric":
          await ErrorScenarioUtils.testInvalidConversion(
            client,
            services,
            tableName,
            `CREATE TABLE ${tableName} (test_column VARCHAR(50))`,
            `CREATE TABLE ${tableName} (test_column INTEGER)`,
            InvalidData.nonNumeric,
            /invalid input syntax|could not convert/i
          );
          break;
      }
    };
  },
};
