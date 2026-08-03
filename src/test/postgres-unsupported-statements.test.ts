import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { SchemaParser } from "../core/schema/parser";
import { cleanDatabase, createTestClient, createTestSchemaService } from "./utils";

describe("PostgreSQL unsupported desired-schema statements", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  test("rejects untracked top-level commands with actionable names", async function () {
    const parser = new SchemaParser();
    const cases = [
      ["INSERT INTO public.users(id) VALUES (1);", "INSERT"],
      ["UPDATE public.users SET id = 2;", "UPDATE"],
      ["DELETE FROM public.users;", "DELETE"],
      ["SELECT 1;", "SELECT"],
      ["COPY (SELECT 1) TO STDOUT;", "COPY"],
      ["TRUNCATE public.users;", "TRUNCATE"],
      ["VACUUM public.users;", "VACUUM"],
      ["ANALYZE public.users;", "ANALYZE"],
      ["DO $$ BEGIN NULL; END $$;", "DO"],
      ["SET search_path TO public;", "SET"],
      ["BEGIN;", "TRANSACTION"],
      ["CREATE CAST (text AS integer) WITH INOUT;", "CREATE CAST"],
      ["ALTER SEQUENCE public.ids RESTART WITH 10;", "ALTER SEQUENCE"],
      ["REFRESH MATERIALIZED VIEW public.summary;", "REFRESH MATERIALIZED VIEW"],
    ] as const;

    for (const [sql, statement] of cases) {
      await expect(
        parser.parseSchema(sql, "unsupported.sql")
      ).rejects.toMatchObject({
        code: "PARSER_ERROR",
        filePath: "unsupported.sql",
        message: expect.stringContaining(
          `PostgreSQL ${statement} is not supported in desired schemas`
        ),
      });
    }
  });

  test("keeps SQL inside managed function bodies", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE FUNCTION public.write_audit_row()
      RETURNS void
      LANGUAGE SQL
      AS $$
        INSERT INTO public.audit_log(message) VALUES ('called');
      $$;
    `);

    expect(parsed.functions).toEqual([
      expect.objectContaining({
        name: "write_audit_row",
        body: expect.stringContaining("INSERT INTO public.audit_log"),
      }),
    ]);
  });

  test("rejects a mixed schema before applying surrounding DDL", async function () {
    const schema = `
      CREATE TABLE public.durable_before (id integer PRIMARY KEY);
      INSERT INTO public.durable_before VALUES (1);
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
