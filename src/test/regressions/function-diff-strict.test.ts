import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: function diff includes strict option", function () {
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

  test("detects change when STRICT is added", async function () {
    const baseSchema = `
      CREATE OR REPLACE FUNCTION fn_strict_opt(a integer)
      RETURNS integer
      LANGUAGE sql
      AS $$
      SELECT a
      $$;
    `;

    const updatedSchema = `
      CREATE OR REPLACE FUNCTION fn_strict_opt(a integer)
      RETURNS integer
      LANGUAGE sql
      STRICT
      AS $$
      SELECT a
      $$;
    `;

    await service.apply(baseSchema, ["public"], true);

    const plan = await service.apply(updatedSchema, ["public"], true, undefined, true);

    expect(plan.hasChanges).toBe(true);
    expect(plan.transactional.length + plan.concurrent.length).toBeGreaterThan(0);
  });
});
