import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { SchemaParser } from "../core/schema/parser";
import { cleanDatabase, createTestClient, createTestSchemaService } from "./utils";

describe("PostgreSQL temporary desired-schema objects", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  test("rejects every accepted temporary relation spelling", async function () {
    const parser = new SchemaParser();
    const cases = [
      {
        sql: 'CREATE TEMP TABLE "Scratch Table" (id integer);',
        kind: "table",
        name: "Scratch Table",
      },
      {
        sql: "CREATE LOCAL TEMPORARY TABLE scratch_rows (id integer) ON COMMIT DROP;",
        kind: "table",
        name: "scratch_rows",
      },
      {
        sql: "CREATE TEMP VIEW scratch_view AS SELECT 1 AS id;",
        kind: "view",
        name: "scratch_view",
      },
      {
        sql: "CREATE TEMP TABLE scratch_copy AS SELECT 1 AS id;",
        kind: "table",
        name: "scratch_copy",
      },
      {
        sql: "CREATE TEMPORARY SEQUENCE scratch_sequence START WITH 4;",
        kind: "sequence",
        name: "scratch_sequence",
      },
    ];

    for (const scenario of cases) {
      try {
        await parser.parseSchema(scenario.sql, "temporary-schema.sql");
        throw new Error("Expected temporary object parsing to fail");
      } catch (error) {
        expect(error).toMatchObject({
          code: "PARSER_ERROR",
          filePath: "temporary-schema.sql",
        });
        expect(String(error)).toContain(
          `Temporary PostgreSQL ${scenario.kind} "${scenario.name}" is session-local`
        );
      }
    }
  });

  test("rejects a mixed schema before creating any persistent object", async function () {
    const schema = `
      CREATE TABLE public.durable_before (id integer PRIMARY KEY);
      CREATE TEMP TABLE transient_rows (id integer);
      CREATE TABLE public.durable_after (id integer PRIMARY KEY);
    `;

    await expect(
      createTestSchemaService().apply(schema, ["public"], true)
    ).rejects.toMatchObject({ code: "PARSER_ERROR" });

    expect(
      (
        await client.query(`
          SELECT to_regclass('public.durable_before') AS before,
                 to_regclass('public.durable_after') AS after
        `)
      ).rows[0]
    ).toEqual({ before: null, after: null });
  });
});
