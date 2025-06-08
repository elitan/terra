import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestClient,
  cleanDatabase,
  getTableNames,
  TEST_DB_CONFIG,
} from "./utils";
import { SchemaParser } from "../core/schema/parser";
import { SchemaDiffer } from "../core/schema/differ";
import { DatabaseInspector } from "../core/schema/inspector";
import { MigrationExecutor } from "../core/migration/executor";
import { DatabaseService } from "../core/database/client";
import type { MigrationPlan } from "../types/migration";
import { Client } from "pg";
import { createColumnTestServices } from "./columns/column-test-utils";

describe("Table Operations - End to End", () => {
  let client: Client;
  const { parser, inspector, differ, executor } = createColumnTestServices();

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  test("should migrate from empty database to simple table", async () => {
    // 1. Initial state: empty database
    const initialTableNames = await getTableNames(client);
    expect(initialTableNames).toHaveLength(0);

    // 2. Desired state: SQL with a simple table
    const desiredSQL = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255)
      );
    `;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

    await executor.executePlan(client, plan);

    // Verify final state
    const finalTableNames = await getTableNames(client);
    expect(finalTableNames).toContain("users");
  });

  test("should add new tables to existing schema", async () => {
    // 1. Initial state: create one table
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      );
    `);

    const initialTableNames = await getTableNames(client);
    expect(initialTableNames).toContain("users");

    // 2. Desired state: SQL with additional tables
    const desiredSQL = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      );

      CREATE TABLE categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL
      );

      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10,2) NOT NULL
      );
    `;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

    await executor.executePlan(client, plan);

    // Verify final state
    const finalTableNames = await getTableNames(client);
    expect(finalTableNames).toContain("users");
    expect(finalTableNames).toContain("categories");
    expect(finalTableNames).toContain("products");
  });

  test("should remove tables from existing schema", async () => {
    // 1. Initial state: create multiple tables
    await client.query(`
      CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255));
      CREATE TABLE temp_table (id SERIAL PRIMARY KEY, data TEXT);
      CREATE TABLE logs (id SERIAL PRIMARY KEY, message TEXT);
    `);

    const initialTableNames = await getTableNames(client);
    expect(initialTableNames).toContain("users");
    expect(initialTableNames).toContain("temp_table");
    expect(initialTableNames).toContain("logs");

    // 2. Desired state: SQL with only one table
    const desiredSQL = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255)
      );
    `;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

    await executor.executePlan(client, plan);

    // Verify final state
    const finalTableNames = await getTableNames(client);
    expect(finalTableNames).toContain("users");
    expect(finalTableNames).not.toContain("temp_table");
    expect(finalTableNames).not.toContain("logs");
  });

  test("should handle mixed operations - add, keep, and remove tables", async () => {
    // 1. Initial state: create some tables
    await client.query(`
      CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255));
      CREATE TABLE old_table (id SERIAL PRIMARY KEY, data TEXT);
    `);

    const initialTableNames = await getTableNames(client);
    expect(initialTableNames).toContain("users");
    expect(initialTableNames).toContain("old_table");

    // 2. Desired state: keep users, remove old_table, add new_table
    const desiredSQL = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255)
      );

      CREATE TABLE new_table (
        id SERIAL PRIMARY KEY,
        description TEXT NOT NULL,
        created_at TIMESTAMP
      );
    `;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

    await executor.executePlan(client, plan);

    // Verify final state
    const finalTableNames = await getTableNames(client);
    expect(finalTableNames).toContain("users");
    expect(finalTableNames).toContain("new_table");
    expect(finalTableNames).not.toContain("old_table");
  });

  test("should handle empty desired schema - remove all tables", async () => {
    // 1. Initial state: create some tables
    await client.query(`
      CREATE TABLE table_a (id SERIAL PRIMARY KEY);
      CREATE TABLE table_b (id SERIAL PRIMARY KEY);
    `);

    const initialTableNames = await getTableNames(client);
    expect(initialTableNames).toContain("table_a");
    expect(initialTableNames).toContain("table_b");

    // 2. Desired state: empty (no tables)
    const desiredSQL = ``;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    expect(desiredTables).toHaveLength(0);

    const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

    await executor.executePlan(client, plan);

    // Verify final state - no tables
    const finalTableNames = await getTableNames(client);
    expect(finalTableNames).not.toContain("table_a");
    expect(finalTableNames).not.toContain("table_b");
  });
});
