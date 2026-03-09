import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: function setof return type is preserved", function () {
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

  test("creates function with SETOF return type", async function () {
    const schema = `
      CREATE OR REPLACE FUNCTION fn_setof_ret(a integer)
      RETURNS SETOF integer
      LANGUAGE sql
      AS $$
      SELECT a
      $$;
    `;

    await service.apply(schema, ["public"], true);

    const result = await client.query(`
      SELECT pg_get_function_result(p.oid) AS result_type
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'fn_setof_ret'
        AND pg_get_function_identity_arguments(p.oid) = 'a integer'
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].result_type).toBe("SETOF integer");
  });
});
