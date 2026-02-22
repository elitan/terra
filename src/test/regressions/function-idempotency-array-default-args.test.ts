import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: function idempotency with array defaults", () => {
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

  test("does not recreate unchanged function with comma inside default array", async () => {
    const schema = `
      CREATE OR REPLACE FUNCTION fn_price(price numeric(10,2), tags text[] DEFAULT ARRAY['a','b'])
      RETURNS numeric(10,2)
      LANGUAGE plpgsql AS $$
      BEGIN
        RETURN price;
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
