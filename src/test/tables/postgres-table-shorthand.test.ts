import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { SchemaParser } from "../../core/schema/parser";
import { cleanDatabase, createTestClient, createTestSchemaService } from "../utils";

describe("PostgreSQL table shape shorthand", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  test("rejects LIKE and typed tables instead of producing empty tables", async function () {
    const parser = new SchemaParser();
    const cases = [
      {
        sql: `
          CREATE TABLE public.source_rows (
            id integer PRIMARY KEY,
            label text DEFAULT 'source'
          );
          CREATE TABLE public.copied_rows (
            extra text,
            LIKE public.source_rows INCLUDING ALL
          );
        `,
        statement: "CREATE TABLE LIKE",
      },
      {
        sql: `
          CREATE TYPE public."Payload Ü" AS (
            id integer,
            label text
          );
          CREATE TABLE public.typed_rows OF public."Payload Ü";
        `,
        statement: "CREATE TABLE OF",
      },
    ];

    for (const scenario of cases) {
      await expect(
        parser.parseSchema(scenario.sql, "table-shorthand.sql")
      ).rejects.toMatchObject({
        code: "PARSER_ERROR",
        filePath: "table-shorthand.sql",
        message: expect.stringContaining(
          `PostgreSQL ${scenario.statement} is not supported in desired schemas`
        ),
      });
    }
  });

  test("continues to parse managed table inheritance", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE TABLE public.inheritance_parent (id integer);
      CREATE TABLE public.inheritance_child (label text)
        INHERITS (public.inheritance_parent);
    `);

    expect(parsed.tables[1]).toMatchObject({
      name: "inheritance_child",
      columns: [expect.objectContaining({ name: "label" })],
      inherits: [{ name: "inheritance_parent", schema: "public" }],
    });
  });

  test("rejects shorthand before creating any source or target object", async function () {
    const schema = `
      CREATE TABLE public.source_rows (id integer PRIMARY KEY);
      CREATE TABLE public.copied_rows (
        LIKE public.source_rows INCLUDING ALL
      );
    `;

    await expect(
      createTestSchemaService().apply(schema, ["public"], true)
    ).rejects.toMatchObject({ code: "PARSER_ERROR" });

    expect(
      (
        await client.query(`
          SELECT to_regclass('public.source_rows') AS source,
                 to_regclass('public.copied_rows') AS copied
        `)
      ).rows[0]
    ).toEqual({ source: null, copied: null });
  });
});
