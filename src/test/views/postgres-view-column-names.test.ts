import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { SchemaParser } from "../../core/schema/parser";
import { DatabaseInspector } from "../../core/schema/inspector";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

describe("PostgreSQL view column names", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  test("parses explicit ordinary and materialized view column lists", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE VIEW public.item_view (item_id, "Display Label") AS
        SELECT 1 AS source_id, 'one'::text AS source_label;
      CREATE MATERIALIZED VIEW public.item_summary (item_id, "Display Label") AS
        SELECT 1 AS source_id, 'one'::text AS source_label
        WITH NO DATA;
    `);

    expect(parsed.views.map(function viewColumns(view) {
      return [view.name, view.columnNames];
    })).toEqual([
      ["item_view", ["item_id", "Display Label"]],
      ["item_summary", ["item_id", "Display Label"]],
    ]);
  });

  test("creates, inspects, and reapplies effective output column names", async function () {
    const tableSchema = `
      CREATE TABLE public.source_items (
        id integer NOT NULL,
        label text NOT NULL
      );
    `;
    const schema = `${tableSchema}
      CREATE VIEW public.item_view ("Item Id", "Item Label") AS
        SELECT id, label FROM public.source_items;
      CREATE MATERIALIZED VIEW public.item_summary ("Item Id", "Item Label") AS
        SELECT id, label FROM public.source_items;
      CREATE INDEX item_summary_id_idx
        ON public.item_summary ("Item Id");
    `;
    const service = createTestSchemaService();
    await service.apply(tableSchema, ["public"], true);
    await client.query("INSERT INTO public.source_items VALUES (1, 'one')");
    const createPlan = await service.apply(schema, ["public"], true);
    expect(createPlan.transactional.some(function createsOrdinaryView(statement) {
      return statement.includes(
        'CREATE VIEW "public"."item_view" ("Item Id", "Item Label")'
      );
    })).toBe(true);
    expect(createPlan.transactional.some(function createsMaterializedView(statement) {
      return statement.includes(
        'CREATE MATERIALIZED VIEW "public"."item_summary" ("Item Id", "Item Label")'
      );
    })).toBe(true);

    const views = await new DatabaseInspector().getCurrentViews(client, ["public"]);
    expect(views.map(function viewColumns(view) {
      return [view.name, view.columnNames];
    })).toEqual([
      ["item_view", ["Item Id", "Item Label"]],
      ["item_summary", ["Item Id", "Item Label"]],
    ]);
    expect(
      (await client.query('SELECT * FROM public.item_view')).rows[0]
    ).toEqual({ "Item Id": 1, "Item Label": "one" });
    expect(
      (await client.query('SELECT * FROM public.item_summary')).rows[0]
    ).toEqual({ "Item Id": 1, "Item Label": "one" });
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);
  });

  test("renames columns without dropping dependents or materialized data", async function () {
    const tableSchema = `
      CREATE TABLE public.source_items (
        id integer NOT NULL,
        label text NOT NULL
      );
    `;
    const initialSchema = `${tableSchema}
      CREATE VIEW public.item_view (item_id, item_label) AS
        SELECT id, label FROM public.source_items;
      CREATE VIEW public.item_dependency AS
        SELECT item_id FROM public.item_view;
      CREATE MATERIALIZED VIEW public.item_summary (item_id, item_label) AS
        SELECT id, label FROM public.source_items;
      CREATE INDEX item_summary_id_idx
        ON public.item_summary (item_id);
    `;
    const renamedSchema = `${tableSchema}
      CREATE VIEW public.item_view (renamed_id, renamed_label) AS
        SELECT id, label FROM public.source_items;
      CREATE VIEW public.item_dependency AS
        SELECT renamed_id AS item_id FROM public.item_view;
      CREATE MATERIALIZED VIEW public.item_summary (renamed_id, renamed_label) AS
        SELECT id, label FROM public.source_items;
      CREATE INDEX item_summary_id_idx
        ON public.item_summary (renamed_id);
    `;
    const service = createTestSchemaService();
    await service.apply(tableSchema, ["public"], true);
    await client.query("INSERT INTO public.source_items VALUES (1, 'one')");
    await service.apply(initialSchema, ["public"], true);

    const plan = await service.plan(renamedSchema, ["public"]);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ALTER VIEW "public"."item_view" RENAME COLUMN');
    expect(sql).toContain(
      'ALTER MATERIALIZED VIEW "public"."item_summary" RENAME COLUMN'
    );
    expect(sql).not.toContain('DROP VIEW IF EXISTS "public"."item_view"');
    expect(sql).not.toContain(
      'DROP MATERIALIZED VIEW IF EXISTS "public"."item_summary"'
    );

    await service.apply(renamedSchema, ["public"], true);
    expect(
      (await client.query("SELECT * FROM public.item_dependency")).rows
    ).toEqual([{ item_id: 1 }]);
    expect(
      (await client.query("SELECT * FROM public.item_summary")).rows
    ).toEqual([{ renamed_id: 1, renamed_label: "one" }]);
    expect(
      (await client.query(
        "SELECT to_regclass('public.item_summary_id_idx') AS relation"
      )).rows[0]?.relation
    ).toBe("item_summary_id_idx");
    expect((await service.plan(renamedSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("swaps colliding column names through deterministic temporary names", async function () {
    const initialSchema = `
      CREATE VIEW public.swap_view (left_name, right_name) AS
        SELECT 1 AS first_value, 2 AS second_value;
    `;
    const swappedSchema = `
      CREATE VIEW public.swap_view (right_name, left_name) AS
        SELECT 1 AS first_value, 2 AS second_value;
    `;
    const service = createTestSchemaService();
    await service.apply(initialSchema, ["public"], true);

    const plan = await service.plan(swappedSchema, ["public"]);
    expect(plan.transactional.join("\n")).toContain(
      "__terradb_view_column_1"
    );
    await service.apply(swappedSchema, ["public"], true);
    expect((await client.query("SELECT * FROM public.swap_view")).rows).toEqual([
      { right_name: 1, left_name: 2 },
    ]);
    expect((await service.plan(swappedSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("rolls back temporary column names when a later statement fails", async function () {
    const initialSchema = `
      CREATE VIEW public.swap_view (left_name, right_name) AS
        SELECT 1 AS first_value, 2 AS second_value;
      CREATE MATERIALIZED VIEW public.risky_summary AS
        SELECT 1 / 0 AS value
        WITH NO DATA;
    `;
    const failingSchema = `
      CREATE VIEW public.swap_view (right_name, left_name) AS
        SELECT 1 AS first_value, 2 AS second_value;
      CREATE MATERIALIZED VIEW public.risky_summary AS
        SELECT 1 / 0 AS value;
    `;
    const service = createTestSchemaService();
    await service.apply(initialSchema, ["public"], true);

    await expect(
      service.apply(failingSchema, ["public"], true)
    ).rejects.toThrow("division by zero");
    const columns = await client.query(`
      SELECT attribute.attname
      FROM pg_attribute attribute
      WHERE attribute.attrelid = 'public.swap_view'::regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    `);
    expect(columns.rows).toEqual([
      { attname: "left_name" },
      { attname: "right_name" },
    ]);
    expect((await service.plan(initialSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("adds columns with replacement and removes them with recreation", async function () {
    const initialSchema = `
      CREATE VIEW public.shape_view (first_name) AS
        SELECT 1 AS first_value;
    `;
    const expandedSchema = `
      CREATE VIEW public.shape_view (first_name, second_name) AS
        SELECT 1 AS first_value, 2 AS second_value;
    `;
    const service = createTestSchemaService();
    await service.apply(initialSchema, ["public"], true);

    const expandPlan = await service.plan(expandedSchema, ["public"]);
    expect(expandPlan.transactional).toHaveLength(1);
    expect(expandPlan.transactional[0]).toStartWith(
      'CREATE OR REPLACE VIEW "public"."shape_view" ("first_name", "second_name")'
    );
    await service.apply(expandedSchema, ["public"], true);
    expect((await service.plan(expandedSchema, ["public"])).hasChanges).toBe(
      false
    );

    const removePlan = await service.plan(initialSchema, ["public"]);
    expect(removePlan.transactional[0]).toContain(
      'DROP VIEW IF EXISTS "public"."shape_view";'
    );
    await service.apply(initialSchema, ["public"], true);
    expect((await client.query("SELECT * FROM public.shape_view")).rows).toEqual([
      { first_name: 1 },
    ]);
    expect((await service.plan(initialSchema, ["public"])).hasChanges).toBe(
      false
    );
  });
});
