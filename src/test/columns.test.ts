import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestClient,
  cleanDatabase,
  getTableNames,
  getTableColumns,
  TEST_DB_CONFIG,
} from "./utils";
import { SchemaParser } from "../core/schema/parser";
import { SchemaDiffer } from "../core/schema/differ";
import { DatabaseInspector } from "../core/schema/inspector";
import { MigrationExecutor } from "../core/migration/executor";
import { DatabaseService } from "../core/database/client";
import type { MigrationPlan } from "../types/migration";
import { Client } from "pg";

describe("Column Operations - End to End", () => {
  let client: Client;
  let parser: SchemaParser;
  let differ: SchemaDiffer;
  let inspector: DatabaseInspector;
  let executor: MigrationExecutor;
  let databaseService: DatabaseService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);

    parser = new SchemaParser();
    differ = new SchemaDiffer();
    inspector = new DatabaseInspector();
    databaseService = new DatabaseService(TEST_DB_CONFIG);
    executor = new MigrationExecutor(databaseService);
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

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
    expect(initialColumns.some((col) => col.name === "id")).toBe(true);
    expect(initialColumns.some((col) => col.name === "name")).toBe(true);

    // 2. Desired state: SQL with additional columns (simple types, no complex defaults)
    const desiredSQL = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        age INTEGER
      );
    `;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const migrationStatements = differ.generateMigrationPlan(
      desiredTables,
      initialSchema
    );

    const plan: MigrationPlan = {
      statements: migrationStatements,
      hasChanges: migrationStatements.length > 0,
    };
    await executor.executePlan(client, plan);

    // 4. Verify final state
    const finalColumns = await getTableColumns(client, "users");
    expect(finalColumns).toHaveLength(4);

    const columnNames = finalColumns.map((col) => col.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("name");
    expect(columnNames).toContain("email");
    expect(columnNames).toContain("age");
  });

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

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const migrationStatements = differ.generateMigrationPlan(
      desiredTables,
      initialSchema
    );

    const plan: MigrationPlan = {
      statements: migrationStatements,
      hasChanges: migrationStatements.length > 0,
    };
    await executor.executePlan(client, plan);

    // 4. Verify final state
    const finalColumns = await getTableColumns(client, "products");
    expect(finalColumns).toHaveLength(3);

    const columnNames = finalColumns.map((col) => col.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("name");
    expect(columnNames).toContain("description");
    expect(columnNames).not.toContain("old_field");
    expect(columnNames).not.toContain("deprecated_column");
  });

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

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const migrationStatements = differ.generateMigrationPlan(
      desiredTables,
      initialSchema
    );

    const plan: MigrationPlan = {
      statements: migrationStatements,
      hasChanges: migrationStatements.length > 0,
    };
    await executor.executePlan(client, plan);

    // 4. Verify final state
    const finalColumns = await getTableColumns(client, "orders");
    expect(finalColumns).toHaveLength(4);

    const columnNames = finalColumns.map((col) => col.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("customer_name");
    expect(columnNames).toContain("status");
    expect(columnNames).toContain("total_amount");
    expect(columnNames).not.toContain("old_status");
    expect(columnNames).not.toContain("temp_field");
  });

  test("should handle columns with different data types", async () => {
    // 1. Initial state: simple table
    await client.query(`
      CREATE TABLE test_types (
        id SERIAL PRIMARY KEY
      );
    `);

    // 2. Desired state: add columns with various data types (no complex defaults)
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

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const migrationStatements = differ.generateMigrationPlan(
      desiredTables,
      initialSchema
    );

    const plan: MigrationPlan = {
      statements: migrationStatements,
      hasChanges: migrationStatements.length > 0,
    };
    await executor.executePlan(client, plan);

    // 4. Verify final state
    const finalColumns = await getTableColumns(client, "test_types");
    expect(finalColumns).toHaveLength(6);

    const columnNames = finalColumns.map((col) => col.name);
    expect(columnNames).toContain("text_field");
    expect(columnNames).toContain("varchar_field");
    expect(columnNames).toContain("integer_field");
    expect(columnNames).toContain("decimal_field");
    expect(columnNames).toContain("boolean_field");
  });

  test("should handle columns with simple default values", async () => {
    // 1. Initial state: simple table
    await client.query(`
      CREATE TABLE settings (
        id SERIAL PRIMARY KEY
      );
    `);

    // 2. Desired state: add columns with simple defaults (no complex expressions)
    const desiredSQL = `
      CREATE TABLE settings (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        value TEXT DEFAULT 'default_value',
        priority INTEGER DEFAULT 0
      );
    `;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const migrationStatements = differ.generateMigrationPlan(
      desiredTables,
      initialSchema
    );

    const plan: MigrationPlan = {
      statements: migrationStatements,
      hasChanges: migrationStatements.length > 0,
    };
    await executor.executePlan(client, plan);

    // 4. Verify final state
    const finalColumns = await getTableColumns(client, "settings");
    expect(finalColumns).toHaveLength(4);

    const columnNames = finalColumns.map((col) => col.name);
    expect(columnNames).toContain("name");
    expect(columnNames).toContain("value");
    expect(columnNames).toContain("priority");

    // Verify NOT NULL constraint
    const nameColumn = finalColumns.find((col) => col.name === "name");
    expect(nameColumn?.nullable).toBe(false);
  });

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
    const initialContentColumn = initialColumns.find(
      (col) => col.name === "content"
    );
    expect(initialContentColumn?.type).toContain("character varying");

    // 2. Desired state: change column data type from VARCHAR to TEXT
    const desiredSQL = `
      CREATE TABLE documents (
        id SERIAL PRIMARY KEY,
        title VARCHAR(100) NOT NULL,
        content TEXT
      );
    `;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const migrationStatements = differ.generateMigrationPlan(
      desiredTables,
      initialSchema
    );

    const plan: MigrationPlan = {
      statements: migrationStatements,
      hasChanges: migrationStatements.length > 0,
    };
    await executor.executePlan(client, plan);

    // 4. Verify final state - column type should be changed
    const finalColumns = await getTableColumns(client, "documents");
    expect(finalColumns).toHaveLength(3);

    const columnNames = finalColumns.map((col) => col.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("title");
    expect(columnNames).toContain("content");

    // Verify the data type changed
    const finalContentColumn = finalColumns.find(
      (col) => col.name === "content"
    );
    expect(finalContentColumn?.type).toBe("text");
  });

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
    const initialEmailColumn = initialColumns.find(
      (col) => col.name === "email"
    );
    expect(initialEmailColumn?.nullable).toBe(true);

    // 2. Desired state: make email column NOT NULL
    const desiredSQL = `
      CREATE TABLE profiles (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL
      );
    `;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const migrationStatements = differ.generateMigrationPlan(
      desiredTables,
      initialSchema
    );

    const plan: MigrationPlan = {
      statements: migrationStatements,
      hasChanges: migrationStatements.length > 0,
    };
    await executor.executePlan(client, plan);

    // 4. Verify final state - column should be NOT NULL
    const finalColumns = await getTableColumns(client, "profiles");
    expect(finalColumns).toHaveLength(2);

    const finalEmailColumn = finalColumns.find((col) => col.name === "email");
    expect(finalEmailColumn?.nullable).toBe(false);
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
    const initialPhoneColumn = initialColumns.find(
      (col) => col.name === "phone"
    );
    expect(initialPhoneColumn?.nullable).toBe(false);

    // 2. Desired state: make phone column nullable
    const desiredSQL = `
      CREATE TABLE contacts (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20)
      );
    `;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const migrationStatements = differ.generateMigrationPlan(
      desiredTables,
      initialSchema
    );

    const plan: MigrationPlan = {
      statements: migrationStatements,
      hasChanges: migrationStatements.length > 0,
    };
    await executor.executePlan(client, plan);

    // 4. Verify final state - column should be nullable
    const finalColumns = await getTableColumns(client, "contacts");
    expect(finalColumns).toHaveLength(2);

    const finalPhoneColumn = finalColumns.find((col) => col.name === "phone");
    expect(finalPhoneColumn?.nullable).toBe(true);
  });

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
    const initialStatusColumn = initialColumns.find(
      (col) => col.name === "status"
    );
    expect(initialStatusColumn?.default).toBeNull();

    // 2. Desired state: add default value to status column
    const desiredSQL = `
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        status VARCHAR(50) DEFAULT 'pending'
      );
    `;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const migrationStatements = differ.generateMigrationPlan(
      desiredTables,
      initialSchema
    );

    const plan: MigrationPlan = {
      statements: migrationStatements,
      hasChanges: migrationStatements.length > 0,
    };
    await executor.executePlan(client, plan);

    // 4. Verify final state - column should have default value
    const finalColumns = await getTableColumns(client, "products");
    expect(finalColumns).toHaveLength(2);

    const finalStatusColumn = finalColumns.find((col) => col.name === "status");
    expect(finalStatusColumn?.default).toContain("pending");
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
    const initialQuantityColumn = initialColumns.find(
      (col) => col.name === "quantity"
    );
    expect(initialQuantityColumn?.default).toContain("1");

    // 2. Desired state: remove default value from quantity column
    const desiredSQL = `
      CREATE TABLE items (
        id SERIAL PRIMARY KEY,
        quantity INTEGER
      );
    `;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const migrationStatements = differ.generateMigrationPlan(
      desiredTables,
      initialSchema
    );

    const plan: MigrationPlan = {
      statements: migrationStatements,
      hasChanges: migrationStatements.length > 0,
    };
    await executor.executePlan(client, plan);

    // 4. Verify final state - column should have no default value
    const finalColumns = await getTableColumns(client, "items");
    expect(finalColumns).toHaveLength(2);

    const finalQuantityColumn = finalColumns.find(
      (col) => col.name === "quantity"
    );
    expect(finalQuantityColumn?.default).toBeNull();
  });

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
    const initialBalanceColumn = initialColumns.find(
      (col) => col.name === "balance"
    );
    expect(initialBalanceColumn?.type).toContain("character varying");
    expect(initialBalanceColumn?.nullable).toBe(true);
    expect(initialBalanceColumn?.default).toContain("0.00");

    // 2. Desired state: change type to DECIMAL, make NOT NULL, and change default
    const desiredSQL = `
      CREATE TABLE accounts (
        id SERIAL PRIMARY KEY,
        balance DECIMAL(10,2) NOT NULL DEFAULT 100.00
      );
    `;

    // 3. Parse desired state and apply diff
    const initialSchema = await inspector.getCurrentSchema(client);
    const desiredTables = parser.parseCreateTableStatements(desiredSQL);
    const migrationStatements = differ.generateMigrationPlan(
      desiredTables,
      initialSchema
    );

    const plan: MigrationPlan = {
      statements: migrationStatements,
      hasChanges: migrationStatements.length > 0,
    };
    await executor.executePlan(client, plan);

    // 4. Verify final state - all changes should be applied
    const finalColumns = await getTableColumns(client, "accounts");
    expect(finalColumns).toHaveLength(2);

    const finalBalanceColumn = finalColumns.find(
      (col) => col.name === "balance"
    );
    expect(finalBalanceColumn?.type).toBe("numeric");
    expect(finalBalanceColumn?.nullable).toBe(false);
    expect(finalBalanceColumn?.default).toContain("100");
  });
});
