import { describe, test, beforeEach, afterEach, expect } from "bun:test";
import { Client } from "pg";
import {
  createColumnTestServices,
  executeColumnMigration,
  EnhancedAssertions,
} from "../column-test-utils";
import { getTableColumns, TEST_DB_CONFIG } from "../../utils";
import { InvalidData } from "../test-data-generators";
import type { Column } from "../../../types/schema";

describe("Error Scenarios - Invalid Conversion Attempts", () => {
  let client: Client;
  let services: ReturnType<typeof createColumnTestServices>;

  beforeEach(async () => {
    client = new Client(TEST_DB_CONFIG);
    await client.connect();
    services = createColumnTestServices();
  });

  afterEach(async () => {
    try {
      await client.query(`DROP TABLE IF EXISTS test_table CASCADE;`);
    } catch (error) {
      // Ignore cleanup errors
    }
    await client.end();
  });

  describe("String to Numeric Conversion Failures", () => {
    test("should fail gracefully when converting non-numeric strings to INTEGER", async () => {
      // Setup table with non-numeric string data
      await client.query(`
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col VARCHAR(50)
        );
      `);

      const invalidData = InvalidData.nonNumeric;
      for (const value of invalidData) {
        await client.query(
          `INSERT INTO test_table (text_col) VALUES (${value});`
        );
      }

      const targetSQL = `
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY, 
          text_col INTEGER
        );
      `;

      // Test that migration fails with appropriate error
      await EnhancedAssertions.assertMigrationFailure(
        executeColumnMigration(client, targetSQL, services),
        /invalid input syntax for.*numeric/i,
        "String to INTEGER conversion with non-numeric data"
      );

      // Verify data rollback - original data should be intact
      const result = await client.query(
        `SELECT text_col FROM test_table ORDER BY id;`
      );
      expect(result.rows.length).toBe(invalidData.length);
      // Check that original data is preserved (first item in invalidData)
      const firstInvalidValue = invalidData[0]?.replace(/'/g, "") || ""; // Remove quotes
      expect(result.rows[0]?.text_col).toBe(firstInvalidValue);
    });

    test("should validate error messages for VARCHAR to DECIMAL conversion failures", async () => {
      await client.query(`
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col VARCHAR(100)
        );
      `);

      // Insert data that can't be converted to DECIMAL
      const problematicValues = [
        "'abc123'",
        "'12.34.56'", // Multiple decimal points
        "'$123.45'", // Currency symbol
        "'123,456.78'", // Comma separator
      ];

      for (const value of problematicValues) {
        await client.query(
          `INSERT INTO test_table (text_col) VALUES (${value});`
        );
      }

      const targetSQL = `
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col DECIMAL(10,2)
        );
      `;

      await EnhancedAssertions.assertMigrationFailure(
        executeColumnMigration(client, targetSQL, services),
        /(invalid input syntax|cannot be cast)/i,
        "VARCHAR to DECIMAL conversion with invalid formats"
      );
    });

    test("should handle mixed valid/invalid data appropriately", async () => {
      await client.query(`
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col VARCHAR(50)
        );
      `);

      // Mix of valid and invalid numeric strings
      const mixedData = [
        "'123'", // Valid
        "'456.78'", // Valid
        "'not_a_number'", // Invalid
        "'789'", // Valid
      ];

      for (const value of mixedData) {
        await client.query(
          `INSERT INTO test_table (text_col) VALUES (${value});`
        );
      }

      const targetSQL = `
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col INTEGER
        );
      `;

      // Should fail because of the one invalid row
      await EnhancedAssertions.assertMigrationFailure(
        executeColumnMigration(client, targetSQL, services),
        /invalid input syntax for.*numeric/i,
        "Mixed valid/invalid data conversion"
      );

      // Verify all original data is preserved
      const result = await client.query(`SELECT COUNT(*) FROM test_table;`);
      expect(parseInt(result.rows[0].count)).toBe(4);
    });
  });

  describe("Overflow and Boundary Violations", () => {
    test("should fail when INTEGER values exceed SMALLINT bounds", async () => {
      await client.query(`
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          int_col INTEGER
        );
      `);

      // Insert values that exceed SMALLINT range (-32768 to 32767)
      const overflowValues = [50000, -50000, 32768, -32769];
      for (const value of overflowValues) {
        await client.query(
          `INSERT INTO test_table (int_col) VALUES (${value});`
        );
      }

      const targetSQL = `
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          int_col SMALLINT
        );
      `;

      await EnhancedAssertions.assertMigrationFailure(
        executeColumnMigration(client, targetSQL, services),
        /(smallint out of range|value.*out of range)/i,
        "INTEGER to SMALLINT overflow"
      );
    });

    test("should fail when DECIMAL precision exceeds target precision", async () => {
      await client.query(`
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          decimal_col DECIMAL(10,4)
        );
      `);

      // Insert values that fit in DECIMAL(10,4) but exceed DECIMAL(5,2)
      const highPrecisionValues = [
        "999999.1234", // Fits in DECIMAL(10,4) but exceeds DECIMAL(5,2) total digits
        "999.1234", // Fits in DECIMAL(10,4) but exceeds DECIMAL(5,2) scale
      ];

      for (const value of highPrecisionValues) {
        await client.query(
          `INSERT INTO test_table (decimal_col) VALUES (${value});`
        );
      }

      const targetSQL = `
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          decimal_col DECIMAL(5,2)
        );
      `;

      await EnhancedAssertions.assertMigrationFailure(
        executeColumnMigration(client, targetSQL, services),
        /(numeric field overflow|value too long)/i,
        "DECIMAL precision overflow"
      );
    });
  });

  describe("Boolean Conversion Failures", () => {
    test("should fail gracefully with invalid boolean strings", async () => {
      await client.query(`
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col VARCHAR(50)
        );
      `);

      const invalidBooleans = [
        "maybe",
        "yes_no",
        "123",
        "not_a_bool",
        "TRUE_FALSE",
      ];
      for (const value of invalidBooleans) {
        await client.query(
          `INSERT INTO test_table (text_col) VALUES ('${value}');`
        );
      }

      const targetSQL = `
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col BOOLEAN
        );
      `;

      await EnhancedAssertions.assertMigrationFailure(
        executeColumnMigration(client, targetSQL, services),
        /(invalid input syntax for type boolean|cannot be cast)/i,
        "Invalid boolean string conversion"
      );
    });
  });

  describe("Transaction Rollback Testing", () => {
    test("should rollback transaction completely on migration failure", async () => {
      await client.query(`
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col VARCHAR(50),
          int_col INTEGER DEFAULT 100
        );
      `);

      // Insert some valid data
      await client.query(`
        INSERT INTO test_table (text_col) VALUES 
        ('valid_data_1'),
        ('valid_data_2'),
        ('invalid_for_int');
      `);

      // Get initial row count
      const initialCount = await client.query(
        `SELECT COUNT(*) FROM test_table;`
      );
      const originalRowCount = parseInt(initialCount.rows[0].count);

      // Attempt a failing migration (try to convert text_col to INTEGER)
      const targetSQL = `
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col INTEGER,
          int_col INTEGER DEFAULT 100
        );
      `;

      await EnhancedAssertions.assertMigrationFailure(
        executeColumnMigration(client, targetSQL, services),
        /invalid input syntax for.*numeric/i,
        "Migration with invalid data conversion"
      );

      // Verify transaction rollback
      await EnhancedAssertions.assertTransactionRollback(
        client,
        "test_table",
        originalRowCount,
        "Complete transaction rollback after migration failure"
      );

      // Verify original schema is intact
      const columns = await getTableColumns(client, "test_table");
      const textCol = columns.find((col) => col.name === "text_col");
      const intCol = columns.find((col) => col.name === "int_col");

      expect(textCol?.type).toContain("character varying");
      expect(intCol?.type).toBe("integer");
      expect(intCol?.default).toContain("100");
    });

    test("should handle partial failure in multi-column migration", async () => {
      await client.query(`
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          good_col VARCHAR(50),
          bad_col VARCHAR(50)
        );
      `);

      // Insert data where one column can convert, other cannot
      await client.query(`
        INSERT INTO test_table (good_col, bad_col) VALUES 
        ('123', 'abc'),
        ('456', 'def'),
        ('789', 'ghi');
      `);

      const originalCount = await client.query(
        `SELECT COUNT(*) FROM test_table;`
      );
      const rowCount = parseInt(originalCount.rows[0].count);

      // Try to convert both columns to INTEGER (bad_col should fail)
      const targetSQL = `
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          good_col INTEGER,
          bad_col INTEGER
        );
      `;

      await EnhancedAssertions.assertMigrationFailure(
        executeColumnMigration(client, targetSQL, services),
        /invalid input syntax for.*numeric/i,
        "Multi-column migration with partial failure"
      );

      // Verify complete rollback - both columns should be unchanged
      await EnhancedAssertions.assertTransactionRollback(
        client,
        "test_table",
        rowCount,
        "Partial failure rollback"
      );

      const columns = await getTableColumns(client, "test_table");
      const goodCol = columns.find((col) => col.name === "good_col");
      const badCol = columns.find((col) => col.name === "bad_col");

      expect(goodCol?.type).toContain("character varying");
      expect(badCol?.type).toContain("character varying");
    });
  });

  describe("Graceful Failure Handling", () => {
    test("should preserve database connectivity after migration failures", async () => {
      await client.query(`
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col VARCHAR(50)
        );
      `);

      await client.query(
        `INSERT INTO test_table (text_col) VALUES ('not_a_number');`
      );

      const targetSQL = `
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col INTEGER
        );
      `;

      // First migration should fail
      await EnhancedAssertions.assertMigrationFailure(
        executeColumnMigration(client, targetSQL, services),
        /invalid input syntax for.*numeric/i,
        "First migration failure"
      );

      // Database connection should still be usable
      const testQuery = await client.query(`SELECT 1 as test;`);
      expect(testQuery.rows[0].test).toBe(1);

      // Should be able to perform successful operations after failure
      await client.query(
        `INSERT INTO test_table (text_col) VALUES ('another_value');`
      );
      const result = await client.query(`SELECT COUNT(*) FROM test_table;`);
      expect(parseInt(result.rows[0].count)).toBe(2);
    });

    test("should handle constraint violations gracefully", async () => {
      await client.query(`
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col VARCHAR(50)
        );
      `);

      // Insert data including NULL values
      await client.query(`
        INSERT INTO test_table (text_col) VALUES 
        ('valid_data'),
        (NULL),
        ('more_data');
      `);

      // Try to make column NOT NULL (should fail due to existing NULL)
      const targetSQL = `
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          text_col VARCHAR(50) NOT NULL
        );
      `;

      await EnhancedAssertions.assertMigrationFailure(
        executeColumnMigration(client, targetSQL, services),
        /(null value|violates not-null constraint)/i,
        "NOT NULL constraint violation"
      );

      // Verify data is preserved and accessible
      const result = await client.query(`
        SELECT text_col FROM test_table ORDER BY id;
      `);
      expect(result.rows.length).toBe(3);
      expect(result.rows[0].text_col).toBe("valid_data");
      expect(result.rows[1].text_col).toBeNull();
      expect(result.rows[2].text_col).toBe("more_data");
    });
  });
});
