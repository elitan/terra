import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: procedure drop handles OUT parameters", function () {
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

  test("drops procedure with OUT parameter when removed from schema", async function () {
    const initialSchema = `
      CREATE OR REPLACE PROCEDURE proc_out_drop(IN a integer, OUT b integer)
      LANGUAGE plpgsql
      AS $$
      BEGIN
        b := a;
      END;
      $$;
    `;

    await service.apply(initialSchema, ["public"], true);

    const result = await service.apply("", ["public"], true);

    expect(result.hasChanges).toBe(true);

    const remaining = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'proc_out_drop'
    `);

    expect(remaining.rows[0].count).toBe(0);
  });
});
