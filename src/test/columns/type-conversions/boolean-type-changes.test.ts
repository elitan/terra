import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "../../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  EnhancedAssertions,
  PerformanceUtils,
  DataIntegrityUtils,
} from "../column-test-utils";
import { BooleanEdgeCases } from "../test-data-generators";

describe("Boolean Type Conversions and Edge Cases", () => {
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

  describe("All PostgreSQL Boolean Representations", () => {
    test("should handle all valid TRUE representations", async () => {
      // 1. Create table with VARCHAR column
      await client.query(`
        CREATE TABLE boolean_true_test (
          id SERIAL PRIMARY KEY,
          bool_string VARCHAR(20)
        );
      `);

      // Insert all valid TRUE representations
      const trueValues = [
        "t",
        "T",
        "true",
        "TRUE",
        "True",
        "tRuE",
        "1",
        "yes",
        "YES",
        "Yes",
        "y",
        "Y",
        "on",
        "ON",
        "On",
      ];

      for (const value of trueValues) {
        await client.query(
          "INSERT INTO boolean_true_test (bool_string) VALUES ($1)",
          [value]
        );
      }

      // 2. Convert VARCHAR to BOOLEAN
      const desiredSQL = `
        CREATE TABLE boolean_true_test (
          id SERIAL PRIMARY KEY,
          bool_string BOOLEAN
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify all values converted to TRUE
      const result = await client.query(
        "SELECT * FROM boolean_true_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(trueValues.length);

      for (let i = 0; i < trueValues.length; i++) {
        expect(result.rows[i]?.bool_string).toBe(true);
      }

      // Verify column type change
      const finalColumns = await getTableColumns(client, "boolean_true_test");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "bool_string",
        "boolean",
        "VARCHAR to BOOLEAN TRUE conversion"
      );
    });

    test("should handle all valid FALSE representations", async () => {
      // 1. Create table with VARCHAR column
      await client.query(`
        CREATE TABLE boolean_false_test (
          id SERIAL PRIMARY KEY,
          bool_string VARCHAR(20)
        );
      `);

      // Insert all valid FALSE representations
      const falseValues = [
        "f",
        "F",
        "false",
        "FALSE",
        "False",
        "fAlSe",
        "0",
        "no",
        "NO",
        "No",
        "n",
        "N",
        "off",
        "OFF",
        "Off",
      ];

      for (const value of falseValues) {
        await client.query(
          "INSERT INTO boolean_false_test (bool_string) VALUES ($1)",
          [value]
        );
      }

      // 2. Convert VARCHAR to BOOLEAN
      const desiredSQL = `
        CREATE TABLE boolean_false_test (
          id SERIAL PRIMARY KEY,
          bool_string BOOLEAN
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify all values converted to FALSE
      const result = await client.query(
        "SELECT * FROM boolean_false_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(falseValues.length);

      for (let i = 0; i < falseValues.length; i++) {
        expect(result.rows[i]?.bool_string).toBe(false);
      }

      // Verify column type change
      const finalColumns = await getTableColumns(client, "boolean_false_test");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "bool_string",
        "boolean",
        "VARCHAR to BOOLEAN FALSE conversion"
      );
    });

    test("should handle mixed TRUE and FALSE values", async () => {
      // 1. Create table with mixed boolean representations
      await client.query(`
        CREATE TABLE mixed_boolean_test (
          id SERIAL PRIMARY KEY,
          bool_value VARCHAR(10),
          description TEXT
        );
      `);

      // Insert mixed boolean values with descriptions
      const mixedValues = [
        { value: "true", expected: true, desc: "lowercase true" },
        { value: "FALSE", expected: false, desc: "uppercase false" },
        { value: "1", expected: true, desc: "numeric 1" },
        { value: "0", expected: false, desc: "numeric 0" },
        { value: "yes", expected: true, desc: "yes" },
        { value: "NO", expected: false, desc: "uppercase no" },
        { value: "t", expected: true, desc: "single t" },
        { value: "f", expected: false, desc: "single f" },
        { value: "on", expected: true, desc: "on" },
        { value: "off", expected: false, desc: "off" },
      ];

      for (const item of mixedValues) {
        await client.query(
          "INSERT INTO mixed_boolean_test (bool_value, description) VALUES ($1, $2)",
          [item.value, item.desc]
        );
      }

      // 2. Convert VARCHAR to BOOLEAN
      const desiredSQL = `
        CREATE TABLE mixed_boolean_test (
          id SERIAL PRIMARY KEY,
          bool_value BOOLEAN,
          description TEXT
        );
      `;

      // 3. Execute migration with performance tracking
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify mixed boolean conversion
      const result = await client.query(
        "SELECT * FROM mixed_boolean_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(mixedValues.length);

      for (let i = 0; i < mixedValues.length; i++) {
        const expected = mixedValues[i]?.expected;
        const actual = result.rows[i]?.bool_value;
        const description = mixedValues[i]?.desc;
        expect(actual, `Boolean conversion for: ${description}`).toBe(expected);
      }

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        3000,
        "mixed boolean conversion"
      );
    });
  });

  describe("Case Sensitivity Testing", () => {
    test("should handle case-insensitive boolean conversion", async () => {
      // 1. Create table with various case combinations
      await client.query(`
        CREATE TABLE case_sensitivity_test (
          id SERIAL PRIMARY KEY,
          mixed_case VARCHAR(10)
        );
      `);

      // Insert case variations
      const caseVariations = [
        { value: "True", expected: true },
        { value: "tRuE", expected: true },
        { value: "TRUE", expected: true },
        { value: "False", expected: false },
        { value: "fAlSe", expected: false },
        { value: "FALSE", expected: false },
        { value: "Yes", expected: true },
        { value: "yEs", expected: true },
        { value: "No", expected: false },
        { value: "nO", expected: false },
        { value: "On", expected: true },
        { value: "oN", expected: true },
        { value: "Off", expected: false },
        { value: "oFf", expected: false },
      ];

      for (const item of caseVariations) {
        await client.query(
          "INSERT INTO case_sensitivity_test (mixed_case) VALUES ($1)",
          [item.value]
        );
      }

      // 2. Convert to BOOLEAN
      const desiredSQL = `
        CREATE TABLE case_sensitivity_test (
          id SERIAL PRIMARY KEY,
          mixed_case BOOLEAN
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify case-insensitive conversion
      const result = await client.query(
        "SELECT * FROM case_sensitivity_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(caseVariations.length);

      for (let i = 0; i < caseVariations.length; i++) {
        const expected = caseVariations[i]?.expected;
        const actual = result.rows[i]?.mixed_case;
        const originalValue = caseVariations[i]?.value;
        expect(
          actual,
          `Case-insensitive conversion for: ${originalValue}`
        ).toBe(expected);
      }
    });
  });

  describe("Invalid Boolean String Handling", () => {
    test("should handle invalid boolean strings gracefully", async () => {
      // 1. Create table with invalid boolean strings
      await client.query(`
        CREATE TABLE invalid_boolean_test (
          id SERIAL PRIMARY KEY,
          invalid_bool VARCHAR(20)
        );
      `);

      // Insert invalid boolean strings
      const invalidValues = [
        "maybe",
        "2",
        "-1",
        "TRUE_BUT_NOT_REALLY",
        "yep",
        "nope",
        "null",
        "", // Empty string
        " ", // Space only
        "truee", // Typo
        "flase", // Typo
        "ok",
        "not",
      ];

      for (const value of invalidValues) {
        await client.query(
          "INSERT INTO invalid_boolean_test (invalid_bool) VALUES ($1)",
          [value]
        );
      }

      // 2. Attempt to convert VARCHAR to BOOLEAN (should fail)
      const desiredSQL = `
        CREATE TABLE invalid_boolean_test (
          id SERIAL PRIMARY KEY,
          invalid_bool BOOLEAN
        );
      `;

      // 3. This should fail due to invalid boolean values
      try {
        await executeColumnMigration(client, desiredSQL, services);
        // If we get here, the test should fail because invalid values should be rejected
        expect(
          false,
          "Expected invalid boolean error but migration succeeded"
        ).toBe(true);
      } catch (error) {
        // Verify we get an appropriate boolean conversion error
        expect(error).toBeDefined();
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        expect(errorMessage.toLowerCase()).toMatch(/boolean|invalid/);
      }
    });

    test("should handle empty and whitespace strings", async () => {
      // 1. Create table with edge case strings
      await client.query(`
        CREATE TABLE whitespace_boolean_test (
          id SERIAL PRIMARY KEY,
          whitespace_bool VARCHAR(10)
        );
      `);

      // Insert whitespace and empty values
      const whitespaceValues = [
        " true ", // Padded true
        " false ", // Padded false
        "\ttrue\t", // Tab-padded true
        "\nfalse\n", // Newline-padded false
        " 1 ", // Padded 1
        " 0 ", // Padded 0
      ];

      for (const value of whitespaceValues) {
        await client.query(
          "INSERT INTO whitespace_boolean_test (whitespace_bool) VALUES ($1)",
          [value]
        );
      }

      // 2. Convert to BOOLEAN
      const desiredSQL = `
        CREATE TABLE whitespace_boolean_test (
          id SERIAL PRIMARY KEY,
          whitespace_bool BOOLEAN
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify whitespace is handled correctly
      const result = await client.query(
        "SELECT * FROM whitespace_boolean_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(whitespaceValues.length);

      const expectedResults = [true, false, true, false, true, false];
      for (let i = 0; i < expectedResults.length; i++) {
        expect(result.rows[i]?.whitespace_bool).toBe(expectedResults[i]);
      }
    });
  });

  describe("NULL to Boolean Conversions", () => {
    test("should handle NULL values in boolean conversions", async () => {
      // 1. Create table with nullable boolean column
      await client.query(`
        CREATE TABLE null_boolean_test (
          id SERIAL PRIMARY KEY,
          nullable_bool VARCHAR(10)
        );
      `);

      // Insert mix of NULL and boolean values
      await client.query(
        "INSERT INTO null_boolean_test (nullable_bool) VALUES ($1)",
        [null]
      );
      await client.query(
        "INSERT INTO null_boolean_test (nullable_bool) VALUES ($1)",
        ["true"]
      );
      await client.query(
        "INSERT INTO null_boolean_test (nullable_bool) VALUES ($1)",
        [null]
      );
      await client.query(
        "INSERT INTO null_boolean_test (nullable_bool) VALUES ($1)",
        ["false"]
      );
      await client.query(
        "INSERT INTO null_boolean_test (nullable_bool) VALUES ($1)",
        ["1"]
      );
      await client.query(
        "INSERT INTO null_boolean_test (nullable_bool) VALUES ($1)",
        [null]
      );

      // 2. Convert types while preserving NULLs
      const desiredSQL = `
        CREATE TABLE null_boolean_test (
          id SERIAL PRIMARY KEY,
          nullable_bool BOOLEAN
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify NULL preservation and value conversion
      const result = await client.query(
        "SELECT * FROM null_boolean_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(6);

      expect(result.rows[0]?.nullable_bool).toBeNull();
      expect(result.rows[1]?.nullable_bool).toBe(true);
      expect(result.rows[2]?.nullable_bool).toBeNull();
      expect(result.rows[3]?.nullable_bool).toBe(false);
      expect(result.rows[4]?.nullable_bool).toBe(true);
      expect(result.rows[5]?.nullable_bool).toBeNull();
    });
  });

  describe("Boolean to Other Type Conversions", () => {
    test("should convert BOOLEAN to VARCHAR", async () => {
      // 1. Create table with BOOLEAN column
      await client.query(`
        CREATE TABLE bool_to_string_test (
          id SERIAL PRIMARY KEY,
          bool_value BOOLEAN
        );
      `);

      // Insert boolean values
      await client.query(
        "INSERT INTO bool_to_string_test (bool_value) VALUES ($1)",
        [true]
      );
      await client.query(
        "INSERT INTO bool_to_string_test (bool_value) VALUES ($1)",
        [false]
      );
      await client.query(
        "INSERT INTO bool_to_string_test (bool_value) VALUES ($1)",
        [null]
      );
      await client.query(
        "INSERT INTO bool_to_string_test (bool_value) VALUES ($1)",
        [true]
      );

      // 2. Convert BOOLEAN to VARCHAR
      const desiredSQL = `
        CREATE TABLE bool_to_string_test (
          id SERIAL PRIMARY KEY,
          bool_value VARCHAR(10)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify boolean to string conversion
      const result = await client.query(
        "SELECT * FROM bool_to_string_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(4);

      expect(result.rows[0]?.bool_value).toBe("true");
      expect(result.rows[1]?.bool_value).toBe("false");
      expect(result.rows[2]?.bool_value).toBeNull();
      expect(result.rows[3]?.bool_value).toBe("true");

      // Verify column type change
      const finalColumns = await getTableColumns(client, "bool_to_string_test");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "bool_value",
        "character varying",
        "BOOLEAN to VARCHAR conversion"
      );
    });

    test("should convert BOOLEAN to INTEGER", async () => {
      // 1. Create table with BOOLEAN column
      await client.query(`
        CREATE TABLE bool_to_int_test (
          id SERIAL PRIMARY KEY,
          bool_value BOOLEAN
        );
      `);

      // Insert boolean values
      await client.query(
        "INSERT INTO bool_to_int_test (bool_value) VALUES ($1)",
        [true]
      );
      await client.query(
        "INSERT INTO bool_to_int_test (bool_value) VALUES ($1)",
        [false]
      );
      await client.query(
        "INSERT INTO bool_to_int_test (bool_value) VALUES ($1)",
        [true]
      );
      await client.query(
        "INSERT INTO bool_to_int_test (bool_value) VALUES ($1)",
        [false]
      );

      // 2. Convert BOOLEAN to INTEGER
      const desiredSQL = `
        CREATE TABLE bool_to_int_test (
          id SERIAL PRIMARY KEY,
          bool_value INTEGER
        );
      `;

      // 3. This should fail because BOOLEAN to INTEGER requires explicit USING clause
      try {
        await executeColumnMigration(client, desiredSQL, services);
        // If we get here, the test should fail because automatic casting should not work
        expect(false, "Expected casting error but migration succeeded").toBe(
          true
        );
      } catch (error) {
        // Verify we get an appropriate casting error
        expect(error).toBeDefined();
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        expect(errorMessage.toLowerCase()).toMatch(/cast|using|integer/);
      }
    });
  });

  describe("Performance with Large Boolean Datasets", () => {
    test("should handle large boolean dataset conversion efficiently", async () => {
      // 1. Create table with many boolean records
      await client.query(`
        CREATE TABLE large_boolean_perf (
          id SERIAL PRIMARY KEY,
          bool_string VARCHAR(10)
        );
      `);

      // Insert substantial boolean data
      const booleanValues = ["true", "false", "1", "0", "yes", "no", "t", "f"];
      const insertPromises = Array.from({ length: 1000 }, (_, i) => {
        const value = booleanValues[i % booleanValues.length];
        return client.query(
          "INSERT INTO large_boolean_perf (bool_string) VALUES ($1)",
          [value]
        );
      });
      await Promise.all(insertPromises);

      // Capture before state
      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "large_boolean_perf",
        "id"
      );

      // 2. Convert VARCHAR to BOOLEAN
      const desiredSQL = `
        CREATE TABLE large_boolean_perf (
          id SERIAL PRIMARY KEY,
          bool_string BOOLEAN
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
        "large_boolean_perf",
        "id"
      );

      expect(afterSnapshot.length).toBe(beforeSnapshot.length);
      expect(afterSnapshot.length).toBe(1000);

      // Verify boolean data conversion (sample check)
      for (let i = 0; i < Math.min(10, afterSnapshot.length); i++) {
        const beforeValue = beforeSnapshot[i]?.bool_string;
        const afterValue = afterSnapshot[i]?.bool_string;

        // Verify conversion logic
        if (
          beforeValue === "true" ||
          beforeValue === "1" ||
          beforeValue === "yes" ||
          beforeValue === "t"
        ) {
          expect(afterValue).toBe(true);
        } else if (
          beforeValue === "false" ||
          beforeValue === "0" ||
          beforeValue === "no" ||
          beforeValue === "f"
        ) {
          expect(afterValue).toBe(false);
        }
      }

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        8000,
        "large boolean dataset conversion"
      );

      // Verify column type changed
      const finalColumns = await getTableColumns(client, "large_boolean_perf");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "bool_string",
        "boolean",
        "large dataset VARCHAR to BOOLEAN"
      );
    });
  });
});
