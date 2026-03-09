import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
    await client?.end();
  });

  afterAll(function () {
    if (benchmarks.length === 0) {
      return;
    }

    const metrics = Object.fromEntries(
      benchmarks.map(function (benchmark) {
        return [benchmark.scenario, benchmark.duration];
      })
    );

    mkdirSync("coverage", { recursive: true });
    writeFileSync(
      "coverage/perf-report.json",
      JSON.stringify({ metrics }, null, 2)
    );
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
    }, 60000);
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

});
