import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { SchemaParser } from "../core/schema/parser";
import { cleanDatabase, createTestClient, createTestSchemaService } from "./utils";

describe("PostgreSQL query-derived table statements", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  test("rejects CREATE TABLE AS and SELECT INTO forms", async function () {
    const parser = new SchemaParser();
    const cases = [
      {
        sql: 'CREATE TABLE public."Derived Ü" AS SELECT 1 AS id;',
        statement: "CREATE TABLE AS",
      },
      {
        sql: "CREATE UNLOGGED TABLE public.empty_copy AS SELECT 1 AS id WITH NO DATA;",
        statement: "CREATE TABLE AS",
      },
      {
        sql: "SELECT 1 AS id INTO public.selected_rows;",
        statement: "SELECT INTO",
      },
    ];

    for (const scenario of cases) {
      await expect(
        parser.parseSchema(scenario.sql, "derived-table.sql")
      ).rejects.toMatchObject({
        code: "PARSER_ERROR",
        filePath: "derived-table.sql",
        message: expect.stringContaining(
          `PostgreSQL ${scenario.statement} is not supported in desired schemas`
        ),
      });
    }
  });

  test("continues to manage materialized views", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE MATERIALIZED VIEW public.derived_summary
      AS SELECT 1 AS id;
    `);

    expect(parsed.views).toEqual([
      expect.objectContaining({
        name: "derived_summary",
        materialized: true,
      }),
    ]);
  });

  test("rejects a mixed schema before creating surrounding tables", async function () {
    const schema = `
      CREATE TABLE public.durable_before (id integer PRIMARY KEY);
      CREATE TABLE public.derived_rows AS SELECT 1 AS id;
      CREATE TABLE public.durable_after (id integer PRIMARY KEY);
    `;

    await expect(
      createTestSchemaService().apply(schema, ["public"], true)
    ).rejects.toMatchObject({ code: "PARSER_ERROR" });

    expect(
      (
        await client.query(`
          SELECT to_regclass('public.durable_before') AS before,
                 to_regclass('public.derived_rows') AS derived,
                 to_regclass('public.durable_after') AS after
        `)
      ).rows[0]
    ).toEqual({ before: null, derived: null, after: null });
  });
});
