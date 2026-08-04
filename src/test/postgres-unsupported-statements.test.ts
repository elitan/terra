import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { DatabaseInspector } from "../core/schema/inspector";
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

  test("rejects PostgreSQL 18 constraint semantics that are not modeled", async function () {
    const parser = new SchemaParser();
    const cases = [
      {
        sql: `
          CREATE TABLE public.check_state (
            value integer,
            CONSTRAINT check_state_positive CHECK (value > 0) NOT ENFORCED
          );
        `,
        feature: "NOT ENFORCED",
      },
      {
        sql: `
          CREATE TABLE public.parents (id integer PRIMARY KEY);
          CREATE TABLE public.children (
            parent_id integer REFERENCES public.parents(id) NOT ENFORCED
          );
        `,
        feature: "NOT ENFORCED",
      },
      {
        sql: `
          CREATE TABLE public.altered_check (value integer);
          ALTER TABLE public.altered_check
            ADD CONSTRAINT altered_check_positive
            CHECK (value > 0) NOT ENFORCED;
        `,
        feature: "NOT ENFORCED",
      },
      {
        sql: `
          CREATE TABLE public.temporal_unique (
            bucket daterange,
            valid_at daterange,
            UNIQUE (bucket, valid_at WITHOUT OVERLAPS)
          );
        `,
        feature: "WITHOUT OVERLAPS or PERIOD",
      },
      {
        sql: `
          CREATE TABLE public.temporal_parent (
            id integer,
            valid_at daterange,
            PRIMARY KEY (id, valid_at)
          );
          CREATE TABLE public.temporal_child (
            id integer,
            valid_at daterange,
            FOREIGN KEY (id, PERIOD valid_at)
              REFERENCES public.temporal_parent
          );
        `,
        feature: "WITHOUT OVERLAPS or PERIOD",
      },
      {
        sql: `
          CREATE TABLE public.named_not_null (
            value integer CONSTRAINT named_not_null_value_nn NOT NULL
          );
        `,
        feature: "advanced NOT NULL",
      },
      {
        sql: `
          CREATE TABLE public.unnamed_table_not_null (
            value integer,
            NOT NULL value
          );
        `,
        feature: "advanced NOT NULL",
      },
      {
        sql: `
          CREATE TABLE public.table_not_null (
            value integer,
            CONSTRAINT table_not_null_value_nn NOT NULL value
          );
        `,
        feature: "advanced NOT NULL",
      },
      {
        sql: `
          CREATE TABLE public.non_inheritable_not_null (
            value integer NOT NULL NO INHERIT
          );
        `,
        feature: "advanced NOT NULL",
      },
    ] as const;

    for (const scenario of cases) {
      await expect(
        parser.parseSchema(scenario.sql, "unsupported-constraint.sql")
      ).rejects.toMatchObject({
        code: "PARSER_ERROR",
        filePath: "unsupported-constraint.sql",
        message: expect.stringContaining(scenario.feature),
      });
    }
  });

  test("keeps enforced NOT VALID constraints in the supported model", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE TABLE public.validation_parent (id integer PRIMARY KEY);
      CREATE TABLE public.validation_child (
        id integer PRIMARY KEY,
        parent_id integer,
        value integer
      );
      ALTER TABLE public.validation_child
        ADD CONSTRAINT validation_child_value_check
        CHECK (value > 0) NOT VALID;
      ALTER TABLE public.validation_child
        ADD CONSTRAINT validation_child_parent_fkey
        FOREIGN KEY (parent_id) REFERENCES public.validation_parent(id)
        NOT VALID;
    `);
    const child = parsed.tables.find(function findChild(table) {
      return table.name === "validation_child";
    });

    expect(child?.checkConstraints?.[0]?.notValid).toBe(true);
    expect(child?.foreignKeys?.[0]?.notValid).toBe(true);
  });

  test("rejects unsupported PostgreSQL 18 constraint catalog state", async function () {
    const versionResult = await client.query(
      "SELECT current_setting('server_version_num')::integer AS version"
    );
    if (Number(versionResult.rows[0]?.version) < 180000) {
      return;
    }

    const schemaService = createTestSchemaService();
    await client.query(`
      CREATE TABLE public.external_unenforced (
        value integer,
        CONSTRAINT external_unenforced_positive
          CHECK (value > 0) NOT ENFORCED
      );
    `);
    await expect(
      schemaService.plan("", ["public"])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("NOT ENFORCED"),
    });

    await client.query(`
      DROP TABLE public.external_unenforced;
      CREATE TABLE public.external_temporal (
        bucket daterange,
        valid_at daterange,
        CONSTRAINT external_temporal_unique
          UNIQUE (bucket, valid_at WITHOUT OVERLAPS)
      );
    `);
    await expect(
      schemaService.plan("", ["public"])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("WITHOUT OVERLAPS or PERIOD"),
    });

    await client.query(`
      DROP TABLE public.external_temporal;
      CREATE TABLE public.external_not_null (
        value integer NOT NULL NO INHERIT
      );
    `);
    await expect(
      schemaService.plan("", ["public"])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("NOT NULL NO INHERIT or NOT VALID"),
    });

    await client.query(`
      DROP TABLE public.external_not_null;
      CREATE TABLE public.external_not_valid (value integer);
      ALTER TABLE public.external_not_valid
        ADD CONSTRAINT external_value_pending
        NOT NULL value NOT VALID;
    `);
    await expect(
      schemaService.plan("", ["public"])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("NOT NULL NO INHERIT or NOT VALID"),
    });

    await client.query(`
      DROP TABLE public.external_not_valid;
      CREATE TABLE public.external_named_not_null (
        value integer CONSTRAINT external_value_required NOT NULL
      );
    `);
    const inspected = await new DatabaseInspector().getCurrentSchema(
      client,
      ["public"]
    );
    const namedNotNull = inspected.find(function findNamedNotNull(table) {
      return table.name === "external_named_not_null";
    });
    expect(namedNotNull?.columns).toEqual([
      expect.objectContaining({ name: "value", nullable: false }),
    ]);

    await client.query(`
      DROP TABLE public.external_named_not_null;
      CREATE TABLE public.external_partitioned (
        value integer,
        CONSTRAINT external_partitioned_positive
          CHECK (value > 0) NOT ENFORCED
      ) PARTITION BY RANGE (value);
    `);
    await expect(
      schemaService.plan("", ["public"])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("NOT ENFORCED"),
    });

    await client.query(`
      DROP TABLE public.external_partitioned;
      CREATE TABLE public.external_partition_parent (value integer)
        PARTITION BY RANGE (value);
      CREATE TABLE public.external_partition_child
        PARTITION OF public.external_partition_parent
        FOR VALUES FROM (0) TO (100);
      ALTER TABLE public.external_partition_child
        ADD CONSTRAINT external_partition_child_positive
        CHECK (value > 0) NOT ENFORCED;
    `);
    await expect(
      schemaService.plan("", ["public"])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("NOT ENFORCED"),
    });
  });

  test("rejects unsupported constraints before applying surrounding DDL", async function () {
    const schema = `
      CREATE TABLE public.constraint_before (id integer PRIMARY KEY);
      CREATE TABLE public.constraint_gap (
        value integer,
        CHECK (value > 0) NOT ENFORCED
      );
      CREATE TABLE public.constraint_after (id integer PRIMARY KEY);
    `;

    await expect(
      createTestSchemaService().apply(schema, ["public"], true)
    ).rejects.toMatchObject({
      code: "PARSER_ERROR",
      message: expect.stringContaining("NOT ENFORCED"),
    });

    const result = await client.query(`
      SELECT
        to_regclass('public.constraint_before') AS before,
        to_regclass('public.constraint_gap') AS gap,
        to_regclass('public.constraint_after') AS after
    `);
    expect(result.rows[0]).toEqual({ before: null, gap: null, after: null });
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
