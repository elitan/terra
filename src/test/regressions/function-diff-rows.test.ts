import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: function diff includes rows option", function () {
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

  test("detects change when ROWS value changes", async function () {
    const baseSchema = `
      CREATE OR REPLACE FUNCTION fn_rows_opt(a integer)
      RETURNS SETOF integer
      LANGUAGE sql
      ROWS 10
      AS $$
      SELECT a
      $$;
    `;

    const updatedSchema = `
      CREATE OR REPLACE FUNCTION fn_rows_opt(a integer)
      RETURNS SETOF integer
      LANGUAGE sql
      ROWS 30
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
