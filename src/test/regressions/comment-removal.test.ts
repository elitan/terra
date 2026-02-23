import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: removed comments are dropped", function () {
  let client: Client;
  let service: SchemaService;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    service = createTestSchemaService();
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client?.end();
  });

  test("drops table comment when comment statement is removed", async function () {
    const schemaWithComment = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY
      );
      COMMENT ON TABLE users IS 'table comment';
    `;

    const schemaWithoutComment = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY
      );
    `;

    await service.apply(schemaWithComment, ["public"], true);

    const plan = await service.apply(schemaWithoutComment, ["public"], true, undefined, true);

    expect(plan.hasChanges).toBe(true);
    expect(plan.transactional.join("\n")).toContain("COMMENT ON TABLE");
    expect(plan.transactional.join("\n")).toContain("IS NULL");

    await service.apply(schemaWithoutComment, ["public"], true);

    const result = await client.query(`
      SELECT d.description
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
      WHERE n.nspname = 'public' AND c.relname = 'users'
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].description).toBeNull();
  });
});
