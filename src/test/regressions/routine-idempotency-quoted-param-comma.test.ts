import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: routine idempotency with quoted parameter names containing commas", function () {
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

  test("does not recreate function with quoted parameter name containing comma", async function () {
    const schema = `
      CREATE OR REPLACE FUNCTION fn_param_comma("a,b" integer)
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

  test("does not recreate procedure with quoted parameter name containing comma", async function () {
    const schema = `
      CREATE OR REPLACE PROCEDURE proc_param_comma(IN "x,y" integer)
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
