import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SchemaService } from "../../../core/schema/service";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  getTableColumns,
  createTestSchemaService,
} from "../../utils";

describe("TEXT to VARCHAR conversion with default values", () => {
  let client: Client;
  let service: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);

    
    service = createTestSchemaService();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  test("should convert TEXT DEFAULT 'value' to VARCHAR(255) DEFAULT 'value' without extra operations", async () => {
    // Initial schema: TEXT with default
    const initialSchema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT DEFAULT 'hejsan'
      );
    `;

    await service.apply(initialSchema, ['public'], true);

    // Verify initial state
    const initialColumns = await getTableColumns(client, "users");
    const nameCol = initialColumns.find(c => c.name === "name");
    expect(nameCol?.type).toBe("text");
    expect(nameCol?.default).toMatch(/hejsan/);

    // Change to VARCHAR(255) but keep same default
    const modifiedSchema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) DEFAULT 'hejsan'
      );
    `;

    const plan = await service.plan(modifiedSchema);

    // Should only have type change, NOT default drop/set operations
    expect(plan.hasChanges).toBe(true);

    // Should have exactly 1 statement: ALTER COLUMN TYPE
    expect(plan.transactional.length).toBe(1);
    expect(plan.transactional[0]).toContain('ALTER COLUMN "name" TYPE VARCHAR(255)');

    // Should NOT have DROP DEFAULT or SET DEFAULT statements
    expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
    expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);

    // Apply the migration
    await service.apply(modifiedSchema, ['public'], true);

    // Verify final state
    const finalColumns = await getTableColumns(client, "users");
    const finalNameCol = finalColumns.find(c => c.name === "name");
    expect(finalNameCol?.type).toBe("character varying");
    expect(finalNameCol?.default).toMatch(/hejsan/);

    // Verify idempotency: applying again should show no changes
    const plan2 = await service.plan(modifiedSchema);
    expect(plan2.hasChanges).toBe(false);
    expect(plan2.transactional.length).toBe(0);
  });

  test("should convert VARCHAR(100) DEFAULT 'value' to VARCHAR(255) DEFAULT 'value' without default operations", async () => {
    // Initial schema: VARCHAR(100) with default
    const initialSchema = `
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        status VARCHAR(100) DEFAULT 'pending'
      );
    `;

    await service.apply(initialSchema, ['public'], true);

    // Change length but keep same default
    const modifiedSchema = `
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        status VARCHAR(255) DEFAULT 'pending'
      );
    `;

    const plan = await service.plan(modifiedSchema);

    // Should only have type change
    expect(plan.hasChanges).toBe(true);
    expect(plan.transactional.length).toBe(1);
    expect(plan.transactional[0]).toContain('ALTER COLUMN "status" TYPE VARCHAR(255)');

    // Should NOT have DROP DEFAULT or SET DEFAULT
    expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
    expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);
  });

  test("should handle TEXT to VARCHAR with default change correctly", async () => {
    // Initial schema: TEXT with default
    const initialSchema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT DEFAULT 'old_value'
      );
    `;

    await service.apply(initialSchema, ['public'], true);

    // Change both type AND default
    const modifiedSchema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) DEFAULT 'new_value'
      );
    `;

    const plan = await service.plan(modifiedSchema);

    // Should have type change AND default change
    expect(plan.hasChanges).toBe(true);
    expect(plan.transactional.some(s => s.includes('ALTER COLUMN "name" TYPE VARCHAR(255)'))).toBe(true);
    expect(plan.transactional.some(s => s.includes("SET DEFAULT 'new_value'"))).toBe(true);

    // Should drop old default before type change
    expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(true);
  });

  test("should handle TEXT with default to VARCHAR without default", async () => {
    // Initial schema: TEXT with default
    const initialSchema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT DEFAULT 'hejsan'
      );
    `;

    await service.apply(initialSchema, ['public'], true);

    // Remove default while changing type
    const modifiedSchema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255)
      );
    `;

    const plan = await service.plan(modifiedSchema);

    // Should have both type change and DROP DEFAULT
    expect(plan.hasChanges).toBe(true);
    expect(plan.transactional.some(s => s.includes('ALTER COLUMN "name" TYPE VARCHAR(255)'))).toBe(true);
    expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(true);
    expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);
  });

  test("should handle VARCHAR without default to VARCHAR with default", async () => {
    // Initial schema: VARCHAR without default
    const initialSchema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100)
      );
    `;

    await service.apply(initialSchema, ['public'], true);

    // Add default while changing length
    const modifiedSchema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) DEFAULT 'hejsan'
      );
    `;

    const plan = await service.plan(modifiedSchema);

    // Should have both type change and SET DEFAULT
    expect(plan.hasChanges).toBe(true);
    expect(plan.transactional.some(s => s.includes('ALTER COLUMN "name" TYPE VARCHAR(255)'))).toBe(true);
    expect(plan.transactional.some(s => s.includes("SET DEFAULT 'hejsan'"))).toBe(true);
    expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
  });

  test("should preserve data during TEXT to VARCHAR conversion with default", async () => {
    // Create table with data
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT DEFAULT 'hejsan'
      );
    `);

    // Insert test data
    await client.query("INSERT INTO users (name) VALUES ('Johan')");
    await client.query("INSERT INTO users (name) VALUES (DEFAULT)");
    await client.query("INSERT INTO users (name) VALUES ('Alice')");

    // Change to VARCHAR with same default
    const modifiedSchema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) DEFAULT 'hejsan'
      );
    `;

    await service.apply(modifiedSchema, ['public'], true);

    // Verify data preservation
    const result = await client.query("SELECT * FROM users ORDER BY id");
    expect(result.rows.length).toBe(3);
    expect(result.rows[0].name).toBe("Johan");
    expect(result.rows[1].name).toBe("hejsan");
    expect(result.rows[2].name).toBe("Alice");

    // Verify default still works for new inserts
    await client.query("INSERT INTO users (id) VALUES (DEFAULT)");
    const newRow = await client.query("SELECT name FROM users WHERE id = 4");
    expect(newRow.rows[0].name).toBe("hejsan");
  });
});
