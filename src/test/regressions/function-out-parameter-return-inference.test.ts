import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: function parser infers return type from OUT parameters", function () {
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

  test("applies function without explicit RETURNS when OUT parameter is present", async function () {
    const schema = `
      CREATE OR REPLACE FUNCTION fn_out_infer(IN a integer, OUT b integer)
      LANGUAGE plpgsql
      AS $$
      BEGIN
        b := a;
      END;
      $$;
    `;

    await service.apply(schema, ["public"], true);

    const created = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_out_infer'
    `);

    expect(created.rows[0].count).toBe(1);
  });
});
