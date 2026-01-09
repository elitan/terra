import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Client } from "pg";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Issue #70 - CHECK constraint idempotency with IN/NOT IN", () => {
  let client: Client;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async () => {
    await client.end();
  });

  test("should be idempotent for NOT IN expressions (PostgreSQL normalizes to <> ALL)", async () => {
    const schemaService = createTestSchemaService();

    await client.query(`
      CREATE TABLE cases (
        id SERIAL PRIMARY KEY,
        state TEXT,
        closed_at TIMESTAMP,
        CONSTRAINT ready_to_close_or_closed_requires_closed_at
          CHECK (closed_at IS NOT NULL OR state NOT IN ('ready-to-close', 'closed'))
      );
    `);

    const plan = await schemaService.plan(`
      CREATE TABLE cases (
        id SERIAL PRIMARY KEY,
        state TEXT,
        closed_at TIMESTAMP,
        CONSTRAINT ready_to_close_or_closed_requires_closed_at
          CHECK (closed_at IS NOT NULL OR state NOT IN ('ready-to-close', 'closed'))
      );
    `);

    expect(plan.hasChanges).toBe(false);
  });

  test("should be idempotent for simple NOT IN expression", async () => {
    const schemaService = createTestSchemaService();

    await client.query(`
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        status TEXT,
        CONSTRAINT valid_status CHECK (status NOT IN ('cancelled', 'rejected'))
      );
    `);

    const plan = await schemaService.plan(`
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        status TEXT,
        CONSTRAINT valid_status CHECK (status NOT IN ('cancelled', 'rejected'))
      );
    `);

    expect(plan.hasChanges).toBe(false);
  });

  test("should be idempotent for IN expressions (PostgreSQL normalizes to = ANY)", async () => {
    const schemaService = createTestSchemaService();

    await client.query(`
      CREATE TABLE items (
        id SERIAL PRIMARY KEY,
        status TEXT,
        CONSTRAINT valid_status CHECK (status IN ('active', 'inactive', 'pending'))
      );
    `);

    const plan = await schemaService.plan(`
      CREATE TABLE items (
        id SERIAL PRIMARY KEY,
        status TEXT,
        CONSTRAINT valid_status CHECK (status IN ('active', 'inactive', 'pending'))
      );
    `);

    expect(plan.hasChanges).toBe(false);
  });

  test("should be idempotent for NOT IN with numeric values", async () => {
    const schemaService = createTestSchemaService();

    await client.query(`
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        category_id INT,
        CONSTRAINT excluded_categories CHECK (category_id NOT IN (1, 2, 3))
      );
    `);

    const plan = await schemaService.plan(`
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        category_id INT,
        CONSTRAINT excluded_categories CHECK (category_id NOT IN (1, 2, 3))
      );
    `);

    expect(plan.hasChanges).toBe(false);
  });
});
