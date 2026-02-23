import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: function returns table is supported", function () {
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

  test("applies function with RETURNS TABLE signature", async function () {
    const schema = `
      CREATE OR REPLACE FUNCTION fn_table_ret(a integer)
      RETURNS TABLE (value integer)
      LANGUAGE sql
      AS $$
      SELECT a
      $$;
    `;

    await service.apply(schema, ["public"], true);

    const result = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_table_ret'
    `);

    expect(result.rows[0].count).toBe(1);
  });
});
