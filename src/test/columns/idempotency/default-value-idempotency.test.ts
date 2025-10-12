import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SchemaService } from "../../../core/schema/service";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  getTableColumns,
  createTestDatabaseService,
} from "../../utils";

describe("Default Value Idempotency - Issue #11", () => {
  let client: Client;
  let service: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);

    const databaseService = createTestDatabaseService();
    service = new SchemaService(databaseService);
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  test("should not detect changes after applying schema with defaults", async () => {
    // Initial schema with defaults
    const schema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) DEFAULT 'John',
        age INTEGER DEFAULT 25,
        active BOOLEAN DEFAULT true
      );
    `;

    // Apply schema first time
    await service.apply(schema, ['public'], true);

    // Verify columns were created with defaults
    const columns = await getTableColumns(client, "users");
    expect(columns.length).toBe(4);

    const nameCol = columns.find(c => c.name === "name");
    const ageCol = columns.find(c => c.name === "age");
    const activeCol = columns.find(c => c.name === "active");

    expect(nameCol?.default).toMatch(/John/);
    expect(ageCol?.default).toMatch(/25/);
    expect(activeCol?.default).toBe("true");

    // Apply same schema again - should detect NO CHANGES
    const plan = await service.plan(schema);

    expect(plan.hasChanges).toBe(false);
    expect(plan.transactional.length).toBe(0);
    expect(plan.concurrent.length).toBe(0);
  });

  test("should not detect changes after modifying column defaults (issue #11 scenario)", async () => {
    // Step 1: Create initial table
    const initialSchema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        age VARCHAR(10) DEFAULT '20'
      );
    `;

    await service.apply(initialSchema, ['public'], true);

    // Step 2: Apply changes (set default for name, change age type, drop age default)
    const modifiedSchema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) DEFAULT 'John',
        age INTEGER
      );
    `;

    const plan1 = await service.plan(modifiedSchema);
    expect(plan1.hasChanges).toBe(true);

    await service.apply(modifiedSchema, ['public'], true);

    // Verify the changes were applied
    const columns = await getTableColumns(client, "users");
    const nameCol = columns.find(c => c.name === "name");
    const ageCol = columns.find(c => c.name === "age");

    expect(nameCol?.default).toMatch(/John/);
    expect(ageCol?.default).toBeNull();
    expect(ageCol?.type).toBe("integer");

    // Step 3: Apply same schema again - should detect NO CHANGES (this was the bug)
    const plan2 = await service.plan(modifiedSchema);

    expect(plan2.hasChanges).toBe(false);
    expect(plan2.transactional.length).toBe(0);
    expect(plan2.concurrent.length).toBe(0);
  });

  test("should handle various default value types without false positives", async () => {
    const schema = `
      CREATE TABLE test_defaults (
        id SERIAL PRIMARY KEY,
        str_col VARCHAR(100) DEFAULT 'test',
        int_col INTEGER DEFAULT 42,
        bool_col BOOLEAN DEFAULT false,
        date_col DATE DEFAULT CURRENT_DATE,
        timestamp_col TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // Apply schema first time
    await service.apply(schema, ['public'], true);

    // Verify all columns have defaults
    const columns = await getTableColumns(client, "test_defaults");
    expect(columns.length).toBe(6);

    for (const col of columns) {
      if (col.name !== "id") {
        expect(col.default).not.toBeNull();
      }
    }

    // Apply same schema again - should detect NO CHANGES
    const plan = await service.plan(schema);

    expect(plan.hasChanges).toBe(false);
    expect(plan.transactional.length).toBe(0);
    expect(plan.concurrent.length).toBe(0);
  });

  test("should correctly detect actual default value changes", async () => {
    // Initial schema
    const schema1 = `
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        status VARCHAR(20) DEFAULT 'pending',
        quantity INTEGER DEFAULT 0
      );
    `;

    await service.apply(schema1, ['public'], true);

    // Change defaults
    const schema2 = `
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        status VARCHAR(20) DEFAULT 'active',
        quantity INTEGER DEFAULT 1
      );
    `;

    const plan = await service.plan(schema2);

    // Should detect that defaults have changed
    expect(plan.hasChanges).toBe(true);
    expect(plan.transactional.some(s => s.includes("SET DEFAULT 'active'"))).toBe(true);
    expect(plan.transactional.some(s => s.includes("SET DEFAULT 1"))).toBe(true);
  });

  test("should correctly detect adding/removing defaults", async () => {
    // Initial schema without defaults
    const schema1 = `
      CREATE TABLE items (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        count INTEGER
      );
    `;

    await service.apply(schema1, ['public'], true);

    // Add defaults
    const schema2 = `
      CREATE TABLE items (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) DEFAULT 'unnamed',
        count INTEGER DEFAULT 0
      );
    `;

    const plan1 = await service.plan(schema2);
    expect(plan1.hasChanges).toBe(true);
    expect(plan1.transactional.some(s => s.includes("SET DEFAULT"))).toBe(true);

    await service.apply(schema2, ['public'], true);

    // Remove defaults
    const schema3 = `
      CREATE TABLE items (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        count INTEGER
      );
    `;

    const plan2 = await service.plan(schema3);
    expect(plan2.hasChanges).toBe(true);
    expect(plan2.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(true);
  });
});
