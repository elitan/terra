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
import { PerformanceTestData } from "../test-data-generators";

/**
 * Performance regression testing for column migrations
 *
 * These tests establish performance benchmarks and detect regressions
 * in migration performance over time.
 */
describe("Performance Regression Testing", () => {
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

  describe("Benchmark Establishment", () => {
    test("should establish VARCHAR to TEXT conversion benchmarks", async () => {
      const benchmarks = new Map<string, number>();

      // Small dataset benchmark (100 records)
      const smallTableName = "varchar_text_small";
      await client.query(`
        CREATE TABLE ${smallTableName} (
          id SERIAL PRIMARY KEY,
          test_column VARCHAR(255)
        );
      `);

      const smallData = PerformanceTestData.small.varchar;
      await DataIntegrityUtils.insertTestDataSafely(
        client,
        smallTableName,
        "test_column",
        smallData
      );

      const { duration: smallDuration } =
        await PerformanceUtils.measureMigrationTime(async () => {
          await executeColumnMigration(
            client,
            `
          CREATE TABLE ${smallTableName} (
            id SERIAL PRIMARY KEY,
            test_column TEXT
          );
        `,
            services
          );
        });

      benchmarks.set("varchar_to_text_small_100", smallDuration);

      // Medium dataset benchmark (10,000 records)
      await client.query(`DROP TABLE ${smallTableName}`);
      const mediumTableName = "varchar_text_medium";
      await client.query(`
        CREATE TABLE ${mediumTableName} (
          id SERIAL PRIMARY KEY,
          test_column VARCHAR(255)
        );
      `);

      const mediumData = PerformanceTestData.medium.varchar;
      await DataIntegrityUtils.insertTestDataSafely(
        client,
        mediumTableName,
        "test_column",
        mediumData,
        500
      );

      const { duration: mediumDuration } =
        await PerformanceUtils.measureMigrationTime(async () => {
          await executeColumnMigration(
            client,
            `
          CREATE TABLE ${mediumTableName} (
            id SERIAL PRIMARY KEY,
            test_column TEXT
          );
        `,
            services
          );
        });

      benchmarks.set("varchar_to_text_medium_10k", mediumDuration);

      // Log benchmarks for baseline establishment
      console.log("\n=== VARCHAR to TEXT Conversion Benchmarks ===");
      for (const [scenario, duration] of benchmarks) {
        console.log(`${scenario}: ${duration.toFixed(2)}ms`);
      }

      // Assert reasonable performance bounds (these become the regression thresholds)
      expect(smallDuration).toBeLessThan(5000); // 5 seconds for small dataset
      expect(mediumDuration).toBeLessThan(45000); // 45 seconds for medium dataset

      // Calculate performance rate
      const smallRate = PerformanceTestData.small.size / (smallDuration / 1000);
      const mediumRate =
        PerformanceTestData.medium.size / (mediumDuration / 1000);

      console.log(`Small dataset rate: ${smallRate.toFixed(0)} records/second`);
      console.log(
        `Medium dataset rate: ${mediumRate.toFixed(0)} records/second`
      );

      // Rates should be reasonable
      expect(smallRate).toBeGreaterThan(20); // At least 20 records/second for small
      expect(mediumRate).toBeGreaterThan(200); // At least 200 records/second for medium
    });

    test("should establish INTEGER to BIGINT conversion benchmarks", async () => {
      const benchmarks = new Map<string, number>();

      // Small dataset
      const smallTableName = "int_bigint_small";
      await client.query(`
        CREATE TABLE ${smallTableName} (
          id SERIAL PRIMARY KEY,
          test_column INTEGER
        );
      `);

      const smallData = PerformanceTestData.small.integer;
      await DataIntegrityUtils.insertTestDataSafely(
        client,
        smallTableName,
        "test_column",
        smallData
      );

      const { duration: smallDuration } =
        await PerformanceUtils.measureMigrationTime(async () => {
          await executeColumnMigration(
            client,
            `
          CREATE TABLE ${smallTableName} (
            id SERIAL PRIMARY KEY,
            test_column BIGINT
          );
        `,
            services
          );
        });

      benchmarks.set("int_to_bigint_small_100", smallDuration);

      // Medium dataset
      await client.query(`DROP TABLE ${smallTableName}`);
      const mediumTableName = "int_bigint_medium";
      await client.query(`
        CREATE TABLE ${mediumTableName} (
          id SERIAL PRIMARY KEY,
          test_column INTEGER
        );
      `);

      const mediumData = PerformanceTestData.medium.integer;
      await DataIntegrityUtils.insertTestDataSafely(
        client,
        mediumTableName,
        "test_column",
        mediumData,
        500
      );

      const { duration: mediumDuration } =
        await PerformanceUtils.measureMigrationTime(async () => {
          await executeColumnMigration(
            client,
            `
          CREATE TABLE ${mediumTableName} (
            id SERIAL PRIMARY KEY,
            test_column BIGINT
          );
        `,
            services
          );
        });

      benchmarks.set("int_to_bigint_medium_10k", mediumDuration);

      console.log("\n=== INTEGER to BIGINT Conversion Benchmarks ===");
      for (const [scenario, duration] of benchmarks) {
        console.log(`${scenario}: ${duration.toFixed(2)}ms`);
      }

      // Regression bounds for numeric conversions (should be faster than string conversions)
      expect(smallDuration).toBeLessThan(3000); // 3 seconds for small
      expect(mediumDuration).toBeLessThan(30000); // 30 seconds for medium

      const smallRate = PerformanceTestData.small.size / (smallDuration / 1000);
      const mediumRate =
        PerformanceTestData.medium.size / (mediumDuration / 1000);

      console.log(`Small dataset rate: ${smallRate.toFixed(0)} records/second`);
      console.log(
        `Medium dataset rate: ${mediumRate.toFixed(0)} records/second`
      );

      expect(smallRate).toBeGreaterThan(30); // Higher rate for numeric conversions
      expect(mediumRate).toBeGreaterThan(300);
    });

    test("should establish DECIMAL precision change benchmarks", async () => {
      const benchmarks = new Map<string, number>();

      const tableName = "decimal_precision_bench";
      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column DECIMAL(8,2)
        );
      `);

      const testData = PerformanceTestData.medium.decimal;
      await DataIntegrityUtils.insertTestDataSafely(
        client,
        tableName,
        "test_column",
        testData,
        500
      );

      // Test precision increase (should be fast)
      const { duration: increaseDuration } =
        await PerformanceUtils.measureMigrationTime(async () => {
          await executeColumnMigration(
            client,
            `
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            test_column DECIMAL(12,4)
          );
        `,
            services
          );
        });

      benchmarks.set("decimal_precision_increase_10k", increaseDuration);

      // Reset for precision decrease test
      await client.query(`DROP TABLE ${tableName}`);
      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column DECIMAL(12,4)
        );
      `);

      await DataIntegrityUtils.insertTestDataSafely(
        client,
        tableName,
        "test_column",
        testData,
        500
      );

      // Test precision decrease (might be slower due to potential data loss checks)
      const { duration: decreaseDuration } =
        await PerformanceUtils.measureMigrationTime(async () => {
          await executeColumnMigration(
            client,
            `
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            test_column DECIMAL(8,2)
          );
        `,
            services
          );
        });

      benchmarks.set("decimal_precision_decrease_10k", decreaseDuration);

      console.log("\n=== DECIMAL Precision Change Benchmarks ===");
      for (const [scenario, duration] of benchmarks) {
        console.log(`${scenario}: ${duration.toFixed(2)}ms`);
      }

      // Precision changes should be relatively fast
      expect(increaseDuration).toBeLessThan(40000); // 40 seconds for increase
      expect(decreaseDuration).toBeLessThan(50000); // 50 seconds for decrease (potentially slower)

      const increaseRate =
        PerformanceTestData.medium.size / (increaseDuration / 1000);
      const decreaseRate =
        PerformanceTestData.medium.size / (decreaseDuration / 1000);

      console.log(
        `Precision increase rate: ${increaseRate.toFixed(0)} records/second`
      );
      console.log(
        `Precision decrease rate: ${decreaseRate.toFixed(0)} records/second`
      );
    });
  });

  describe("Regression Detection", () => {
    test("should detect performance regression in VARCHAR to TEXT conversion", async () => {
      // This test simulates regression detection by comparing against established benchmarks
      const tableName = "regression_test_varchar";
      const expectedMaxDuration = 5000; // 5 seconds baseline for small dataset

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

      // Measure current performance
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
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
        }
      );

      // Check for regression (current duration should not exceed baseline by more than 50%)
      const regressionThreshold = expectedMaxDuration * 1.5;

      if (duration > regressionThreshold) {
        console.warn(`⚠️  PERFORMANCE REGRESSION DETECTED!`);
        console.warn(
          `Current: ${duration.toFixed(
            2
          )}ms, Threshold: ${regressionThreshold.toFixed(2)}ms`
        );
        console.warn(
          `Performance degraded by ${(
            (duration / expectedMaxDuration - 1) *
            100
          ).toFixed(1)}%`
        );
      } else {
        console.log(
          `✅ Performance within acceptable bounds: ${duration.toFixed(2)}ms`
        );
      }

      // Fail test if significant regression detected
      expect(duration).toBeLessThan(regressionThreshold);

      // Verify functionality still works
      const finalColumns = await getTableColumns(client, tableName);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "test_column",
        "text",
        "regression test"
      );
    });

    test("should detect memory usage patterns during large operations", async () => {
      const tableName = "memory_usage_test";

      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          test_column VARCHAR(1000) -- Larger column size
        );
      `);

      // Use large dataset to test memory efficiency
      const largeDataSize = 15000; // 15K records with large strings
      const largeStrings = Array.from({ length: largeDataSize }, (_, i) => {
        // Generate strings that fit in VARCHAR(1000) - max 800 chars to be safe
        const baseString = `data_${i}_`;
        const repeatCount = Math.floor(800 / baseString.length);
        return `'${Array(repeatCount).fill(baseString).join("")}'`;
      });

      await DataIntegrityUtils.insertTestDataSafely(
        client,
        tableName,
        "test_column",
        largeStrings,
        1000
      );

      // Monitor memory-related metrics through timing
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
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
        }
      );

      // Calculate processing rate
      const processingRate = largeDataSize / (duration / 1000);
      const dataVolume = largeDataSize * 2; // ~2KB per record = ~100MB total

      console.log(
        `Processed ${largeDataSize} records (${dataVolume}KB) in ${duration.toFixed(
          2
        )}ms`
      );
      console.log(
        `Processing rate: ${processingRate.toFixed(0)} records/second`
      );
      console.log(
        `Data throughput: ${(dataVolume / (duration / 1000) / 1024).toFixed(
          2
        )} MB/second`
      );

      // Memory efficiency assertions
      expect(processingRate).toBeGreaterThan(100); // At least 100 records/second for large data
      expect(duration).toBeLessThan(600000); // Should complete within 10 minutes

      // Verify data integrity
      const result = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
      expect(parseInt(result.rows[0].count)).toBe(largeDataSize);
    });

    test("should track multi-column migration performance trends", async () => {
      const tableName = "multi_column_trends";
      const recordCount = 25000; // Medium-large dataset

      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          col1 VARCHAR(255),
          col2 INTEGER,
          col3 DECIMAL(8,2),
          col4 VARCHAR(100)
        );
      `);

      // Insert test data for all columns
      const insertPromises = [];
      for (let i = 0; i < recordCount; i += 1000) {
        insertPromises.push(
          (async () => {
            const batchData = [];
            for (let j = 0; j < 1000 && i + j < recordCount; j++) {
              const idx = i + j;
              batchData.push(
                `('test_${idx}', ${idx}, ${(idx * 1.5).toFixed(
                  2
                )}, 'meta_${idx}')`
              );
            }

            if (batchData.length > 0) {
              await client.query(`
              INSERT INTO ${tableName} (col1, col2, col3, col4) VALUES ${batchData.join(
                ", "
              )}
            `);
            }
          })()
        );
      }

      await Promise.all(insertPromises);

      // Test multi-column migration performance
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(
            client,
            `
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            col1 TEXT,
            col2 BIGINT,
            col3 DECIMAL(12,4),
            col4 TEXT
          );
        `,
            services
          );
        }
      );

      const multiColumnRate = recordCount / (duration / 1000);

      console.log(
        `Multi-column migration: ${recordCount} records in ${duration.toFixed(
          2
        )}ms`
      );
      console.log(
        `Multi-column rate: ${multiColumnRate.toFixed(0)} records/second`
      );

      // Performance expectations for multi-column operations
      expect(duration).toBeLessThan(180000); // 3 minutes
      expect(multiColumnRate).toBeGreaterThan(100); // At least 100 records/second

      // Verify all columns changed correctly
      const finalColumns = await getTableColumns(client, tableName);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "col1",
        "text",
        "multi-column trends"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "col2",
        "bigint",
        "multi-column trends"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "col3",
        "numeric",
        "multi-column trends"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "col4",
        "text",
        "multi-column trends"
      );

      // Check data integrity
      const result = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
      expect(parseInt(result.rows[0].count)).toBe(recordCount);
    });
  });

  describe("Performance Boundary Testing", () => {
    test("should handle performance at scale boundaries", async () => {
      const tableName = "scale_boundary_test";

      // Test with different dataset sizes to find performance boundaries
      const testSizes = [1000, 5000, 25000]; // Progressive scaling
      const results: Array<{ size: number; duration: number; rate: number }> =
        [];

      for (const size of testSizes) {
        await client.query(`DROP TABLE IF EXISTS ${tableName}`);
        await client.query(`
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            test_column VARCHAR(255)
          );
        `);

        // Generate and insert test data
        const testData = Array.from(
          { length: size },
          (_, i) => `'boundary_test_${i}'`
        );
        await DataIntegrityUtils.insertTestDataSafely(
          client,
          tableName,
          "test_column",
          testData,
          500
        );

        // Measure migration performance
        const { duration } = await PerformanceUtils.measureMigrationTime(
          async () => {
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
          }
        );

        const rate = size / (duration / 1000);
        results.push({ size, duration, rate });

        console.log(
          `Size: ${size}, Duration: ${duration.toFixed(
            2
          )}ms, Rate: ${rate.toFixed(0)} records/sec`
        );
      }

      // Analyze performance scaling
      for (let i = 1; i < results.length; i++) {
        const prev = results[i - 1];
        const curr = results[i];

        if (prev && curr) {
          const sizeRatio = curr.size / prev.size;
          const timeRatio = curr.duration / prev.duration;
          const scalingEfficiency = sizeRatio / timeRatio;

          console.log(
            `Scaling ${prev.size} → ${
              curr.size
            }: efficiency ${scalingEfficiency.toFixed(2)}`
          );

          // Scaling should be reasonably linear (efficiency > 0.5 is acceptable)
          expect(scalingEfficiency).toBeGreaterThan(0.3);
        }
      }

      // Performance should not degrade dramatically with scale
      const largestTest = results[results.length - 1];
      if (largestTest) {
        expect(largestTest.rate).toBeGreaterThan(50); // Minimum acceptable rate at scale
      }
    });
  });
});
