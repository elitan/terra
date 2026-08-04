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

  test("converges an externally created multi-column RETURNS TABLE function", async function () {
    const schema = `
      CREATE OR REPLACE FUNCTION fn_table_ret(a integer)
      RETURNS TABLE (value integer, label text)
      LANGUAGE sql
      AS $$
      SELECT a, a::text
      $$;
    `;

    await client.query(schema);
    const oidBefore = await client.query(`
      SELECT p.oid::integer AS oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_table_ret'
    `);

    const externalPlan = await service.plan(schema, ["public"]);
    expect(externalPlan.hasChanges).toBe(false);
    expect(externalPlan.transactional).toEqual([]);
    await service.apply(schema, ["public"], true);

    const result = await client.query(`
      SELECT p.oid::integer AS oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_table_ret'
    `);

    expect(result.rows).toEqual(oidBefore.rows);
    expect(
      await client.query("SELECT * FROM public.fn_table_ret(7)")
    ).toMatchObject({ rows: [{ value: 7, label: "7" }] });
  });
});
