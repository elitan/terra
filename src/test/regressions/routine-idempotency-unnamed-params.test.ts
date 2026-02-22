import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: routine idempotency with unnamed parameters", function () {
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

  test("does not recreate function with unnamed timestamp with time zone parameter", async function () {
    const schema = `
      CREATE OR REPLACE FUNCTION fn_unnamed_timestamptz(timestamp with time zone)
      RETURNS integer
      LANGUAGE sql
      AS $$
      SELECT 1
      $$;
    `;

    await service.apply(schema, ["public"], true);

    const plan = await service.apply(schema, ["public"], true, undefined, true);

    expect(plan.hasChanges).toBe(false);
    expect(plan.transactional).toHaveLength(0);
    expect(plan.concurrent).toHaveLength(0);
  });

  test("does not recreate procedure with unnamed character varying parameter", async function () {
    const schema = `
      CREATE OR REPLACE PROCEDURE proc_unnamed_varchar(character varying)
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NULL;
      END;
      $$;
    `;

    await service.apply(schema, ["public"], true);

    const plan = await service.apply(schema, ["public"], true, undefined, true);

    expect(plan.hasChanges).toBe(false);
    expect(plan.transactional).toHaveLength(0);
    expect(plan.concurrent).toHaveLength(0);
  });
});
