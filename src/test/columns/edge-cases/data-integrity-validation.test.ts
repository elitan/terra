import { describe, test, beforeEach, afterEach, expect } from "bun:test";
import { Client } from "pg";
import {
  createColumnTestServices,
  executeColumnMigration,
  DataIntegrityUtils,
} from "../column-test-utils";
import { getTableColumns, createTestClient } from "../../utils";
import { BoundaryValues } from "../test-data-generators";
import type { Column } from "../../../types/schema";

describe("Data Integrity Validation", () => {
  let client: Client;
  let services: ReturnType<typeof createColumnTestServices>;

  beforeEach(async () => {
    client = await createTestClient();
    services = createColumnTestServices();
  });

  afterEach(async () => {
    try {
      await client.query(`DROP TABLE IF EXISTS integrity_test CASCADE;`);
    } catch (error) {
      // Ignore cleanup errors
    }
    await client.end();
  });

  describe("Value Preservation During Type Changes", () => {
    test("should preserve exact integer values during INTEGER to BIGINT conversion", async () => {
      await client.query(`
        CREATE TABLE integrity_test (
          id SERIAL PRIMARY KEY,
          int_col INTEGER
        );
      `);

      const testValues = [1, 100, -50, 32767, -32768];
      for (const value of testValues) {
        await client.query(
          `INSERT INTO integrity_test (int_col) VALUES (${value});`
        );
      }

      // Capture before snapshot
      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "integrity_test",
        "id"
      );

      // Execute conversion
      const targetSQL = `
        CREATE TABLE integrity_test (
          id SERIAL PRIMARY KEY,
          int_col BIGINT
        );
      `;

      await executeColumnMigration(client, targetSQL, services);

      // Capture after snapshot
      const afterSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "integrity_test",
        "id"
      );

      // Verify data preservation
      await DataIntegrityUtils.verifyDataPreservation(
        beforeSnapshot,
        afterSnapshot,
        "int_col"
      );

      // Verify type change occurred
      const columns = await getTableColumns(client, "integrity_test");
      const intCol = columns.find((col: Column) => col.name === "int_col");
      expect(intCol?.type).toBe("bigint");
    });

    test("should preserve string content during VARCHAR to TEXT conversion", async () => {
      await client.query(`
        CREATE TABLE integrity_test (
          id SERIAL PRIMARY KEY,
          text_col VARCHAR(100)
        );
      `);

      const testStrings = [
        "Simple text",
        "Text with 'quotes'",
        "Unicode: 🚀",
        "", // Empty string
      ];

      for (let i = 0; i < testStrings.length; i++) {
        await client.query(
          `INSERT INTO integrity_test (text_col) VALUES ($1);`,
          [testStrings[i]]
        );
      }

      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "integrity_test",
        "id"
      );

      const targetSQL = `
        CREATE TABLE integrity_test (
          id SERIAL PRIMARY KEY,
          text_col TEXT
        );
      `;

      await executeColumnMigration(client, targetSQL, services);

      const afterSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "integrity_test",
        "id"
      );

      await DataIntegrityUtils.verifyDataPreservation(
        beforeSnapshot,
        afterSnapshot,
        "text_col"
      );

      // Verify type change
      const columns = await getTableColumns(client, "integrity_test");
      const textCol = columns.find((col: Column) => col.name === "text_col");
      expect(textCol?.type).toBe("text");
    });

    test("should preserve valid numeric strings during VARCHAR to INTEGER conversion", async () => {
      await client.query(`
        CREATE TABLE integrity_test (
          id SERIAL PRIMARY KEY,
          text_col VARCHAR(50)
        );
      `);

      const numericStrings = ["123", "456", "0", "-789"];
      for (const value of numericStrings) {
        await client.query(
          `INSERT INTO integrity_test (text_col) VALUES ('${value}');`
        );
      }

      const targetSQL = `
        CREATE TABLE integrity_test (
          id SERIAL PRIMARY KEY,
          text_col INTEGER
        );
      `;

      await executeColumnMigration(client, targetSQL, services);

      // Verify conversion results manually
      const result = await client.query(`
        SELECT text_col FROM integrity_test ORDER BY id;
      `);

      expect(result.rows[0].text_col).toBe(123);
      expect(result.rows[1].text_col).toBe(456);
      expect(result.rows[2].text_col).toBe(0);
      expect(result.rows[3].text_col).toBe(-789);

      // Verify type change
      const columns = await getTableColumns(client, "integrity_test");
      const textCol = columns.find((col: Column) => col.name === "text_col");
      expect(textCol?.type).toBe("integer");
    });
  });

  describe("NULL Value Handling", () => {
    test("should preserve NULL values during type conversions", async () => {
      await client.query(`
        CREATE TABLE integrity_test (
          id SERIAL PRIMARY KEY,
          nullable_col VARCHAR(50)
        );
      `);

      // Insert mix of values and NULLs
      await client.query(`
        INSERT INTO integrity_test (nullable_col) VALUES 
        ('value1'),
        (NULL),
        ('value2'),
        (NULL);
      `);

      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "integrity_test",
        "id"
      );

      const targetSQL = `
        CREATE TABLE integrity_test (
          id SERIAL PRIMARY KEY,
          nullable_col TEXT
        );
      `;

      await executeColumnMigration(client, targetSQL, services);

      const afterSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "integrity_test",
        "id"
      );

      await DataIntegrityUtils.verifyDataPreservation(
        beforeSnapshot,
        afterSnapshot,
        "nullable_col"
      );

      // Verify NULL positions are preserved
      const result = await client.query(`
        SELECT nullable_col FROM integrity_test ORDER BY id;
      `);

      expect(result.rows[0].nullable_col).toBe("value1");
      expect(result.rows[1].nullable_col).toBeNull();
      expect(result.rows[2].nullable_col).toBe("value2");
      expect(result.rows[3].nullable_col).toBeNull();
    });
  });

  describe("Large Dataset Integrity", () => {
    test("should preserve data integrity with larger datasets", async () => {
      await client.query(`
        CREATE TABLE integrity_test (
          id SERIAL PRIMARY KEY,
          text_col VARCHAR(100)
        );
      `);

      // Insert moderately large dataset
      const largeDataset = Array.from(
        { length: 1000 },
        (_, i) => `'Record_${i.toString().padStart(4, "0")}'`
      );

      // Insert in batches
      await DataIntegrityUtils.insertTestDataSafely(
        client,
        "integrity_test",
        "text_col",
        largeDataset,
        200 // batch size
      );

      const beforeCount = await client.query(
        `SELECT COUNT(*) FROM integrity_test;`
      );
      const beforeSample = await client.query(`
        SELECT text_col FROM integrity_test WHERE id <= 10 ORDER BY id;
      `);

      const targetSQL = `
        CREATE TABLE integrity_test (
          id SERIAL PRIMARY KEY,
          text_col TEXT
        );
      `;

      await executeColumnMigration(client, targetSQL, services);

      const afterCount = await client.query(
        `SELECT COUNT(*) FROM integrity_test;`
      );
      const afterSample = await client.query(`
        SELECT text_col FROM integrity_test WHERE id <= 10 ORDER BY id;
      `);

      // Verify row count preservation
      expect(afterCount.rows[0].count).toBe(beforeCount.rows[0].count);
      expect(parseInt(afterCount.rows[0].count)).toBe(1000);

      // Verify sample data preservation
      for (let i = 0; i < beforeSample.rows.length; i++) {
        expect(afterSample.rows[i].text_col).toBe(
          beforeSample.rows[i].text_col
        );
      }
    });
  });

  describe("Edge Case Data Preservation", () => {
    test("should handle special characters and unicode correctly", async () => {
      await client.query(`
        CREATE TABLE integrity_test (
          id SERIAL PRIMARY KEY,
          text_col VARCHAR(200)
        );
      `);

      const specialCases = [
        "Regular text",
        "Text with 'single quotes'",
        'Text with "double quotes"',
        "Text with\nnewlines",
        "Unicode: 世界 🌍",
        "Empty case: ",
        "   Whitespace   ",
      ];

      for (let i = 0; i < specialCases.length; i++) {
        await client.query(
          `INSERT INTO integrity_test (text_col) VALUES ($1);`,
          [specialCases[i]]
        );
      }

      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "integrity_test",
        "id"
      );

      const targetSQL = `
        CREATE TABLE integrity_test (
          id SERIAL PRIMARY KEY,
          text_col TEXT
        );
      `;

      await executeColumnMigration(client, targetSQL, services);

      const afterSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "integrity_test",
        "id"
      );

      await DataIntegrityUtils.verifyDataPreservation(
        beforeSnapshot,
        afterSnapshot,
        "text_col"
      );

      // Additional verification for special cases
      const result = await client.query(`
        SELECT text_col FROM integrity_test ORDER BY id;
      `);

      for (let i = 0; i < specialCases.length; i++) {
        expect(result.rows[i].text_col).toBe(specialCases[i]);
      }
    });
  });
});
