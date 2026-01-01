import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  getTableColumns,
} from "../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  findColumn,
} from "./column-test-utils";

describe("Generated Columns", () => {
  let client: Client;
  const services = createColumnTestServices();

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  test("should parse GENERATED ALWAYS AS STORED columns", async () => {
    const schema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        first_name TEXT,
        last_name TEXT,
        full_name TEXT GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED
      );
    `;

    const tables = await services.parser.parseCreateTableStatements(schema);
    expect(tables).toHaveLength(1);

    const table = tables[0];
    expect(table.name).toBe("users");
    expect(table.columns).toHaveLength(4);

    const fullNameColumn = findColumn(table.columns, "full_name");
    expect(fullNameColumn).toBeDefined();
    expect(fullNameColumn?.generated).toBeDefined();
    expect(fullNameColumn?.generated?.always).toBe(true);
    expect(fullNameColumn?.generated?.stored).toBe(true);
    expect(fullNameColumn?.generated?.expression).toContain("first_name");
    expect(fullNameColumn?.generated?.expression).toContain("last_name");
  });

  test("should apply schema with generated columns", async () => {
    const schema = `
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        price DECIMAL(10, 2),
        quantity INTEGER,
        total DECIMAL(10, 2) GENERATED ALWAYS AS (price * quantity) STORED
      );
    `;

    await executeColumnMigration(client, schema, services);

    const tables = await services.inspector.getCurrentSchema(client);
    const table = tables.find((t) => t.name === "products");
    expect(table).toBeDefined();

    const totalColumn = findColumn(table!.columns, "total");
    expect(totalColumn).toBeDefined();
    expect(totalColumn?.generated).toBeDefined();
    expect(totalColumn?.generated?.always).toBe(true);
    expect(totalColumn?.generated?.stored).toBe(true);
  });

  test("should handle complex GENERATED column expressions", async () => {
    const schema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        first_name TEXT,
        last_name TEXT,
        email TEXT,
        search_vector TEXT GENERATED ALWAYS AS (
          LOWER(first_name) || ' ' || LOWER(last_name) || ' ' || LOWER(email)
        ) STORED
      );
    `;

    await executeColumnMigration(client, schema, services);

    const tables = await services.inspector.getCurrentSchema(client);
    const table = tables.find((t) => t.name === "users");
    const searchColumn = findColumn(table!.columns, "search_vector");

    expect(searchColumn?.generated).toBeDefined();
    expect(searchColumn?.generated?.expression).toContain("lower");
  });

  test("should detect changes to generated column expressions", async () => {
    const initialSchema = `
      CREATE TABLE items (
        id SERIAL PRIMARY KEY,
        price DECIMAL(10, 2),
        tax DECIMAL(10, 2) GENERATED ALWAYS AS (price * 0.1) STORED
      );
    `;

    await executeColumnMigration(client, initialSchema, services);

    const updatedSchema = `
      CREATE TABLE items (
        id SERIAL PRIMARY KEY,
        price DECIMAL(10, 2),
        tax DECIMAL(10, 2) GENERATED ALWAYS AS (price * 0.15) STORED
      );
    `;

    const currentSchema = await services.inspector.getCurrentSchema(client);
    const desiredTables = await services.parser.parseCreateTableStatements(updatedSchema);
    const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

    expect(plan.hasChanges).toBe(true);
    expect(plan.transactional.some((s) => s.includes('DROP COLUMN "tax"'))).toBe(
      true
    );
    expect(plan.transactional.some((s) => s.includes('ADD COLUMN "tax"'))).toBe(
      true
    );
  });

  test("should handle adding generated columns to existing tables", async () => {
    const initialSchema = `
      CREATE TABLE employees (
        id SERIAL PRIMARY KEY,
        first_name TEXT,
        last_name TEXT
      );
    `;

    await executeColumnMigration(client, initialSchema, services);

    const updatedSchema = `
      CREATE TABLE employees (
        id SERIAL PRIMARY KEY,
        first_name TEXT,
        last_name TEXT,
        full_name TEXT GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED
      );
    `;

    const currentSchema = await services.inspector.getCurrentSchema(client);
    const desiredTables = await services.parser.parseCreateTableStatements(updatedSchema);
    const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

    expect(plan.hasChanges).toBe(true);
    expect(
      plan.transactional.some((s) => s.includes('ADD COLUMN "full_name"'))
    ).toBe(true);
    expect(plan.transactional.some((s) => s.includes("GENERATED"))).toBe(true);

    await services.executor.executePlan(client, plan, true);

    const finalSchema = await services.inspector.getCurrentSchema(client);
    const table = finalSchema.find((t) => t.name === "employees");
    const fullNameColumn = findColumn(table!.columns, "full_name");
    expect(fullNameColumn?.generated).toBeDefined();
  });

  test("should handle removing generated columns", async () => {
    const initialSchema = `
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        price DECIMAL(10, 2),
        tax DECIMAL(10, 2) GENERATED ALWAYS AS (price * 0.1) STORED
      );
    `;

    await executeColumnMigration(client, initialSchema, services);

    const updatedSchema = `
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        price DECIMAL(10, 2)
      );
    `;

    await executeColumnMigration(client, updatedSchema, services);

    const tables = await services.inspector.getCurrentSchema(client);
    const table = tables.find((t) => t.name === "orders");
    expect(findColumn(table!.columns, "tax")).toBeUndefined();
  });

  test("should handle CASE expressions in generated columns", async () => {
    const schema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        first_name TEXT,
        last_name TEXT,
        display_name TEXT GENERATED ALWAYS AS (
          CASE
            WHEN first_name IS NOT NULL THEN first_name || ' ' || last_name
            ELSE last_name
          END
        ) STORED
      );
    `;

    await executeColumnMigration(client, schema, services);

    const tables = await services.inspector.getCurrentSchema(client);
    const table = tables.find((t) => t.name === "users");
    const displayColumn = findColumn(table!.columns, "display_name");

    expect(displayColumn?.generated).toBeDefined();
    expect(displayColumn?.generated?.expression.toUpperCase()).toContain("CASE");
    expect(displayColumn?.generated?.expression.toUpperCase()).toContain("WHEN");
  });

  test("should be idempotent - no changes after applying generated column", async () => {
    const schema = `
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        price DECIMAL(10, 2),
        quantity INTEGER,
        total DECIMAL(10, 2) GENERATED ALWAYS AS (price * quantity) STORED
      );
    `;

    await executeColumnMigration(client, schema, services);

    const currentSchema = await services.inspector.getCurrentSchema(client);
    const desiredTables = await services.parser.parseCreateTableStatements(schema);
    const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

    expect(plan.hasChanges).toBe(false);
  });

  test("should be idempotent with complex generated expressions", async () => {
    const schema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        first_name TEXT,
        last_name TEXT,
        search_vector TEXT GENERATED ALWAYS AS (
          LOWER(first_name) || ' ' || LOWER(last_name)
        ) STORED
      );
    `;

    await executeColumnMigration(client, schema, services);

    const currentSchema = await services.inspector.getCurrentSchema(client);
    const desiredTables = await services.parser.parseCreateTableStatements(schema);
    const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

    expect(plan.hasChanges).toBe(false);
  });

  test("should be idempotent with tsvector and setweight expressions", async () => {
    const schema = `
      CREATE TABLE articles (
        id SERIAL PRIMARY KEY,
        title TEXT,
        body TEXT,
        search_vector TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(body, '')), 'B')
        ) STORED
      );
    `;

    await executeColumnMigration(client, schema, services);

    const currentSchema = await services.inspector.getCurrentSchema(client);
    const desiredTables = await services.parser.parseCreateTableStatements(schema);
    const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

    expect(plan.hasChanges).toBe(false);
  });
});
