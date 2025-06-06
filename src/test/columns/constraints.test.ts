import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  assertColumn,
} from "./column-test-utils";

describe("Column Constraints - End to End", () => {
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

  describe("NULL/NOT NULL Constraints", () => {
    test("should change column from nullable to NOT NULL", async () => {
      // 1. Initial state: create table with nullable column
      await client.query(`
        CREATE TABLE profiles (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        );
      `);

      const initialColumns = await getTableColumns(client, "profiles");
      expect(initialColumns).toHaveLength(2);

      // Verify initial nullable state
      assertColumn(initialColumns, "email", { nullable: true });

      // 2. Desired state: make email column NOT NULL
      const desiredSQL = `
        CREATE TABLE profiles (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state - column should be NOT NULL
      const finalColumns = await getTableColumns(client, "profiles");
      expect(finalColumns).toHaveLength(2);

      assertColumn(finalColumns, "email", { nullable: false });
    });

    test("should change column from NOT NULL to nullable", async () => {
      // 1. Initial state: create table with NOT NULL column
      await client.query(`
        CREATE TABLE contacts (
          id SERIAL PRIMARY KEY,
          phone VARCHAR(20) NOT NULL
        );
      `);

      const initialColumns = await getTableColumns(client, "contacts");
      expect(initialColumns).toHaveLength(2);

      // Verify initial NOT NULL state
      assertColumn(initialColumns, "phone", { nullable: false });

      // 2. Desired state: make phone column nullable
      const desiredSQL = `
        CREATE TABLE contacts (
          id SERIAL PRIMARY KEY,
          phone VARCHAR(20)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state - column should be nullable
      const finalColumns = await getTableColumns(client, "contacts");
      expect(finalColumns).toHaveLength(2);

      assertColumn(finalColumns, "phone", { nullable: true });
    });
  });

  describe("Default Value Changes", () => {
    test("should add default value to column", async () => {
      // 1. Initial state: create table with column that has no default
      await client.query(`
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          status VARCHAR(50)
        );
      `);

      const initialColumns = await getTableColumns(client, "products");
      expect(initialColumns).toHaveLength(2);

      // Verify no initial default value
      assertColumn(initialColumns, "status", { default: null });

      // 2. Desired state: add default value to status column
      const desiredSQL = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          status VARCHAR(50) DEFAULT 'pending'
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state - column should have default value
      const finalColumns = await getTableColumns(client, "products");
      expect(finalColumns).toHaveLength(2);

      assertColumn(finalColumns, "status", { default: "pending" });
    });

    test("should remove default value from column", async () => {
      // 1. Initial state: create table with column that has a default
      await client.query(`
        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          quantity INTEGER DEFAULT 1
        );
      `);

      const initialColumns = await getTableColumns(client, "items");
      expect(initialColumns).toHaveLength(2);

      // Verify initial default value
      assertColumn(initialColumns, "quantity", { default: "1" });

      // 2. Desired state: remove default value from quantity column
      const desiredSQL = `
        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          quantity INTEGER
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state - column should have no default value
      const finalColumns = await getTableColumns(client, "items");
      expect(finalColumns).toHaveLength(2);

      assertColumn(finalColumns, "quantity", { default: null });
    });
  });
});
