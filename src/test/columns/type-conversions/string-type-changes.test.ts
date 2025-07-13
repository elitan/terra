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
import {
  StringEdgeCases,
  UnicodeTestData,
  POSTGRES_LIMITS,
} from "../test-data-generators";

describe("String Type Conversions and Edge Cases", () => {
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

  describe("Unicode and Multi-byte Character Testing", () => {
    test("should handle Unicode characters in VARCHAR to TEXT conversion", async () => {
      // 1. Create table with Unicode data
      await client.query(`
        CREATE TABLE unicode_test (
          id SERIAL PRIMARY KEY,
          unicode_field VARCHAR(255)
        );
      `);

      // Insert comprehensive Unicode test data
      const unicodeData = UnicodeTestData.getComprehensiveSet();
      for (const [description, value] of unicodeData) {
        await client.query(
          "INSERT INTO unicode_test (unicode_field) VALUES ($1)",
          [value]
        );
      }

      // 2. Convert VARCHAR to TEXT (should preserve all Unicode)
      const desiredSQL = `
        CREATE TABLE unicode_test (
          id SERIAL PRIMARY KEY,
          unicode_field TEXT
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify Unicode preservation
      const result = await client.query(
        "SELECT * FROM unicode_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(unicodeData.length);

      // Verify each Unicode string is preserved exactly
      for (let i = 0; i < unicodeData.length; i++) {
        const testCase = unicodeData[i];
        if (testCase) {
          const [description, expectedValue] = testCase;
          const actualValue = result.rows[i]?.unicode_field;
          expect(actualValue, `Unicode preservation for: ${description}`).toBe(
            expectedValue
          );
        }
      }

      // Verify column type change
      const finalColumns = await getTableColumns(client, "unicode_test");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "unicode_field",
        "text",
        "Unicode conversion"
      );
    });

    test("should handle multi-byte characters in length-constrained VARCHAR", async () => {
      // 1. Create table with short VARCHAR
      await client.query(`
        CREATE TABLE mb_test (
          id SERIAL PRIMARY KEY,
          short_field VARCHAR(10)
        );
      `);

      // Insert multi-byte characters that fit within byte limit but may exceed character limit
      const multiByte = UnicodeTestData.getMultiByteCharacters();
      for (const char of multiByte.slice(0, 5)) {
        // Test first 5 to stay within limits
        await client.query(
          "INSERT INTO mb_test (short_field) VALUES ($1)",
          [char.repeat(3)] // 3 characters that might be 6+ bytes
        );
      }

      // 2. Convert to longer VARCHAR
      const desiredSQL = `
        CREATE TABLE mb_test (
          id SERIAL PRIMARY KEY,
          short_field VARCHAR(50)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify data preservation
      const result = await client.query("SELECT * FROM mb_test ORDER BY id");
      expect(result.rows).toHaveLength(5);

      // Verify column type change
      const finalColumns = await getTableColumns(client, "mb_test");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "short_field",
        "character varying",
        "multi-byte conversion"
      );
    });

    test("should handle emoji and special Unicode symbols", async () => {
      // 1. Create table with emoji data
      await client.query(`
        CREATE TABLE emoji_test (
          id SERIAL PRIMARY KEY,
          content VARCHAR(100)
        );
      `);

      const emojiTestCases = UnicodeTestData.getEmojiTestSet();
      for (const emoji of emojiTestCases) {
        await client.query("INSERT INTO emoji_test (content) VALUES ($1)", [
          emoji,
        ]);
      }

      // 2. Convert VARCHAR to TEXT
      const desiredSQL = `
        CREATE TABLE emoji_test (
          id SERIAL PRIMARY KEY,
          content TEXT
        );
      `;

      // 3. Execute migration with performance tracking
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify emoji preservation
      const result = await client.query("SELECT * FROM emoji_test ORDER BY id");
      expect(result.rows).toHaveLength(emojiTestCases.length);

      for (let i = 0; i < emojiTestCases.length; i++) {
        expect(result.rows[i].content).toBe(emojiTestCases[i]);
      }

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        3000,
        "emoji Unicode conversion"
      );
    });
  });

  describe("Length Limit Boundary Testing", () => {
    test("should handle VARCHAR length limit boundaries", async () => {
      // 1. Create table with specific VARCHAR limit
      await client.query(`
        CREATE TABLE length_test (
          id SERIAL PRIMARY KEY,
          bounded_field VARCHAR(50)
        );
      `);

      // Insert strings at various length boundaries
      const lengthTestCases = [
        { description: "empty string", value: "" },
        { description: "single char", value: "a" },
        { description: "at limit", value: "a".repeat(50) },
        { description: "unicode at limit", value: "ñ".repeat(25) }, // Multi-byte chars
      ];

      for (const testCase of lengthTestCases) {
        await client.query(
          "INSERT INTO length_test (bounded_field) VALUES ($1)",
          [testCase.value]
        );
      }

      // 2. Convert to larger VARCHAR
      const desiredSQL = `
        CREATE TABLE length_test (
          id SERIAL PRIMARY KEY,
          bounded_field VARCHAR(200)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify all length test cases preserved
      const result = await client.query(
        "SELECT * FROM length_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(lengthTestCases.length);

      for (let i = 0; i < lengthTestCases.length; i++) {
        expect(result.rows[i]?.bounded_field).toBe(lengthTestCases[i]?.value);
      }

      // Verify column type change
      const finalColumns = await getTableColumns(client, "length_test");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "bounded_field",
        "character varying",
        "length boundary test"
      );
    });

    test("should handle conversion from VARCHAR to TEXT with very long strings", async () => {
      // 1. Create table with long VARCHAR
      await client.query(`
        CREATE TABLE long_string_test (
          id SERIAL PRIMARY KEY,
          long_field VARCHAR(1000)
        );
      `);

      // Insert strings of various lengths including very long ones
      const longStringCases = StringEdgeCases.getVeryLongStrings();
      for (const longString of longStringCases.slice(0, 3)) {
        // Test first 3 to avoid timeout
        await client.query(
          "INSERT INTO long_string_test (long_field) VALUES ($1)",
          [longString]
        );
      }

      // 2. Convert VARCHAR to TEXT (removes length limit)
      const desiredSQL = `
        CREATE TABLE long_string_test (
          id SERIAL PRIMARY KEY,
          long_field TEXT
        );
      `;

      // 3. Execute migration with performance measurement
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify long strings preserved
      const result = await client.query(
        "SELECT * FROM long_string_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(3);

      // Verify strings are preserved exactly
      for (let i = 0; i < 3; i++) {
        expect(result.rows[i].long_field).toBe(longStringCases[i]);
      }

      // Verify performance reasonable for large strings
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        5000,
        "long string conversion"
      );
    });
  });

  describe("Special Characters and Escape Sequences", () => {
    test("should handle SQL escape sequences and special characters", async () => {
      // 1. Create table for special character testing
      await client.query(`
        CREATE TABLE special_chars_test (
          id SERIAL PRIMARY KEY,
          special_field VARCHAR(255)
        );
      `);

      // Insert strings with SQL-relevant special characters
      const specialChars = StringEdgeCases.getSQLSpecialCharacters();
      for (const specialString of specialChars) {
        await client.query(
          "INSERT INTO special_chars_test (special_field) VALUES ($1)",
          [specialString]
        );
      }

      // 2. Convert VARCHAR to TEXT
      const desiredSQL = `
        CREATE TABLE special_chars_test (
          id SERIAL PRIMARY KEY,
          special_field TEXT
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify special characters preserved
      const result = await client.query(
        "SELECT * FROM special_chars_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(specialChars.length);

      for (let i = 0; i < specialChars.length; i++) {
        expect(result.rows[i].special_field).toBe(specialChars[i]);
      }
    });

    test("should handle newlines, tabs, and control characters", async () => {
      // 1. Create table
      await client.query(`
        CREATE TABLE control_chars_test (
          id SERIAL PRIMARY KEY,
          content VARCHAR(100)
        );
      `);

      // Test various control characters
      const controlCharacters = [
        "Line 1\nLine 2", // Newline
        "Tab\tSeparated\tValues", // Tabs
        "Carriage\rReturn", // Carriage return
        "Form\fFeed", // Form feed
        "Backspace\bTest", // Backspace
        "Special Character", // Replaced null character
        "Mixed\n\t\rControl", // Multiple control chars
      ];

      for (const controlString of controlCharacters) {
        await client.query(
          "INSERT INTO control_chars_test (content) VALUES ($1)",
          [controlString]
        );
      }

      // 2. Convert to TEXT
      const desiredSQL = `
        CREATE TABLE control_chars_test (
          id SERIAL PRIMARY KEY,
          content TEXT
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify control characters preserved
      const result = await client.query(
        "SELECT * FROM control_chars_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(controlCharacters.length);

      for (let i = 0; i < controlCharacters.length; i++) {
        expect(result.rows[i].content).toBe(controlCharacters[i]);
      }
    });
  });

  describe("Empty Strings and Whitespace Scenarios", () => {
    test("should handle empty strings and NULL values", async () => {
      // 1. Create table with nullable field
      await client.query(`
        CREATE TABLE empty_test (
          id SERIAL PRIMARY KEY,
          nullable_field VARCHAR(100)
        );
      `);

      // Insert various empty/null scenarios
      await client.query(
        "INSERT INTO empty_test (nullable_field) VALUES ($1)",
        [""]
      ); // Empty string
      await client.query(
        "INSERT INTO empty_test (nullable_field) VALUES ($1)",
        [null]
      ); // NULL
      await client.query(
        "INSERT INTO empty_test (nullable_field) VALUES ($1)",
        [" "]
      ); // Single space
      await client.query(
        "INSERT INTO empty_test (nullable_field) VALUES ($1)",
        ["   "]
      ); // Multiple spaces
      await client.query(
        "INSERT INTO empty_test (nullable_field) VALUES ($1)",
        ["\t"]
      ); // Tab only
      await client.query(
        "INSERT INTO empty_test (nullable_field) VALUES ($1)",
        ["\n"]
      ); // Newline only

      // 2. Convert VARCHAR to TEXT
      const desiredSQL = `
        CREATE TABLE empty_test (
          id SERIAL PRIMARY KEY,
          nullable_field TEXT
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify empty/null handling
      const result = await client.query("SELECT * FROM empty_test ORDER BY id");
      expect(result.rows).toHaveLength(6);

      expect(result.rows[0].nullable_field).toBe(""); // Empty string preserved
      expect(result.rows[1].nullable_field).toBeNull(); // NULL preserved
      expect(result.rows[2].nullable_field).toBe(" "); // Single space preserved
      expect(result.rows[3].nullable_field).toBe("   "); // Multiple spaces preserved
      expect(result.rows[4].nullable_field).toBe("\t"); // Tab preserved
      expect(result.rows[5].nullable_field).toBe("\n"); // Newline preserved
    });

    test("should handle whitespace-only strings with different types", async () => {
      // 1. Create table
      await client.query(`
        CREATE TABLE whitespace_test (
          id SERIAL PRIMARY KEY,
          whitespace_field VARCHAR(50)
        );
      `);

      // Test various whitespace patterns
      const whitespacePatterns = StringEdgeCases.getWhitespacePatterns();
      for (const pattern of whitespacePatterns) {
        await client.query(
          "INSERT INTO whitespace_test (whitespace_field) VALUES ($1)",
          [pattern]
        );
      }

      // 2. Convert to TEXT
      const desiredSQL = `
        CREATE TABLE whitespace_test (
          id SERIAL PRIMARY KEY,
          whitespace_field TEXT
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify whitespace preservation
      const result = await client.query(
        "SELECT * FROM whitespace_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(whitespacePatterns.length);

      for (let i = 0; i < whitespacePatterns.length; i++) {
        expect(result.rows[i].whitespace_field).toBe(whitespacePatterns[i]);
      }
    });
  });

  describe("SQL Injection Pattern Resistance", () => {
    test("should safely handle potential SQL injection strings", async () => {
      // 1. Create table
      await client.query(`
        CREATE TABLE injection_test (
          id SERIAL PRIMARY KEY,
          content VARCHAR(255)
        );
      `);

      // Test strings that could be problematic if not properly escaped
      const injectionPatterns = StringEdgeCases.getSQLInjectionPatterns();
      for (const pattern of injectionPatterns) {
        await client.query("INSERT INTO injection_test (content) VALUES ($1)", [
          pattern,
        ]);
      }

      // 2. Convert VARCHAR to TEXT
      const desiredSQL = `
        CREATE TABLE injection_test (
          id SERIAL PRIMARY KEY,
          content TEXT
        );
      `;

      // 3. Execute migration - should complete safely
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify all injection patterns stored as literal strings
      const result = await client.query(
        "SELECT * FROM injection_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(injectionPatterns.length);

      // Verify table still exists and has correct structure
      const tables = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'injection_test'"
      );
      expect(tables.rows).toHaveLength(1);

      // Verify all problematic strings are stored as literal data
      for (let i = 0; i < injectionPatterns.length; i++) {
        expect(result.rows[i].content).toBe(injectionPatterns[i]);
      }
    });
  });

  describe("Performance with Large String Datasets", () => {
    test("should handle large string conversion efficiently", async () => {
      // 1. Create table with many string records
      await client.query(`
        CREATE TABLE large_string_perf (
          id SERIAL PRIMARY KEY,
          data_field VARCHAR(500)
        );
      `);

      // Insert substantial string data
      const testStrings = StringEdgeCases.getVeryLongStrings();
      const insertPromises = Array.from({ length: 200 }, (_, i) => {
        const testString = testStrings[i % testStrings.length];
        return client.query(
          "INSERT INTO large_string_perf (data_field) VALUES ($1)",
          [testString?.slice(0, 400) || "fallback_string"] // Truncate to fit VARCHAR(500)
        );
      });
      await Promise.all(insertPromises);

      // Capture before state
      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "large_string_perf",
        "id"
      );

      // 2. Convert VARCHAR to TEXT
      const desiredSQL = `
        CREATE TABLE large_string_perf (
          id SERIAL PRIMARY KEY,
          data_field TEXT
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
        "large_string_perf",
        "id"
      );

      expect(afterSnapshot.length).toBe(beforeSnapshot.length);
      expect(afterSnapshot.length).toBe(200);

      // Verify string data preservation (sample check)
      for (let i = 0; i < Math.min(10, afterSnapshot.length); i++) {
        expect(afterSnapshot[i].data_field).toBe(beforeSnapshot[i].data_field);
      }

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        10000,
        "large string dataset conversion"
      );
    });
  });
});
