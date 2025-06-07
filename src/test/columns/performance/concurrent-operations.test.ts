import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "../../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  PerformanceUtils,
  DataIntegrityUtils,
  EnhancedAssertions,
  ErrorScenarioUtils,
} from "../column-test-utils";
import { PerformanceTestData } from "../test-data-generators";

describe("Concurrent Operations and Lock Management", () => {
  let client1: Client;
  let client2: Client;
  let services: ReturnType<typeof createColumnTestServices>;

  beforeEach(async () => {
    client1 = await createTestClient();
    client2 = await createTestClient();
    await cleanDatabase(client1);
    services = createColumnTestServices();
  });

  afterEach(async () => {
    await cleanDatabase(client1);
    await client1.end();
    await client2.end();
  });

  describe("Lock Time Minimization", () => {
    test("should minimize lock time during VARCHAR to TEXT conversion", async () => {
      const tableName = "lock_time_test";

      // 1. Setup table with medium dataset
      await client1.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column VARCHAR(255),
          metadata TEXT DEFAULT 'test'
        );
      `);

      const testData = PerformanceTestData.medium.varchar;
      await DataIntegrityUtils.insertTestDataSafely(
        client1,
        tableName,
        "test_column",
        testData
      );

      // 2. Start monitoring lock duration
      let lockStartTime: number;
      let lockEndTime: number;
      let migrationComplete = false;

      // Start migration in background
      const migrationPromise = (async () => {
        const desiredSQL = `
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            test_column TEXT,
            metadata TEXT DEFAULT 'test'
          );
        `;

        lockStartTime = performance.now();
        await executeColumnMigration(client1, desiredSQL, services);
        lockEndTime = performance.now();
        migrationComplete = true;
      })();

      // 3. Attempt concurrent operations during migration
      let concurrentOperationBlocked = false;
      let concurrentOperationTime: number;

      const concurrentPromise = (async () => {
        // Wait a small moment for migration to start
        await new Promise((resolve) => setTimeout(resolve, 100));

        const concurrentStart = performance.now();
        try {
          // Try to read from the table during migration
          await client2.query(`SELECT COUNT(*) FROM ${tableName}`);
          concurrentOperationTime = performance.now() - concurrentStart;
        } catch (error) {
          concurrentOperationBlocked = true;
          // If blocked, wait for migration to complete then retry
          while (!migrationComplete) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await client2.query(`SELECT COUNT(*) FROM ${tableName}`);
          concurrentOperationTime = performance.now() - concurrentStart;
        }
      })();

      // 4. Wait for both operations to complete
      await Promise.all([migrationPromise, concurrentPromise]);

      // 5. Verify results
      const lockDuration = lockEndTime! - lockStartTime!;

      // Lock time should be minimal (less than 5 seconds for medium dataset)
      PerformanceUtils.assertPerformanceWithinBounds(
        lockDuration,
        5000,
        "exclusive lock duration during VARCHAR to TEXT conversion"
      );

      // Verify the migration succeeded
      const finalColumns = await getTableColumns(client1, tableName);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "test_column",
        "text",
        "concurrent lock time test"
      );

      console.log(`Lock duration: ${lockDuration.toFixed(2)}ms`);
      console.log(
        `Concurrent operation time: ${concurrentOperationTime!.toFixed(2)}ms`
      );
      console.log(
        `Concurrent operation blocked: ${concurrentOperationBlocked}`
      );
    });

    test("should allow concurrent reads during compatible type changes", async () => {
      const tableName = "concurrent_reads_test";

      // 1. Setup
      await client1.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column INTEGER,
          read_column VARCHAR(100) DEFAULT 'readable'
        );
      `);

      const testData = PerformanceTestData.small.integer;
      await DataIntegrityUtils.insertTestDataSafely(
        client1,
        tableName,
        "test_column",
        testData
      );

      // 2. Start migration
      const migrationPromise = (async () => {
        const desiredSQL = `
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            test_column BIGINT,
            read_column VARCHAR(100) DEFAULT 'readable'
          );
        `;

        await executeColumnMigration(client1, desiredSQL, services);
      })();

      // 3. Perform concurrent reads
      const readResults: number[] = [];
      const concurrentReads = async () => {
        const readCount = 5;
        for (let i = 0; i < readCount; i++) {
          const start = performance.now();
          const result = await client2.query(
            `SELECT COUNT(*) FROM ${tableName}`
          );
          const duration = performance.now() - start;
          readResults.push(duration);

          expect(parseInt(result.rows[0].count)).toBe(testData.length);

          // Brief pause between reads
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };

      // 4. Execute both operations
      await Promise.all([migrationPromise, concurrentReads()]);

      // 5. Verify concurrent reads were not severely impacted
      const avgReadTime =
        readResults.reduce((a, b) => a + b, 0) / readResults.length;

      // Reads should remain fast (under 100ms each on average)
      expect(avgReadTime).toBeLessThan(100);

      console.log(`Average concurrent read time: ${avgReadTime.toFixed(2)}ms`);
      console.log(
        `Read times: ${readResults.map((t) => t.toFixed(1)).join(", ")}ms`
      );
    });
  });

  describe("Concurrent Modification Scenarios", () => {
    test("should handle concurrent data modifications during migration", async () => {
      const tableName = "concurrent_modification_test";

      // 1. Setup
      await client1.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column VARCHAR(255),
          last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      const initialData = PerformanceTestData.small.varchar;
      await DataIntegrityUtils.insertTestDataSafely(
        client1,
        tableName,
        "test_column",
        initialData
      );

      const initialCount = await client1.query(
        `SELECT COUNT(*) FROM ${tableName}`
      );
      const expectedInitialCount = parseInt(initialCount.rows[0].count);

      // 2. Start migration
      let migrationError: any = null;
      const migrationPromise = (async () => {
        try {
          const desiredSQL = `
            CREATE TABLE ${tableName} (
              id SERIAL PRIMARY KEY,
              test_column TEXT,
              last_modified TIMESTAMP DEFAULT NOW()
            );
          `;

          await executeColumnMigration(client1, desiredSQL, services);
        } catch (error) {
          migrationError = error as Error;
        }
      })();

      // 3. Attempt concurrent modifications
      let concurrentModificationError: any = null;
      const modificationPromise = (async () => {
        // Wait briefly for migration to start
        await new Promise((resolve) => setTimeout(resolve, 50));

        try {
          // Try to insert new data during migration
          await client2.query(`
            INSERT INTO ${tableName} (test_column) VALUES ('concurrent_insert')
          `);

          // Try to update existing data
          await client2.query(`
            UPDATE ${tableName} SET last_modified = NOW() WHERE id = 1
          `);
        } catch (error) {
          concurrentModificationError = error as Error;
        }
      })();

      // 4. Wait for completion
      await Promise.all([migrationPromise, modificationPromise]);

      // 5. Verify results
      if (migrationError) {
        // If migration failed due to concurrent modification, that's acceptable
        console.log(
          `Migration failed due to concurrent modification: ${migrationError.message}`
        );
        expect(migrationError.message).toMatch(
          /lock|concurrent|conflict|syntax/i
        );
      } else {
        // If migration succeeded, verify the final state
        const finalColumns = await getTableColumns(client1, tableName);
        EnhancedAssertions.assertColumnType(
          finalColumns,
          "test_column",
          "text",
          "concurrent modification test"
        );

        // Check final row count
        const finalCount = await client1.query(
          `SELECT COUNT(*) FROM ${tableName}`
        );
        const actualFinalCount = parseInt(finalCount.rows[0].count);

        // Count should be initial + any successful concurrent inserts
        expect(actualFinalCount).toBeGreaterThanOrEqual(expectedInitialCount);
        console.log(
          `Final row count: ${actualFinalCount} (initial: ${expectedInitialCount})`
        );
      }

      if (concurrentModificationError) {
        console.log(
          `Concurrent modification handled: ${concurrentModificationError.message}`
        );
      }
    });

    test("should properly serialize competing schema modifications", async () => {
      const tableName = "schema_serialization_test";

      // 1. Setup
      await client1.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          col1 VARCHAR(255),
          col2 INTEGER
        );
      `);

      const testData = PerformanceTestData.small.varchar;
      await DataIntegrityUtils.insertTestDataSafely(
        client1,
        tableName,
        "col1",
        testData
      );

      // 2. Attempt two competing schema changes
      let migration1Error: any = null;
      let migration2Error: any = null;

      const migration1Promise = (async () => {
        try {
          // Migration 1: Change col1 to TEXT
          const desiredSQL1 = `
            CREATE TABLE ${tableName} (
              id SERIAL PRIMARY KEY,
              col1 TEXT,
              col2 INTEGER
            );
          `;

          await executeColumnMigration(client1, desiredSQL1, services);
        } catch (error) {
          migration1Error = error as Error;
        }
      })();

      const migration2Promise = (async () => {
        try {
          // Migration 2: Change col2 to BIGINT (using different client)
          const services2 = createColumnTestServices();
          const desiredSQL2 = `
            CREATE TABLE ${tableName} (
              id SERIAL PRIMARY KEY,
              col1 VARCHAR(255),
              col2 BIGINT
            );
          `;

          await executeColumnMigration(client2, desiredSQL2, services2);
        } catch (error) {
          migration2Error = error as Error;
        }
      })();

      // 3. Wait for completion
      await Promise.all([migration1Promise, migration2Promise]);

      // 4. Verify serialization behavior
      // At least one migration should succeed, and verify the final state
      const migration1Succeeded = !migration1Error;
      const migration2Succeeded = !migration2Error;

      // At least one should succeed
      expect(migration1Succeeded || migration2Succeeded).toBe(true);

      console.log(
        `Migration 1 (VARCHAR→TEXT): ${
          migration1Succeeded ? "succeeded" : "failed"
        }`
      );
      console.log(
        `Migration 2 (INTEGER→BIGINT): ${
          migration2Succeeded ? "succeeded" : "failed"
        }`
      );
      if (migration1Error)
        console.log(`Migration 1 error: ${migration1Error.message}`);
      if (migration2Error)
        console.log(`Migration 2 error: ${migration2Error.message}`);

      const finalColumns = await getTableColumns(client1, tableName);

      // Verify based on which migrations actually succeeded
      if (migration1Succeeded && migration2Succeeded) {
        // Both migrations succeeded - both changes should be applied
        EnhancedAssertions.assertColumnType(
          finalColumns,
          "col1",
          "text",
          "serialization test - both succeeded"
        );
        EnhancedAssertions.assertColumnType(
          finalColumns,
          "col2",
          "bigint",
          "serialization test - both succeeded"
        );
      } else if (migration1Succeeded && !migration2Succeeded) {
        // Only migration 1 succeeded
        EnhancedAssertions.assertColumnType(
          finalColumns,
          "col1",
          "text",
          "serialization test - migration 1 only"
        );
        EnhancedAssertions.assertColumnType(
          finalColumns,
          "col2",
          "integer",
          "serialization test - migration 1 only"
        );
      } else if (!migration1Succeeded && migration2Succeeded) {
        // Only migration 2 succeeded
        EnhancedAssertions.assertColumnType(
          finalColumns,
          "col1",
          "character varying",
          "serialization test - migration 2 only"
        );
        EnhancedAssertions.assertColumnType(
          finalColumns,
          "col2",
          "bigint",
          "serialization test - migration 2 only"
        );
      }
    });
  });

  describe("Lock Timeout and Recovery", () => {
    test("should handle lock timeouts gracefully", async () => {
      const tableName = "lock_timeout_test";

      // 1. Setup
      await client1.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column VARCHAR(255)
        );
      `);

      const testData = PerformanceTestData.small.varchar;
      await DataIntegrityUtils.insertTestDataSafely(
        client1,
        tableName,
        "test_column",
        testData
      );

      // 2. Set a short lock timeout for testing
      await client2.query("SET lock_timeout = '2s'");

      // 3. Acquire a long-running lock on client1
      await client1.query("BEGIN");
      await client1.query(`SELECT * FROM ${tableName} FOR UPDATE`);

      // 4. Try migration on client2 (should timeout)
      let timeoutError: Error | null = null;

      try {
        const desiredSQL = `
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            test_column TEXT
          );
        `;

        await executeColumnMigration(client2, desiredSQL, services);
      } catch (error) {
        timeoutError = error as Error;
      }

      // 5. Release the lock
      await client1.query("ROLLBACK");

      // 6. Verify timeout behavior
      expect(timeoutError).not.toBeNull();
      expect(timeoutError!.message).toMatch(/timeout|lock/i);

      console.log(`Lock timeout handled: ${timeoutError!.message}`);

      // 7. Verify that migration can succeed after lock is released
      const desiredSQL = `
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column TEXT
        );
      `;

      // This should now succeed
      await executeColumnMigration(client2, desiredSQL, services);

      const finalColumns = await getTableColumns(client2, tableName);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "test_column",
        "text",
        "lock timeout recovery"
      );
    });
  });

  describe("Performance Under Concurrent Load", () => {
    test("should maintain performance with concurrent read load", async () => {
      const tableName = "concurrent_load_test";

      // 1. Setup with larger dataset
      await client1.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column VARCHAR(255),
          load_test_data TEXT DEFAULT 'concurrent load test data'
        );
      `);

      const testData = PerformanceTestData.medium.varchar; // 10K records
      await DataIntegrityUtils.insertTestDataSafely(
        client1,
        tableName,
        "test_column",
        testData,
        500
      );

      // 2. Start migration with performance measurement
      let migrationDuration: number;
      const migrationPromise = (async () => {
        const desiredSQL = `
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            test_column TEXT,
            load_test_data TEXT DEFAULT 'concurrent load test data'
          );
        `;

        const { duration } = await PerformanceUtils.measureMigrationTime(
          async () => {
            await executeColumnMigration(client1, desiredSQL, services);
          }
        );

        migrationDuration = duration;
      })();

      // 3. Generate concurrent read load
      const readLoadPromise = (async () => {
        const readOperations = [];
        const numberOfReads = 20;

        for (let i = 0; i < numberOfReads; i++) {
          readOperations.push(
            (async () => {
              await new Promise((resolve) =>
                setTimeout(resolve, Math.random() * 100)
              );

              try {
                const result = await client2.query(`
                SELECT COUNT(*), AVG(LENGTH(test_column)) 
                FROM ${tableName} 
                WHERE test_column IS NOT NULL
              `);
                return result.rows[0];
              } catch (error) {
                // Some reads might fail during migration, that's acceptable
                return null;
              }
            })()
          );
        }

        const results = await Promise.all(readOperations);
        const successfulReads = results.filter((r) => r !== null);

        console.log(
          `Successful concurrent reads: ${successfulReads.length}/${numberOfReads}`
        );
        return successfulReads;
      })();

      // 4. Wait for completion
      const [, readResults] = await Promise.all([
        migrationPromise,
        readLoadPromise,
      ]);

      // 5. Verify performance wasn't severely degraded
      PerformanceUtils.assertPerformanceWithinBounds(
        migrationDuration!,
        60000, // 1 minute (allowing for some degradation due to concurrent load)
        "migration under concurrent read load"
      );

      // Verify final state
      const finalColumns = await getTableColumns(client1, tableName);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "test_column",
        "text",
        "concurrent load test"
      );

      // Verify data integrity maintained
      const finalCount = await client1.query(
        `SELECT COUNT(*) FROM ${tableName}`
      );
      expect(parseInt(finalCount.rows[0].count)).toBe(testData.length);

      console.log(
        `Migration completed in ${migrationDuration!.toFixed(
          2
        )}ms under concurrent load`
      );
      console.log(
        `Concurrent read success rate: ${(
          (readResults.length / 20) *
          100
        ).toFixed(1)}%`
      );
    });
  });
});
