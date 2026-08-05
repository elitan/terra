import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { SchemaParser } from "../core/schema/parser";
import { getStatementRisk } from "../utils/statement-classifier";
import { createTestClient, createTestSchemaService } from "./utils";

async function inspectManagedComments(client: Client) {
  const result = await client.query(`
    SELECT
      d.description,
      d.classoid::regclass::text AS catalog
    FROM pg_description d
    WHERE d.description LIKE '% comment'
      AND (
        d.objoid IN (
          SELECT c.oid
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'comment_scope'
        )
        OR d.objoid IN (
          SELECT t.oid
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'comment_scope'
        )
        OR d.objoid = 'comment_scope'::regnamespace
      )
    ORDER BY d.description
  `);
  return result.rows;
}

describe("PostgreSQL COMMENT parser fidelity", function () {
  test("normalizes every losslessly supported target", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      COMMENT ON SCHEMA analytics IS 'schema';
      COMMENT ON TABLE public.events IS 'table';
      COMMENT ON COLUMN public.events.payload IS 'table column';
      COMMENT ON COLUMN public.events.created_at IS 'second table column';
      COMMENT ON VIEW public.event_view IS 'view';
      COMMENT ON MATERIALIZED VIEW public.event_rollup IS 'materialized view';
      COMMENT ON INDEX public.events_payload_idx IS 'index';
      COMMENT ON SEQUENCE public.events_id_seq IS 'sequence';
      COMMENT ON TYPE public.event_status IS 'type';
      COMMENT ON DOMAIN public.event_code IS 'domain';
    `);

    expect(parsed.comments).toEqual([
      {
        objectType: "SCHEMA",
        objectName: "analytics",
        schemaName: undefined,
        comment: "schema",
      },
      {
        objectType: "TABLE",
        objectName: "events",
        schemaName: "public",
        comment: "table",
      },
      {
        objectType: "COLUMN",
        objectName: "events",
        schemaName: "public",
        columnName: "payload",
        comment: "table column",
      },
      {
        objectType: "COLUMN",
        objectName: "events",
        schemaName: "public",
        columnName: "created_at",
        comment: "second table column",
      },
      {
        objectType: "VIEW",
        objectName: "event_view",
        schemaName: "public",
        comment: "view",
      },
      {
        objectType: "MATERIALIZED VIEW",
        objectName: "event_rollup",
        schemaName: "public",
        comment: "materialized view",
      },
      {
        objectType: "INDEX",
        objectName: "events_payload_idx",
        schemaName: "public",
        comment: "index",
      },
      {
        objectType: "SEQUENCE",
        objectName: "events_id_seq",
        schemaName: "public",
        comment: "sequence",
      },
      {
        objectType: "TYPE",
        objectName: "event_status",
        schemaName: "public",
        comment: "type",
      },
      {
        objectType: "TYPE",
        objectName: "event_code",
        schemaName: "public",
        comment: "domain",
      },
    ]);
  });

  test("rejects every documented target outside the lossless subset", async function () {
    const statements = [
      "COMMENT ON ACCESS METHOD heap IS 'comment';",
      "COMMENT ON AGGREGATE public.total(integer) IS 'comment';",
      "COMMENT ON CAST (text AS integer) IS 'comment';",
      "COMMENT ON COLLATION public.custom_collation IS 'comment';",
      "COMMENT ON CONSTRAINT positive_value ON public.events IS 'comment';",
      "COMMENT ON CONSTRAINT valid_code ON DOMAIN public.code IS 'comment';",
      "COMMENT ON CONVERSION public.custom_conversion IS 'comment';",
      "COMMENT ON DATABASE postgres IS 'comment';",
      "COMMENT ON EXTENSION hstore IS 'comment';",
      "COMMENT ON EVENT TRIGGER audit_ddl IS 'comment';",
      "COMMENT ON FOREIGN DATA WRAPPER remote_wrapper IS 'comment';",
      "COMMENT ON FOREIGN TABLE public.remote_events IS 'comment';",
      "COMMENT ON FUNCTION public.calculate(integer) IS 'comment';",
      "COMMENT ON LARGE OBJECT 1234 IS 'comment';",
      "COMMENT ON OPERATOR public.=== (integer, integer) IS 'comment';",
      "COMMENT ON OPERATOR CLASS public.custom_ops USING btree IS 'comment';",
      "COMMENT ON OPERATOR FAMILY public.custom_family USING btree IS 'comment';",
      "COMMENT ON POLICY tenant_policy ON public.events IS 'comment';",
      "COMMENT ON PROCEDURAL LANGUAGE plpgsql IS 'comment';",
      "COMMENT ON PROCEDURE public.refresh(integer) IS 'comment';",
      "COMMENT ON PUBLICATION all_events IS 'comment';",
      "COMMENT ON ROLE app_user IS 'comment';",
      "COMMENT ON ROUTINE public.calculate(integer) IS 'comment';",
      "COMMENT ON RULE audit_rule ON public.events IS 'comment';",
      "COMMENT ON SERVER remote_server IS 'comment';",
      "COMMENT ON STATISTICS public.events_stats IS 'comment';",
      "COMMENT ON SUBSCRIPTION all_events IS 'comment';",
      "COMMENT ON TABLESPACE fast_space IS 'comment';",
      "COMMENT ON TEXT SEARCH CONFIGURATION public.custom_config IS 'comment';",
      "COMMENT ON TEXT SEARCH DICTIONARY public.custom_dictionary IS 'comment';",
      "COMMENT ON TEXT SEARCH PARSER public.custom_parser IS 'comment';",
      "COMMENT ON TEXT SEARCH TEMPLATE public.custom_template IS 'comment';",
      "COMMENT ON TRANSFORM FOR text LANGUAGE plpgsql IS 'comment';",
      "COMMENT ON TRIGGER audit_event ON public.events IS 'comment';",
    ];

    for (const statement of statements) {
      await expect(
        new SchemaParser().parseSchema(statement, "comments.sql")
      ).rejects.toMatchObject({
        code: "PARSER_ERROR",
        filePath: "comments.sql",
        message: expect.stringContaining("is not supported in desired schemas"),
      });
    }
  });

  test("rejects imperative removals and duplicate final declarations", async function () {
    const parser = new SchemaParser();
    for (const removal of [
      "COMMENT ON TABLE public.events IS NULL;",
      "COMMENT ON TABLE public.events IS '';",
    ]) {
      await expect(parser.parseSchema(removal, "comments.sql")).rejects.toMatchObject({
        code: "PARSER_ERROR",
        filePath: "comments.sql",
        message: expect.stringContaining("remove the COMMENT statement"),
      });
    }

    await expect(parser.parseSchema(`
      COMMENT ON DOMAIN public.event_code IS 'first';
      COMMENT ON TYPE public.event_code IS 'second';
    `, "comments.sql")).rejects.toMatchObject({
      code: "PARSER_ERROR",
      filePath: "comments.sql",
      message: expect.stringContaining("declared more than once"),
    });
  });
});

describe("PostgreSQL COMMENT catalog round trip", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await client.query("DROP SCHEMA IF EXISTS comment_scope CASCADE");
  });

  afterEach(async function () {
    await client.query("DROP SCHEMA IF EXISTS comment_scope CASCADE");
    await client.end();
  });

  test("applies and replans relation column sequence and type comments idempotently", async function () {
    const definitions = `
      CREATE SCHEMA comment_scope;
      CREATE TYPE comment_scope.event_status AS ENUM ('new', 'done');
      CREATE TYPE comment_scope.event_payload AS (label text);
      CREATE DOMAIN comment_scope.event_code AS text CHECK (VALUE <> '');
      CREATE TYPE comment_scope.event_score AS RANGE (subtype = integer);
      CREATE SEQUENCE comment_scope.event_ids;
      CREATE TABLE comment_scope.events (
        id integer NOT NULL,
        code comment_scope.event_code NOT NULL,
        status comment_scope.event_status NOT NULL,
        payload comment_scope.event_payload
      );
      CREATE TABLE comment_scope.partitioned_events (
        bucket integer NOT NULL
      ) PARTITION BY RANGE (bucket);
      CREATE INDEX events_code_idx ON comment_scope.events (code);
      CREATE VIEW comment_scope.event_view AS
        SELECT id, code FROM comment_scope.events;
      CREATE MATERIALIZED VIEW comment_scope.event_rollup AS
        SELECT status, count(*) AS total
        FROM comment_scope.events
        GROUP BY status;
    `;
    const comments = `
      COMMENT ON SCHEMA comment_scope IS 'schema comment';
      COMMENT ON TYPE comment_scope.event_status IS 'enum comment';
      COMMENT ON TYPE comment_scope.event_payload IS 'composite comment';
      COMMENT ON DOMAIN comment_scope.event_code IS 'domain comment';
      COMMENT ON TYPE comment_scope.event_score IS 'range comment';
      COMMENT ON TYPE comment_scope.event_score_multirange IS 'multirange comment';
      COMMENT ON SEQUENCE comment_scope.event_ids IS 'sequence comment';
      COMMENT ON TABLE comment_scope.events IS 'table comment';
      COMMENT ON COLUMN comment_scope.events.code IS 'table column comment';
      COMMENT ON TABLE comment_scope.partitioned_events IS 'partitioned table comment';
      COMMENT ON COLUMN comment_scope.partitioned_events.bucket IS 'partitioned column comment';
      COMMENT ON COLUMN comment_scope.event_payload.label IS 'composite column comment';
      COMMENT ON INDEX comment_scope.events_code_idx IS 'index comment';
      COMMENT ON VIEW comment_scope.event_view IS 'view comment';
      COMMENT ON COLUMN comment_scope.event_view.code IS 'view column comment';
      COMMENT ON MATERIALIZED VIEW comment_scope.event_rollup IS 'materialized view comment';
      COMMENT ON COLUMN comment_scope.event_rollup.total IS 'materialized view column comment';
    `;
    const schema = `${definitions}\n${comments}`;
    const service = createTestSchemaService();

    await service.apply(schema, ["comment_scope"], true);
    const replan = await service.apply(
      schema,
      ["comment_scope"],
      true,
      undefined,
      true
    );

    expect(replan.hasChanges).toBe(false);

    const commentsBeforeRemoval = await inspectManagedComments(client);
    expect(commentsBeforeRemoval).toHaveLength(17);
    expect(new Set(commentsBeforeRemoval.map(function getCatalog(row) {
      return row.catalog;
    }))).toEqual(new Set(["pg_class", "pg_namespace", "pg_type"]));

    const removalPlan = await service.apply(
      definitions,
      ["comment_scope"],
      true,
      undefined,
      true
    );
    const removalSql = removalPlan.transactional.join("\n");
    expect(removalSql).toContain("COMMENT ON SCHEMA");
    expect(removalSql).toContain("COMMENT ON MATERIALIZED VIEW");
    expect(removalSql).toContain("COMMENT ON SEQUENCE");
    expect(removalSql).toContain("COMMENT ON TYPE");
    expect(removalSql).toContain("COMMENT ON COLUMN");
    expect(removalSql).toContain("IS NULL");
    for (const statement of removalPlan.transactional) {
      expect(getStatementRisk(statement, "transactional")).toBe(
        "destructive"
      );
    }

    await expect(
      service.apply(
        definitions,
        ["comment_scope"],
        true,
        undefined,
        false,
        true
      )
    ).rejects.toMatchObject({ code: "STRICT_MODE_ERROR" });
    expect(await inspectManagedComments(client)).toEqual(commentsBeforeRemoval);

    await service.apply(definitions, ["comment_scope"], true);
    const removalReplan = await service.apply(
      definitions,
      ["comment_scope"],
      true,
      undefined,
      true
    );
    expect(removalReplan.hasChanges).toBe(false);
  });

  test("rejects unsupported comments before creating preceding objects", async function () {
    const service = createTestSchemaService();
    const cases = [
      `
        CREATE SCHEMA comment_scope;
        CREATE TABLE comment_scope.guard (id integer);
        COMMENT ON FUNCTION public.abs(integer) IS 'unsupported';
      `,
      `
        CREATE SCHEMA comment_scope;
        CREATE TABLE comment_scope.guard (id integer);
        COMMENT ON TABLE comment_scope.guard IS NULL;
      `,
    ];

    for (const schema of cases) {
      await expect(
        service.apply(schema, ["comment_scope"], true)
      ).rejects.toMatchObject({ code: "PARSER_ERROR" });
      const result = await client.query(
        "SELECT to_regclass('comment_scope.guard') AS guard"
      );
      expect(result.rows[0]?.guard).toBeNull();
    }
  });

  test("rolls back earlier comment changes when a later target is missing", async function () {
    await client.query(`
      CREATE SCHEMA comment_scope;
      CREATE TABLE comment_scope.rollback_guard (id integer);
      COMMENT ON TABLE comment_scope.rollback_guard IS 'original comment';
    `);
    const service = createTestSchemaService();
    const schema = `
      CREATE SCHEMA comment_scope;
      CREATE TABLE comment_scope.rollback_guard (id integer);
      COMMENT ON TABLE comment_scope.rollback_guard IS 'changed comment';
      COMMENT ON TYPE comment_scope.missing_type IS 'missing target';
    `;

    await expect(
      service.apply(schema, ["comment_scope"], true)
    ).rejects.toThrow();

    const result = await client.query(`
      SELECT obj_description('comment_scope.rollback_guard'::regclass, 'pg_class') AS comment
    `);
    expect(result.rows[0]?.comment).toBe("original comment");
  });
});
