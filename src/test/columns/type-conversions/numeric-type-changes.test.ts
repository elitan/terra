import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "../../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  assertColumn,
  EnhancedAssertions,
  PerformanceUtils,
  DataIntegrityUtils,
} from "../column-test-utils";
import { BoundaryValues, POSTGRES_LIMITS } from "../test-data-generators";

describe("Numeric Type Conversions and Edge Cases", () => {
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

  describe("INTEGER Boundary Value Testing", () => {
    test("should handle INT32 boundary values correctly", async () => {
      // 1. Create table with INTEGER column
      await client.query(`
        CREATE TABLE int_boundary_test (
          id SERIAL PRIMARY KEY,
          int_value INTEGER
        );
      `);

      // Insert boundary values
      const boundaryValues = BoundaryValues.integer.valid;
      for (const value of boundaryValues) {
        await client.query(
          "INSERT INTO int_boundary_test (int_value) VALUES ($1)",
          [value]
        );
      }

      // 2. Convert INTEGER to BIGINT (should preserve all values)
      const desiredSQL = `
        CREATE TABLE int_boundary_test (
          id SERIAL PRIMARY KEY,
          int_value BIGINT
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify all boundary values preserved
      const result = await client.query(
        "SELECT * FROM int_boundary_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(boundaryValues.length);

      for (let i = 0; i < boundaryValues.length; i++) {
        // BIGINT values are returned as strings from PostgreSQL
        const expectedValue = boundaryValues[i];
        const actualValue = result.rows[i]?.int_value;
        expect(actualValue).toBe(expectedValue?.toString());
      }

      // Verify column type change
      const finalColumns = await getTableColumns(client, "int_boundary_test");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "int_value",
        "bigint",
        "INTEGER to BIGINT boundary test"
      );
    });

    test("should handle zero and negative number edge cases", async () => {
      // 1. Create table
      await client.query(`
        CREATE TABLE zero_negative_test (
          id SERIAL PRIMARY KEY,
          value_field INTEGER
        );
      `);

      // Test zero and negative edge cases
      const zeroNegativeCases = [
        0,
        -0, // Should be same as 0
        -1,
        1,
        -999999,
        999999,
        POSTGRES_LIMITS.INT4_MIN,
        POSTGRES_LIMITS.INT4_MAX,
        -2147483647, // One less than min
        2147483646, // One less than max
      ];

      for (const value of zeroNegativeCases) {
        await client.query(
          "INSERT INTO zero_negative_test (value_field) VALUES ($1)",
          [value]
        );
      }

      // 2. Convert to BIGINT
      const desiredSQL = `
        CREATE TABLE zero_negative_test (
          id SERIAL PRIMARY KEY,
          value_field BIGINT
        );
      `;

      // 3. Execute migration with performance measurement
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify values preserved
      const result = await client.query(
        "SELECT * FROM zero_negative_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(zeroNegativeCases.length);

      for (let i = 0; i < zeroNegativeCases.length; i++) {
        // BIGINT values are returned as strings from PostgreSQL
        expect(result.rows[i]?.value_field).toBe(
          zeroNegativeCases[i]?.toString()
        );
      }

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        3000,
        "zero/negative boundary conversion"
      );
    });

    test("should handle string-to-integer conversion with whitespace", async () => {
      // 1. Create table with VARCHAR column
      await client.query(`
        CREATE TABLE string_to_int_test (
          id SERIAL PRIMARY KEY,
          string_value VARCHAR(50)
        );
      `);

      // Insert numeric strings with various whitespace patterns
      const numericStrings = [
        "123",
        " 456 ", // Leading/trailing spaces
        "\t789\t", // Leading/trailing tabs
        "\n999\n", // Leading/trailing newlines
        " \t 42 \n ", // Mixed whitespace
        "0",
        "-123",
        " -456 ",
      ];

      for (const str of numericStrings) {
        await client.query(
          "INSERT INTO string_to_int_test (string_value) VALUES ($1)",
          [str]
        );
      }

      // 2. Convert VARCHAR to INTEGER
      const desiredSQL = `
        CREATE TABLE string_to_int_test (
          id SERIAL PRIMARY KEY,
          string_value INTEGER
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify numeric conversion
      const result = await client.query(
        "SELECT * FROM string_to_int_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(numericStrings.length);

      const expectedValues = [123, 456, 789, 999, 42, 0, -123, -456];
      for (let i = 0; i < expectedValues.length; i++) {
        expect(result.rows[i]?.string_value).toBe(expectedValues[i]);
      }

      // Verify column type change
      const finalColumns = await getTableColumns(client, "string_to_int_test");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "string_value",
        "integer",
        "string to integer conversion"
      );
    });
  });

  describe("BIGINT Boundary Value Testing", () => {
    test("should handle INT64 boundary values", async () => {
      // 1. Create table with BIGINT column
      await client.query(`
        CREATE TABLE bigint_test (
          id SERIAL PRIMARY KEY,
          big_value BIGINT
        );
      `);

      // Insert BIGINT boundary values (using strings to avoid JS number precision issues)
      const bigintValues = [
        "-9223372036854775808", // INT64_MIN
        "-9223372036854775807", // INT64_MIN + 1
        "-1",
        "0",
        "1",
        "9223372036854775806", // INT64_MAX - 1
        "9223372036854775807", // INT64_MAX
      ];

      for (const value of bigintValues) {
        await client.query("INSERT INTO bigint_test (big_value) VALUES ($1)", [
          value,
        ]);
      }

      // 2. Convert BIGINT to DECIMAL (to test precision preservation)
      const desiredSQL = `
        CREATE TABLE bigint_test (
          id SERIAL PRIMARY KEY,
          big_value DECIMAL(20,0)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify values preserved as strings (DECIMAL returns strings)
      const result = await client.query(
        "SELECT * FROM bigint_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(bigintValues.length);

      for (let i = 0; i < bigintValues.length; i++) {
        expect(result.rows[i]?.big_value).toBe(bigintValues[i]);
      }

      // Verify column type change
      const finalColumns = await getTableColumns(client, "bigint_test");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "big_value",
        "numeric",
        "BIGINT to DECIMAL conversion"
      );
    });
  });

  describe("DECIMAL Precision and Scale Edge Cases", () => {
    test("should handle precision and scale changes", async () => {
      // 1. Create table with high precision DECIMAL
      await client.query(`
        CREATE TABLE decimal_precision_test (
          id SERIAL PRIMARY KEY,
          decimal_value DECIMAL(10,4)
        );
      `);

      // Insert decimal values with various precisions
      const decimalValues = [
        "12345.7890", // Within precision limit for DECIMAL(10,4)
        "99999.9999", // Near max value for DECIMAL(10,4)
        "-99999.9999", // Near min value for DECIMAL(10,4)
        "0.0001", // Min positive with 4 scale
        "0.0000", // Zero with scale
        "123.45", // Normal case
        "10000.00", // 5 digits before decimal
      ];

      for (const value of decimalValues) {
        await client.query(
          "INSERT INTO decimal_precision_test (decimal_value) VALUES ($1)",
          [value]
        );
      }

      // 2. Convert to lower scale DECIMAL(10,2) - should round
      const desiredSQL = `
        CREATE TABLE decimal_precision_test (
          id SERIAL PRIMARY KEY,
          decimal_value DECIMAL(10,2)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify rounding behavior
      const result = await client.query(
        "SELECT * FROM decimal_precision_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(decimalValues.length);

      const expectedRounded = [
        "12345.79", // Rounded from .7890
        "100000.00", // Rounded up from 99999.9999
        "-100000.00", // Rounded down from -99999.9999
        "0.00", // Rounded from .0001
        "0.00", // Zero preserved
        "123.45", // Exact fit
        "10000.00", // Preserved
      ];

      for (let i = 0; i < expectedRounded.length; i++) {
        expect(result.rows[i]?.decimal_value).toBe(expectedRounded[i]);
      }

      // Verify column type change
      const finalColumns = await getTableColumns(
        client,
        "decimal_precision_test"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "decimal_value",
        "numeric",
        "DECIMAL precision change"
      );
    });

    test("should handle scientific notation in string-to-decimal conversion", async () => {
      // 1. Create table with VARCHAR
      await client.query(`
        CREATE TABLE scientific_notation_test (
          id SERIAL PRIMARY KEY,
          sci_value VARCHAR(50)
        );
      `);

      // Insert scientific notation strings
      const scientificValues = [
        "1.23E+2", // 123
        "1.23e+2", // 123 (lowercase e)
        "1.23E-2", // 0.0123
        "1e5", // 100000
        "2.5E+0", // 2.5
        "-1.5E+3", // -1500
        "0E+0", // 0
      ];

      for (const value of scientificValues) {
        await client.query(
          "INSERT INTO scientific_notation_test (sci_value) VALUES ($1)",
          [value]
        );
      }

      // 2. Convert VARCHAR to DECIMAL
      const desiredSQL = `
        CREATE TABLE scientific_notation_test (
          id SERIAL PRIMARY KEY,
          sci_value DECIMAL(15,5)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify scientific notation conversion
      const result = await client.query(
        "SELECT * FROM scientific_notation_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(scientificValues.length);

      const expectedDecimals = [
        "123.00000",
        "123.00000",
        "0.01230",
        "100000.00000",
        "2.50000",
        "-1500.00000",
        "0.00000",
      ];

      for (let i = 0; i < expectedDecimals.length; i++) {
        expect(result.rows[i]?.sci_value).toBe(expectedDecimals[i]);
      }
    });
  });

  describe("Overflow and Underflow Scenarios", () => {
    test("should handle INTEGER overflow gracefully", async () => {
      // 1. Create table with BIGINT values that exceed INTEGER range
      await client.query(`
        CREATE TABLE overflow_test (
          id SERIAL PRIMARY KEY,
          big_value BIGINT
        );
      `);

      // Insert values that would overflow INTEGER
      const overflowValues = [
        BigInt(POSTGRES_LIMITS.INT4_MAX) + 1n, // Just over INT4_MAX
        BigInt(POSTGRES_LIMITS.INT4_MIN) - 1n, // Just under INT4_MIN
        9999999999n, // Much larger
        -9999999999n, // Much smaller
      ];

      for (const value of overflowValues) {
        await client.query(
          "INSERT INTO overflow_test (big_value) VALUES ($1)",
          [value.toString()]
        );
      }

      // 2. Attempt to convert BIGINT to INTEGER (should handle overflow)
      const desiredSQL = `
        CREATE TABLE overflow_test (
          id SERIAL PRIMARY KEY,
          big_value INTEGER
        );
      `;

      // 3. This should fail due to overflow - test error handling
      try {
        await executeColumnMigration(client, desiredSQL, services);
        // If we get here, the test should fail because overflow should be prevented
        expect(false, "Expected overflow error but migration succeeded").toBe(
          true
        );
      } catch (error) {
        // Verify we get an appropriate overflow error
        expect(error).toBeDefined();
        // The error message should indicate value out of range
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        expect(errorMessage.toLowerCase()).toContain("integer");
      }
    });

    test("should handle DECIMAL precision overflow", async () => {
      // 1. Create table with TEXT to store very large numbers
      await client.query(`
        CREATE TABLE decimal_overflow_test (
          id SERIAL PRIMARY KEY,
          large_number TEXT
        );
      `);

      // Insert numbers that exceed DECIMAL(5,2) precision
      const largeNumbers = [
        "999999.99", // Too many digits before decimal
        "123.999", // Too many digits after decimal
        "9999999", // Way too large
        "0.999999", // Too many decimal places
      ];

      for (const number of largeNumbers) {
        await client.query(
          "INSERT INTO decimal_overflow_test (large_number) VALUES ($1)",
          [number]
        );
      }

      // 2. Attempt to convert to small DECIMAL(5,2)
      const desiredSQL = `
        CREATE TABLE decimal_overflow_test (
          id SERIAL PRIMARY KEY,
          large_number DECIMAL(5,2)
        );
      `;

      // 3. This should fail or truncate depending on PostgreSQL behavior
      try {
        await executeColumnMigration(client, desiredSQL, services);

        // If conversion succeeds, check for truncation/rounding
        const result = await client.query(
          "SELECT * FROM decimal_overflow_test ORDER BY id"
        );

        // Verify how PostgreSQL handles the overflow
        for (const row of result.rows) {
          const value = row.large_number;
          // Value should fit DECIMAL(5,2) constraints
          expect(typeof value).toBe("string");
          const num = parseFloat(value);
          expect(num).toBeLessThanOrEqual(999.99);
          expect(num).toBeGreaterThanOrEqual(-999.99);
        }
      } catch (error) {
        // If it fails, that's also acceptable - verify appropriate error
        expect(error).toBeDefined();
      }
    });
  });

  describe("Performance with Large Numeric Datasets", () => {
    test("should handle large numeric dataset conversion efficiently", async () => {
      // 1. Create table with many INTEGER records
      await client.query(`
        CREATE TABLE large_numeric_perf (
          id SERIAL PRIMARY KEY,
          int_value INTEGER,
          decimal_value DECIMAL(10,2)
        );
      `);

      // Insert substantial numeric data
      const insertPromises = Array.from({ length: 1000 }, (_, i) => {
        const intValue = Math.floor(Math.random() * POSTGRES_LIMITS.INT4_MAX);
        const decimalValue = (Math.random() * 10000).toFixed(2);
        return client.query(
          "INSERT INTO large_numeric_perf (int_value, decimal_value) VALUES ($1, $2)",
          [intValue, decimalValue]
        );
      });
      await Promise.all(insertPromises);

      // Capture before state
      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "large_numeric_perf",
        "id"
      );

      // 2. Convert types
      const desiredSQL = `
        CREATE TABLE large_numeric_perf (
          id SERIAL PRIMARY KEY,
          int_value BIGINT,
          decimal_value DECIMAL(15,4)
        );
      `;

      // 3. Execute migration with performance measurement
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify data integrity and performance
      const afterSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "large_numeric_perf",
        "id"
      );

      expect(afterSnapshot.length).toBe(beforeSnapshot.length);
      expect(afterSnapshot.length).toBe(1000);

      // Verify numeric data preservation (sample check)
      for (let i = 0; i < Math.min(10, afterSnapshot.length); i++) {
        // BIGINT values are returned as strings, so convert for comparison
        const beforeInt = beforeSnapshot[i]?.int_value;
        const afterInt = afterSnapshot[i]?.int_value;
        expect(afterInt).toBe(beforeInt?.toString());
        // DECIMAL values should be preserved (possibly with additional precision)
        const beforeDecimal = parseFloat(
          beforeSnapshot[i]?.decimal_value || "0"
        );
        const afterDecimal = parseFloat(afterSnapshot[i]?.decimal_value || "0");
        expect(Math.abs(afterDecimal - beforeDecimal)).toBeLessThan(0.01);
      }

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        10000,
        "large numeric dataset conversion"
      );

      // Verify column types changed
      const finalColumns = await getTableColumns(client, "large_numeric_perf");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "int_value",
        "bigint",
        "large dataset INTEGER to BIGINT"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "decimal_value",
        "numeric",
        "large dataset DECIMAL precision change"
      );
    });
  });

  describe("Edge Cases with NULL and Special Values", () => {
    test("should handle NULL values in numeric conversions", async () => {
      // 1. Create table with nullable numeric column
      await client.query(`
        CREATE TABLE null_numeric_test (
          id SERIAL PRIMARY KEY,
          nullable_int INTEGER,
          nullable_decimal DECIMAL(8,2)
        );
      `);

      // Insert mix of NULL and numeric values
      await client.query(
        "INSERT INTO null_numeric_test (nullable_int, nullable_decimal) VALUES ($1, $2)",
        [null, null]
      );
      await client.query(
        "INSERT INTO null_numeric_test (nullable_int, nullable_decimal) VALUES ($1, $2)",
        [42, "123.45"]
      );
      await client.query(
        "INSERT INTO null_numeric_test (nullable_int, nullable_decimal) VALUES ($1, $2)",
        [null, "456.78"]
      );
      await client.query(
        "INSERT INTO null_numeric_test (nullable_int, nullable_decimal) VALUES ($1, $2)",
        [789, null]
      );

      // 2. Convert types while preserving NULLs
      const desiredSQL = `
        CREATE TABLE null_numeric_test (
          id SERIAL PRIMARY KEY,
          nullable_int BIGINT,
          nullable_decimal DECIMAL(12,4)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify NULL preservation and value conversion
      const result = await client.query(
        "SELECT * FROM null_numeric_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(4);

      expect(result.rows[0]?.nullable_int).toBeNull();
      expect(result.rows[0]?.nullable_decimal).toBeNull();

      expect(result.rows[1]?.nullable_int).toBe("42");
      expect(result.rows[1]?.nullable_decimal).toBe("123.4500");

      expect(result.rows[2]?.nullable_int).toBeNull();
      expect(result.rows[2]?.nullable_decimal).toBe("456.7800");

      expect(result.rows[3]?.nullable_int).toBe("789");
      expect(result.rows[3]?.nullable_decimal).toBeNull();
    });
  });
});
