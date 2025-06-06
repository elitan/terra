import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  assertColumn,
  assertColumnNotExists,
} from "./column-test-utils";

describe("Basic Column Operations - End to End", () => {
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

  describe("Adding Columns", () => {
    test("should add new columns to existing table", async () => {
      // 1. Initial state: create table with basic columns
      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL
        );
      `);

      const initialColumns = await getTableColumns(client, "users");
      expect(initialColumns).toHaveLength(2);

      // 2. Desired state: SQL with additional columns
      const desiredSQL = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          email VARCHAR(255),
          age INTEGER
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state
      const finalColumns = await getTableColumns(client, "users");
      expect(finalColumns).toHaveLength(4);

      assertColumn(finalColumns, "id", { type: "integer" });
      assertColumn(finalColumns, "name", { nullable: false });
      assertColumn(finalColumns, "email", { nullable: true });
      assertColumn(finalColumns, "age", { type: "integer" });
    });

    test("should handle columns with different data types", async () => {
      // 1. Initial state: simple table
      await client.query(`
        CREATE TABLE test_types (
          id SERIAL PRIMARY KEY
        );
      `);

      // 2. Desired state: add columns with various data types
      const desiredSQL = `
        CREATE TABLE test_types (
          id SERIAL PRIMARY KEY,
          text_field TEXT,
          varchar_field VARCHAR(255),
          integer_field INTEGER,
          decimal_field DECIMAL(10,2),
          boolean_field BOOLEAN
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state
      const finalColumns = await getTableColumns(client, "test_types");
      expect(finalColumns).toHaveLength(6);

      assertColumn(finalColumns, "text_field", { type: "text" });
      assertColumn(finalColumns, "varchar_field", {
        type: "character varying",
      });
      assertColumn(finalColumns, "integer_field", { type: "integer" });
      assertColumn(finalColumns, "decimal_field", { type: "numeric" });
      assertColumn(finalColumns, "boolean_field", { type: "boolean" });
    });

    test("should handle columns with simple default values", async () => {
      // 1. Initial state: simple table
      await client.query(`
        CREATE TABLE settings (
          id SERIAL PRIMARY KEY
        );
      `);

      // 2. Desired state: add columns with simple defaults
      const desiredSQL = `
        CREATE TABLE settings (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          value TEXT DEFAULT 'default_value',
          priority INTEGER DEFAULT 0
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state
      const finalColumns = await getTableColumns(client, "settings");
      expect(finalColumns).toHaveLength(4);

      assertColumn(finalColumns, "name", { nullable: false });
      assertColumn(finalColumns, "value", { default: "default_value" });
      assertColumn(finalColumns, "priority", { default: "0" });
    });
  });

  describe("Removing Columns", () => {
    test("should remove columns from existing table", async () => {
      // 1. Initial state: create table with multiple columns
      await client.query(`
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          old_field VARCHAR(100),
          deprecated_column INTEGER
        );
      `);

      const initialColumns = await getTableColumns(client, "products");
      expect(initialColumns).toHaveLength(5);

      // 2. Desired state: SQL with fewer columns
      const desiredSQL = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state
      const finalColumns = await getTableColumns(client, "products");
      expect(finalColumns).toHaveLength(3);

      assertColumn(finalColumns, "id", { type: "integer" });
      assertColumn(finalColumns, "name", { nullable: false });
      assertColumn(finalColumns, "description", { type: "text" });
      assertColumnNotExists(finalColumns, "old_field");
      assertColumnNotExists(finalColumns, "deprecated_column");
    });
  });

  describe("Mixed Operations", () => {
    test("should handle mixed column operations - add, keep, and remove", async () => {
      // 1. Initial state: create table with some columns
      await client.query(`
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_name VARCHAR(255),
          old_status VARCHAR(50),
          temp_field INTEGER
        );
      `);

      const initialColumns = await getTableColumns(client, "orders");
      expect(initialColumns).toHaveLength(4);

      // 2. Desired state: keep some columns, remove others, add new ones
      const desiredSQL = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_name VARCHAR(255),
          status VARCHAR(100) NOT NULL,
          total_amount DECIMAL(10,2)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state
      const finalColumns = await getTableColumns(client, "orders");
      expect(finalColumns).toHaveLength(4);

      assertColumn(finalColumns, "id", { type: "integer" });
      assertColumn(finalColumns, "customer_name", {
        type: "character varying",
      });
      assertColumn(finalColumns, "status", { nullable: false });
      assertColumn(finalColumns, "total_amount", { type: "numeric" });
      assertColumnNotExists(finalColumns, "old_status");
      assertColumnNotExists(finalColumns, "temp_field");
    });
  });
});
