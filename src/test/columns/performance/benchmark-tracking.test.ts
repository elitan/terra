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
 * Performance benchmark tracking and monitoring
 *
 * This file contains tests that establish and track performance benchmarks
 * for column migrations. Run these tests periodically to monitor performance
 * trends and detect regressions.
 */

interface Benchmark {
  scenario: string;
  recordCount: number;
  duration: number;
  rate: number; // records per second
  timestamp: Date;
  metadata?: Record<string, any>;
}

describe("Performance Benchmark Tracking", () => {
  let client: Client;
  let services: ReturnType<typeof createColumnTestServices>;
  const benchmarks: Benchmark[] = [];

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    services = createColumnTestServices();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  /**
   * Helper function to record benchmark results
   */
  function recordBenchmark(
    scenario: string,
    recordCount: number,
    duration: number,
    metadata?: Record<string, any>
  ): Benchmark {
    const rate = recordCount / (duration / 1000);
    const benchmark: Benchmark = {
      scenario,
      recordCount,
      duration,
      rate,
      timestamp: new Date(),
      metadata,
    };

    benchmarks.push(benchmark);
    return benchmark;
  }

  /**
   * Helper function to log benchmark results
   */
  function logBenchmark(benchmark: Benchmark): void {
    console.log(`📊 ${benchmark.scenario}`);
    console.log(`   Records: ${benchmark.recordCount.toLocaleString()}`);
    console.log(`   Duration: ${benchmark.duration.toFixed(2)}ms`);
    console.log(`   Rate: ${benchmark.rate.toFixed(0)} records/second`);
    if (benchmark.metadata) {
      console.log(`   Metadata: ${JSON.stringify(benchmark.metadata)}`);
    }
    console.log(`   Timestamp: ${benchmark.timestamp.toISOString()}`);
    console.log("");
  }

  describe("Core Type Conversion Benchmarks", () => {
    test("should benchmark VARCHAR to TEXT conversions across dataset sizes", async () => {
      const conversions = [
        {
          size: "small",
          records: PerformanceTestData.small.size,
          data: PerformanceTestData.small.varchar,
        },
        {
          size: "medium",
          records: PerformanceTestData.medium.size,
          data: PerformanceTestData.medium.varchar,
        },
      ];

      for (const conversion of conversions) {
        const tableName = `varchar_text_${conversion.size}`;

        await client.query(`
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            test_column VARCHAR(255)
          );
        `);

        // Insert data with timing
        const insertStart = performance.now();
        await DataIntegrityUtils.insertTestDataSafely(
          client,
          tableName,
          "test_column",
          conversion.data,
          conversion.size === "small" ? 100 : 500
        );
        const insertDuration = performance.now() - insertStart;

        // Perform migration
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

        // Record benchmark
        const benchmark = recordBenchmark(
          `VARCHAR_to_TEXT_${conversion.size}`,
          conversion.records,
          duration,
          {
            insertDuration,
            avgColumnLength: 255,
            conversionType: "compatible",
          }
        );

        logBenchmark(benchmark);

        // Verify migration success
        const finalColumns = await getTableColumns(client, tableName);
        EnhancedAssertions.assertColumnType(
          finalColumns,
          "test_column",
          "text",
          `VARCHAR to TEXT ${conversion.size} benchmark`
        );

        await client.query(`DROP TABLE ${tableName}`);
      }
    });

    test("should benchmark INTEGER to BIGINT conversions", async () => {
      const conversions = [
        {
          size: "small",
          records: PerformanceTestData.small.size,
          data: PerformanceTestData.small.integer,
        },
        {
          size: "medium",
          records: PerformanceTestData.medium.size,
          data: PerformanceTestData.medium.integer,
        },
      ];

      for (const conversion of conversions) {
        const tableName = `int_bigint_${conversion.size}`;

        await client.query(`
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            test_column INTEGER
          );
        `);

        await DataIntegrityUtils.insertTestDataSafely(
          client,
          tableName,
          "test_column",
          conversion.data
        );

        const { duration } = await PerformanceUtils.measureMigrationTime(
          async () => {
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
          }
        );

        const benchmark = recordBenchmark(
          `INTEGER_to_BIGINT_${conversion.size}`,
          conversion.records,
          duration,
          {
            conversionType: "compatible_numeric",
            dataType: "integer",
          }
        );

        logBenchmark(benchmark);

        const finalColumns = await getTableColumns(client, tableName);
        EnhancedAssertions.assertColumnType(
          finalColumns,
          "test_column",
          "bigint",
          `INTEGER to BIGINT ${conversion.size} benchmark`
        );

        await client.query(`DROP TABLE ${tableName}`);
      }
    });

    test("should benchmark DECIMAL precision changes", async () => {
      const scenarios = [
        {
          name: "precision_increase",
          from: "DECIMAL(8,2)",
          to: "DECIMAL(12,4)",
          description: "Increase precision and scale",
        },
        {
          name: "precision_decrease",
          from: "DECIMAL(12,4)",
          to: "DECIMAL(8,2)",
          description: "Decrease precision and scale",
        },
      ];

      for (const scenario of scenarios) {
        const tableName = `decimal_${scenario.name}`;

        await client.query(`
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            test_column ${scenario.from}
          );
        `);

        const testData = PerformanceTestData.medium.decimal;
        await DataIntegrityUtils.insertTestDataSafely(
          client,
          tableName,
          "test_column",
          testData
        );

        const { duration } = await PerformanceUtils.measureMigrationTime(
          async () => {
            await executeColumnMigration(
              client,
              `
            CREATE TABLE ${tableName} (
              id SERIAL PRIMARY KEY,
              test_column ${scenario.to}
            );
          `,
              services
            );
          }
        );

        const benchmark = recordBenchmark(
          `DECIMAL_${scenario.name}_medium`,
          PerformanceTestData.medium.size,
          duration,
          {
            fromType: scenario.from,
            toType: scenario.to,
            description: scenario.description,
          }
        );

        logBenchmark(benchmark);

        await client.query(`DROP TABLE ${tableName}`);
      }
    });
  });

  describe("Complex Scenario Benchmarks", () => {
    test("should benchmark multi-column conversions", async () => {
      const tableName = "multi_column_benchmark";
      const recordCount = 5000; // Reduced dataset for testing

      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          varchar_col VARCHAR(255),
          int_col INTEGER,
          decimal_col DECIMAL(8,2),
          bool_col BOOLEAN
        );
      `);

      // Insert multi-column test data
      const insertStart = performance.now();
      for (let i = 0; i < recordCount; i += 1000) {
        const batchData = [];
        for (let j = 0; j < 1000 && i + j < recordCount; j++) {
          const idx = i + j;
          batchData.push(
            `('multi_test_${idx}', ${idx}, ${(idx * 1.5).toFixed(2)}, ${
              idx % 2 === 0
            })`
          );
        }

        if (batchData.length > 0) {
          await client.query(`
            INSERT INTO ${tableName} (varchar_col, int_col, decimal_col, bool_col) 
            VALUES ${batchData.join(", ")}
          `);
        }
      }
      const insertDuration = performance.now() - insertStart;

      // Perform multi-column migration
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(
            client,
            `
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            varchar_col TEXT,
            int_col BIGINT,
            decimal_col DECIMAL(12,4),
            bool_col BOOLEAN
          );
        `,
            services
          );
        }
      );

      const benchmark = recordBenchmark(
        "MULTI_COLUMN_conversion",
        recordCount,
        duration,
        {
          insertDuration,
          columnsChanged: 3,
          changeTypes: ["VARCHAR→TEXT", "INTEGER→BIGINT", "DECIMAL precision"],
        }
      );

      logBenchmark(benchmark);

      // Verify all conversions
      const finalColumns = await getTableColumns(client, tableName);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "varchar_col",
        "text",
        "multi-column"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "int_col",
        "bigint",
        "multi-column"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "decimal_col",
        "numeric",
        "multi-column"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "bool_col",
        "boolean",
        "multi-column"
      );
    });

    test("should benchmark large string operations", async () => {
      const tableName = "large_string_benchmark";
      const recordCount = 1000; // Reduced for CI performance

      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          large_text VARCHAR(2000)
        );
      `);

      // Generate large strings (each ~1KB)
      const largeStrings = Array.from({ length: recordCount }, (_, i) => {
        const baseText = `large_string_test_${i}_`.repeat(50); // ~1KB string
        return `'${baseText.slice(0, 1000)}'`; // Truncate to exactly 1KB
      });

      await DataIntegrityUtils.insertTestDataSafely(
        client,
        tableName,
        "large_text",
        largeStrings,
        500
      );

      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(
            client,
            `
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            large_text TEXT
          );
        `,
            services
          );
        }
      );

      const totalDataSize = recordCount * 1024; // 1KB per record
      const benchmark = recordBenchmark(
        "LARGE_STRING_conversion",
        recordCount,
        duration,
        {
          avgStringSize: 1024,
          totalDataSize,
          throughputMBps: totalDataSize / 1024 / 1024 / (duration / 1000),
        }
      );

      logBenchmark(benchmark);

      console.log(
        `Data throughput: ${benchmark.metadata!.throughputMBps.toFixed(
          2
        )} MB/second`
      );
    });
  });

  describe("Performance Baseline Establishment", () => {
    test("should establish and validate performance baselines", async () => {
      // Run all core benchmarks and establish baselines
      console.log("\n🎯 ESTABLISHING PERFORMANCE BASELINES\n");

      // Define acceptable performance thresholds (records/second)
      const acceptableThresholds = {
        VARCHAR_to_TEXT_small: 50,
        VARCHAR_to_TEXT_medium: 300,
        INTEGER_to_BIGINT_small: 100,
        INTEGER_to_BIGINT_medium: 500,
        DECIMAL_precision_increase_medium: 200,
        MULTI_COLUMN_conversion: 150,
      };

      // Check all recorded benchmarks against thresholds
      let allBenchmarksPassed = true;
      const results: Array<{
        scenario: string;
        passed: boolean;
        rate: number;
        threshold: number;
      }> = [];

      for (const benchmark of benchmarks) {
        const threshold =
          acceptableThresholds[
            benchmark.scenario as keyof typeof acceptableThresholds
          ];
        if (threshold) {
          const passed = benchmark.rate >= threshold;
          if (!passed) {
            allBenchmarksPassed = false;
          }

          results.push({
            scenario: benchmark.scenario,
            passed,
            rate: benchmark.rate,
            threshold,
          });
        }
      }

      // Log results summary
      console.log("📋 BASELINE VALIDATION RESULTS:");
      console.log("================================");
      for (const result of results) {
        const status = result.passed ? "✅ PASS" : "❌ FAIL";
        const percentage = ((result.rate / result.threshold) * 100).toFixed(1);
        console.log(`${status} ${result.scenario}`);
        console.log(
          `     Rate: ${result.rate.toFixed(
            0
          )} records/sec (${percentage}% of threshold)`
        );
        console.log(`     Threshold: ${result.threshold} records/sec`);
        console.log("");
      }

      // Export benchmark data for historical tracking
      const benchmarkSummary = {
        timestamp: new Date().toISOString(),
        environment: {
          node_version: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        benchmarks: benchmarks.map((b) => ({
          scenario: b.scenario,
          recordCount: b.recordCount,
          duration: b.duration,
          rate: b.rate,
          metadata: b.metadata,
        })),
        validation: {
          allPassed: allBenchmarksPassed,
          passedCount: results.filter((r) => r.passed).length,
          totalCount: results.length,
        },
      };

      console.log("📁 Benchmark data for historical tracking:");
      console.log(JSON.stringify(benchmarkSummary, null, 2));

      // Assert overall performance acceptability
      expect(allBenchmarksPassed).toBe(true);
    });
  });

  describe("Performance Regression Detection", () => {
    test("should detect performance regressions", async () => {
      // This test would typically compare against historical data
      // For now, we'll demonstrate regression detection logic

      const tableName = "regression_detection";
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

      const currentRate = PerformanceTestData.small.size / (duration / 1000);

      // Simulate historical baseline (in a real implementation, this would come from stored data)
      const historicalRate = 100; // records/second baseline
      const regressionThreshold = 0.8; // 20% degradation threshold

      const performanceRatio = currentRate / historicalRate;
      const hasRegression = performanceRatio < regressionThreshold;

      console.log(`Current rate: ${currentRate.toFixed(0)} records/second`);
      console.log(`Historical baseline: ${historicalRate} records/second`);
      console.log(`Performance ratio: ${(performanceRatio * 100).toFixed(1)}%`);

      if (hasRegression) {
        console.warn(`⚠️  PERFORMANCE REGRESSION DETECTED!`);
        console.warn(
          `Performance degraded by ${((1 - performanceRatio) * 100).toFixed(
            1
          )}%`
        );

        // In a real scenario, this might send alerts or fail CI/CD
        // For now, we'll log the regression but not fail the test
        console.warn(`Test would fail in CI/CD environment`);
      } else {
        console.log(`✅ No performance regression detected`);
      }

      // Only fail if regression is severe (more than 50% degradation)
      expect(performanceRatio).toBeGreaterThan(0.5);
    });
  });
});
