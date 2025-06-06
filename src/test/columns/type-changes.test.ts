import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  assertColumn,
} from "./column-test-utils";

describe("Column Type Changes - End to End", () => {
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

  describe("Compatible Type Changes", () => {
    test("should change column data type", async () => {
      // 1. Initial state: create table with column of one type
      await client.query(`
        CREATE TABLE documents (
          id SERIAL PRIMARY KEY,
          title VARCHAR(100) NOT NULL,
          content VARCHAR(500)
        );
      `);

      const initialColumns = await getTableColumns(client, "documents");
      expect(initialColumns).toHaveLength(3);

      // Verify initial data type
      assertColumn(initialColumns, "content", { type: "character varying" });

      // 2. Desired state: change column data type from VARCHAR to TEXT
      const desiredSQL = `
        CREATE TABLE documents (
          id SERIAL PRIMARY KEY,
          title VARCHAR(100) NOT NULL,
          content TEXT
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state - column type should be changed
      const finalColumns = await getTableColumns(client, "documents");
      expect(finalColumns).toHaveLength(3);

      assertColumn(finalColumns, "id", { type: "integer" });
      assertColumn(finalColumns, "title", { nullable: false });
      assertColumn(finalColumns, "content", { type: "text" });
    });
  });

  describe("Incompatible Type Changes", () => {
    test("should handle multiple column changes - type, nullable, and default", async () => {
      // 1. Initial state: create table with column that has specific properties
      await client.query(`
        CREATE TABLE accounts (
          id SERIAL PRIMARY KEY,
          balance VARCHAR(50) DEFAULT '0.00'
        );
      `);

      const initialColumns = await getTableColumns(client, "accounts");
      expect(initialColumns).toHaveLength(2);

      // Verify initial state
      assertColumn(initialColumns, "balance", {
        type: "character varying",
        nullable: true,
        default: "0.00",
      });

      // 2. Desired state: change type to DECIMAL, make NOT NULL, and change default
      const desiredSQL = `
        CREATE TABLE accounts (
          id SERIAL PRIMARY KEY,
          balance DECIMAL(10,2) NOT NULL DEFAULT 100.00
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state - all changes should be applied
      const finalColumns = await getTableColumns(client, "accounts");
      expect(finalColumns).toHaveLength(2);

      assertColumn(finalColumns, "balance", {
        type: "numeric",
        nullable: false,
        default: "100",
      });
    });
  });

  describe("More Compatible Type Changes", () => {
    test("should expand VARCHAR size", async () => {
      // 1. Initial state: table with limited VARCHAR
      await client.query(`
        CREATE TABLE messages (
          id SERIAL PRIMARY KEY,
          content VARCHAR(100)
        );
      `);

      // Insert data to verify preservation
      await client.query(
        "INSERT INTO messages (content) VALUES ('Short message')"
      );

      // 2. Desired state: expand VARCHAR size
      const desiredSQL = `
        CREATE TABLE messages (
          id SERIAL PRIMARY KEY,
          content VARCHAR(500)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify type changed and data preserved
      const finalColumns = await getTableColumns(client, "messages");
      const contentColumn = finalColumns.find((col) => col.name === "content");
      expect(contentColumn?.type).toContain("character varying");

      // Verify data preservation
      const result = await client.query("SELECT content FROM messages");
      expect(result.rows[0].content).toBe("Short message");
    });

    test("should change INTEGER to BIGINT", async () => {
      // 1. Initial state: table with INTEGER
      await client.query(`
        CREATE TABLE counters (
          id SERIAL PRIMARY KEY,
          value INTEGER
        );
      `);

      // Insert test data
      await client.query("INSERT INTO counters (value) VALUES (42)");

      const initialColumns = await getTableColumns(client, "counters");
      assertColumn(initialColumns, "value", { type: "integer" });

      // 2. Desired state: change to BIGINT
      const desiredSQL = `
        CREATE TABLE counters (
          id SERIAL PRIMARY KEY,
          value BIGINT
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify type changed and data preserved
      const finalColumns = await getTableColumns(client, "counters");
      assertColumn(finalColumns, "value", { type: "bigint" });

      const result = await client.query("SELECT value FROM counters");
      expect(parseInt(result.rows[0].value)).toBe(42);
    });

    test("should expand DECIMAL precision and scale", async () => {
      // 1. Initial state: table with limited precision DECIMAL
      await client.query(`
        CREATE TABLE prices (
          id SERIAL PRIMARY KEY,
          amount DECIMAL(10,2)
        );
      `);

      // Insert test data
      await client.query("INSERT INTO prices (amount) VALUES (123.45)");

      // 2. Desired state: expand precision and scale
      const desiredSQL = `
        CREATE TABLE prices (
          id SERIAL PRIMARY KEY,
          amount DECIMAL(12,4)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify type changed and data preserved
      const finalColumns = await getTableColumns(client, "prices");
      assertColumn(finalColumns, "amount", { type: "numeric" });

      const result = await client.query("SELECT amount FROM prices");
      expect(parseFloat(result.rows[0].amount)).toBe(123.45);
    });
  });

  describe("More Incompatible Type Changes", () => {
    test("should convert INTEGER to VARCHAR", async () => {
      // 1. Initial state: table with INTEGER data
      await client.query(`
        CREATE TABLE codes (
          id SERIAL PRIMARY KEY,
          number INTEGER
        );
      `);

      // Insert numeric data
      await client.query("INSERT INTO codes (number) VALUES (12345)");
      await client.query("INSERT INTO codes (number) VALUES (67890)");

      // 2. Desired state: convert to VARCHAR
      const desiredSQL = `
        CREATE TABLE codes (
          id SERIAL PRIMARY KEY,
          number VARCHAR(20)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify type changed and data preserved
      const finalColumns = await getTableColumns(client, "codes");
      assertColumn(finalColumns, "number", { type: "character varying" });

      const result = await client.query("SELECT number FROM codes ORDER BY id");
      expect(result.rows[0].number).toBe("12345");
      expect(result.rows[1].number).toBe("67890");
    });

    test("should convert VARCHAR to BOOLEAN", async () => {
      // 1. Initial state: table with boolean-like strings
      await client.query(`
        CREATE TABLE flags (
          id SERIAL PRIMARY KEY,
          active VARCHAR(10)
        );
      `);

      // Insert boolean-like data
      await client.query("INSERT INTO flags (active) VALUES ('true')");
      await client.query("INSERT INTO flags (active) VALUES ('false')");

      // 2. Desired state: convert to BOOLEAN
      const desiredSQL = `
        CREATE TABLE flags (
          id SERIAL PRIMARY KEY,
          active BOOLEAN
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify type changed and data preserved
      const finalColumns = await getTableColumns(client, "flags");
      assertColumn(finalColumns, "active", { type: "boolean" });

      const result = await client.query("SELECT active FROM flags ORDER BY id");
      expect(result.rows[0].active).toBe(true);
      expect(result.rows[1].active).toBe(false);
    });
  });
});
