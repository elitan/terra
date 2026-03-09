import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: function idempotency with time aliases", () => {
  let client: Client;
  let service: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    service = createTestSchemaService();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client?.end();
  });

  test("does not recreate function for timestamp with time zone alias", async () => {
    const schema = `
      CREATE OR REPLACE FUNCTION fn_timestamptz(p_ts timestamp with time zone)
      RETURNS integer
      LANGUAGE plpgsql AS $$
      BEGIN
        RETURN 1;
      END;
      $$;
    `;

    await service.apply(schema, ["public"], true);

    const plan = await service.apply(schema, ["public"], true, undefined, true);

    expect(plan.hasChanges).toBe(false);
    expect(plan.transactional).toHaveLength(0);
    expect(plan.concurrent).toHaveLength(0);
  });

  test("does not recreate function for timestamp alias", async () => {
    const schema = `
      CREATE OR REPLACE FUNCTION fn_timestamp(p_ts timestamp)
      RETURNS integer
      LANGUAGE plpgsql AS $$
      BEGIN
        RETURN 1;
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
