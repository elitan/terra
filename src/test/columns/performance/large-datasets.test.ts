import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "../../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  PerformanceUtils,
  DataIntegrityUtils,
  EnhancedAssertions,
} from "../column-test-utils";
import {
  PerformanceTestData,
  LargeDatasetGenerators,
} from "../test-data-generators";

describe("Large Dataset Migration Performance", () => {
  let client: Client;
  let services: ReturnType<typeof createColumnTestServices>;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    services = createColumnTestServices();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("VARCHAR Type Conversions with Large Datasets", () => {
    test("should handle medium dataset VARCHAR to TEXT conversion efficiently", async () => {
      const tableName = "varchar_conversion_test";
      const dataSize = PerformanceTestData.medium.size; // 10,000 records

      // 1. Setup: Create table and populate with test data
      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column VARCHAR(255)
        );
      `);

      const testData = PerformanceTestData.medium.varchar;
      await DataIntegrityUtils.insertTestDataSafely(
        client,
        tableName,
        "test_column",
        testData,
        500 // Batch size
      );

      // Capture initial snapshot
      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        tableName,
        "id"
      );

      // 2. Execute migration with performance measurement
      const desiredSQL = `
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column TEXT
        );
      `;

      const { duration: migrationTime } =
        await PerformanceUtils.measureMigrationTime(async () => {
          await executeColumnMigration(client, desiredSQL, services);
        });

      // 3. Verify data integrity
      const result = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
      const finalRowCount = parseInt(result.rows[0].count);
      expect(finalRowCount).toBe(dataSize);

      const afterSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        tableName,
        "id"
      );

      await DataIntegrityUtils.verifyDataPreservation(
        beforeSnapshot,
        afterSnapshot,
        "test_column"
      );

      // 4. Verify column type change
      const finalColumns = await getTableColumns(client, tableName);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "test_column",
        "text",
        "medium dataset VARCHAR to TEXT"
      );

      // 5. Performance assertions (should complete within reasonable time)
      PerformanceUtils.assertPerformanceWithinBounds(
        migrationTime,
        30000, // 30 seconds for 10K records
        "medium dataset VARCHAR to TEXT conversion"
      );

      console.log(
        `Medium dataset migration completed in ${migrationTime.toFixed(2)}ms`
      );
    });

    test("should handle large dataset VARCHAR to TEXT conversion", async () => {
      const tableName = "large_varchar_test";
      const dataSize = 25000; // Use smaller dataset for testing: 25,000 records

      // 1. Setup table
      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column VARCHAR(500)
        );
      `);

      // 2. Populate with large dataset
      const testData = Array.from(
        { length: dataSize },
        (_, i) => `'large_test_${i}'`
      );

      const populationStart = performance.now();
      await DataIntegrityUtils.insertTestDataSafely(
        client,
        tableName,
        "test_column",
        testData,
        1000 // Larger batch size for efficiency
      );
      const populationTime = performance.now() - populationStart;

      console.log(
        `Data population completed in ${populationTime.toFixed(2)}ms`
      );

      // 3. Execute migration
      const desiredSQL = `
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column TEXT
        );
      `;

      const { duration: migrationTime } =
        await PerformanceUtils.measureMigrationTime(async () => {
          await executeColumnMigration(client, desiredSQL, services);
        });

      // 4. Verify results
      const result = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
      const finalRowCount = parseInt(result.rows[0].count);
      expect(finalRowCount).toBe(dataSize);

      const finalColumns = await getTableColumns(client, tableName);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "test_column",
        "text",
        "large dataset VARCHAR to TEXT"
      );

      // 5. Performance assertions (more lenient for large dataset)
      PerformanceUtils.assertPerformanceWithinBounds(
        migrationTime,
        60000, // 1 minute for 25K records
        "large dataset VARCHAR to TEXT conversion"
      );

      console.log(
        `Large dataset migration completed in ${migrationTime.toFixed(2)}ms`
      );
      console.log(
        `Migration rate: ${(dataSize / (migrationTime / 1000)).toFixed(
          0
        )} records/second`
      );
    });
  });

  describe("Numeric Type Conversions with Large Datasets", () => {
    test("should handle medium dataset INTEGER to BIGINT conversion", async () => {
      const tableName = "int_to_bigint_test";
      const dataSize = PerformanceTestData.medium.size;

      // 1. Setup
      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column INTEGER
        );
      `);

      const testData = PerformanceTestData.medium.integer;
      await DataIntegrityUtils.insertTestDataSafely(
        client,
        tableName,
        "test_column",
        testData
      );

      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        tableName,
        "id"
      );

      // 2. Execute migration
      const desiredSQL = `
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column BIGINT
        );
      `;

      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 3. Verify
      const afterSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        tableName,
        "id"
      );

      await DataIntegrityUtils.verifyDataPreservation(
        beforeSnapshot,
        afterSnapshot,
        "test_column",
        (before, after) => parseInt(before) === parseInt(after)
      );

      const finalColumns = await getTableColumns(client, tableName);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "test_column",
        "bigint",
        "medium dataset INTEGER to BIGINT"
      );

      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        20000, // 20 seconds
        "medium dataset INTEGER to BIGINT conversion"
      );

      console.log(
        `Integer to BIGINT migration completed in ${duration.toFixed(2)}ms`
      );
    });

    test("should handle large dataset DECIMAL precision changes", async () => {
      const tableName = "decimal_precision_test";
      const dataSize = 15000; // Use smaller dataset: 15,000 records

      // 1. Setup
      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column DECIMAL(10,2)
        );
      `);

      const testData = Array.from(
        { length: dataSize },
        (_, i) => `${(i * 12.34).toFixed(2)}`
      );
      await DataIntegrityUtils.insertTestDataSafely(
        client,
        tableName,
        "test_column",
        testData,
        1000
      );

      // 2. Execute migration - increase precision
      const desiredSQL = `
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column DECIMAL(15,4)
        );
      `;

      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 3. Verify
      const finalColumns = await getTableColumns(client, tableName);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "test_column",
        "numeric",
        "large dataset DECIMAL precision change"
      );

      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        60000, // 1 minute for 15K decimal records
        "large dataset DECIMAL precision change"
      );

      // Verify row count maintained
      const result = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
      expect(parseInt(result.rows[0].count)).toBe(dataSize);

      console.log(
        `DECIMAL precision migration completed in ${duration.toFixed(2)}ms`
      );
    });
  });

  describe("Mixed Column Type Performance", () => {
    test("should handle multi-column conversion on large dataset", async () => {
      const tableName = "multi_column_test";
      const dataSize = 10000; // Reduced dataset for testing

      // 1. Setup table with multiple columns
      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          varchar_col VARCHAR(255),
          int_col INTEGER,
          decimal_col DECIMAL(8,2)
        );
      `);

      // 2. Populate with mixed data
      const mixedData = LargeDatasetGenerators.generateMixedDataset(dataSize);

      const populationStart = performance.now();
      for (const batch of chunkArray(mixedData, 500)) {
        await client.query("BEGIN");
        try {
          for (const row of batch) {
            await client.query(`
              INSERT INTO ${tableName} (varchar_col, int_col, decimal_col) 
              VALUES (${row.varchar_col}, ${row.int_col}, ${row.decimal_col})
            `);
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      const populationTime = performance.now() - populationStart;

      // 3. Execute multi-column migration
      const desiredSQL = `
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          varchar_col TEXT,
          int_col BIGINT,
          decimal_col DECIMAL(12,4)
        );
      `;

      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify all columns changed correctly
      const finalColumns = await getTableColumns(client, tableName);

      EnhancedAssertions.assertColumnType(
        finalColumns,
        "varchar_col",
        "text",
        "multi-column conversion"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "int_col",
        "bigint",
        "multi-column conversion"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "decimal_col",
        "numeric",
        "multi-column conversion"
      );

      // 5. Performance verification
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        90000, // 1.5 minutes for multi-column 10K dataset
        "multi-column large dataset conversion"
      );

      // Verify data integrity
      const result = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
      expect(parseInt(result.rows[0].count)).toBe(dataSize);

      console.log(`Population time: ${populationTime.toFixed(2)}ms`);
      console.log(
        `Multi-column migration completed in ${duration.toFixed(2)}ms`
      );
      console.log(
        `Total processing rate: ${(
          dataSize /
          ((populationTime + duration) / 1000)
        ).toFixed(0)} records/second`
      );
    });
  });

  describe("Performance Baseline Establishment", () => {
    test("should establish baseline for small dataset operations", async () => {
      const benchmarks: Record<string, number> = {};
      const tableName = "baseline_test";
      const dataSize = PerformanceTestData.small.size; // 100 records

      // Test VARCHAR to TEXT
      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column VARCHAR(255)
        );
      `);

      const testData = PerformanceTestData.small.varchar;
      await DataIntegrityUtils.insertTestDataSafely(
        client,
        tableName,
        "test_column",
        testData
      );

      const { duration: varcharToTextTime } =
        await PerformanceUtils.measureMigrationTime(async () => {
          await executeColumnMigration(
            client,
            `
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            test_column TEXT
          );
        `,
            services
          );
        });

      benchmarks["varchar_to_text_small"] = varcharToTextTime;

      // Clean up for next test
      await client.query(`DROP TABLE ${tableName}`);

      // Test INTEGER to BIGINT
      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column INTEGER
        );
      `);

      const intTestData = PerformanceTestData.small.integer;
      await DataIntegrityUtils.insertTestDataSafely(
        client,
        tableName,
        "test_column",
        intTestData
      );

      const { duration: intToBigintTime } =
        await PerformanceUtils.measureMigrationTime(async () => {
          await executeColumnMigration(
            client,
            `
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            test_column BIGINT
          );
        `,
            services
          );
        });

      benchmarks["integer_to_bigint_small"] = intToBigintTime;

      // Log benchmarks for future reference
      console.log("Performance Baselines (100 records):");
      console.log(
        `VARCHAR → TEXT: ${benchmarks.varchar_to_text_small.toFixed(2)}ms`
      );
      console.log(
        `INTEGER → BIGINT: ${benchmarks.integer_to_bigint_small.toFixed(2)}ms`
      );

      // Assert reasonable performance (these are generous bounds for small datasets)
      expect(benchmarks.varchar_to_text_small).toBeLessThan(5000); // 5 seconds
      expect(benchmarks.integer_to_bigint_small).toBeLessThan(3000); // 3 seconds
    });
  });
});

/**
 * Utility function to chunk arrays for batch processing
 */
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}
