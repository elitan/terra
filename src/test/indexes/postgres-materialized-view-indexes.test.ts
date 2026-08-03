import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { SchemaParser } from "../../core/schema/parser";
import { DatabaseInspector } from "../../core/schema/inspector";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

describe("PostgreSQL materialized view indexes", function () {
  let client: Client;
  const parser = new SchemaParser();

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client, ["public", "tenant_a", "tenant_b"]);
  });

  afterEach(async function () {
    await cleanDatabase(client, ["public", "tenant_a", "tenant_b"]);
    await client.end();
  });

  test("associates materialized view indexes and rejects ordinary view targets", async function () {
    const parsed = await parser.parseSchema(`
      CREATE TABLE public.source_items (
        id integer NOT NULL,
        label text
      );
      CREATE MATERIALIZED VIEW public.item_summary AS
        SELECT id, label FROM public.source_items;
      CREATE INDEX item_summary_label_idx
        ON public.item_summary (label COLLATE "C");
    `);

    expect(parsed.tables[0]?.indexes).toBeUndefined();
    expect(parsed.views[0]?.indexes).toEqual([
      expect.objectContaining({
        name: "item_summary_label_idx",
        schema: "public",
        tableName: "item_summary",
        columns: ["label"],
        collations: [{ name: "C" }],
      }),
    ]);

    await expect(
      parser.parseSchema(`
        CREATE TABLE public.source_items (id integer NOT NULL);
        CREATE VIEW public.item_view AS
          SELECT id FROM public.source_items;
        CREATE INDEX item_view_id_idx ON public.item_view (id);
      `)
    ).rejects.toThrow(
      "Index item_view_id_idx targets ordinary view public.item_view"
    );
  });

  test("creates, inspects, and reapplies complete index metadata", async function () {
    const schema = `
      CREATE TABLE public.source_items (
        id integer NOT NULL,
        label text,
        active boolean NOT NULL
      );
      CREATE MATERIALIZED VIEW public.item_summary AS
        SELECT id, label, active FROM public.source_items;
      CREATE UNIQUE INDEX item_summary_id_idx
        ON public.item_summary (id DESC NULLS LAST)
        INCLUDE (label)
        WITH (fillfactor=80);
      CREATE INDEX item_summary_label_idx
        ON public.item_summary ((lower(label)) COLLATE "C")
        WHERE active;
    `;
    const service = createTestSchemaService();
    const createPlan = await service.apply(schema, ["public"], true);
    const viewPosition = createPlan.transactional.findIndex(function findView(
      statement
    ) {
      return statement.startsWith("CREATE MATERIALIZED VIEW");
    });
    const indexPosition = createPlan.transactional.findIndex(function findIndex(
      statement
    ) {
      return statement.startsWith("CREATE UNIQUE INDEX");
    });
    expect(viewPosition).toBeGreaterThanOrEqual(0);
    expect(indexPosition).toBeGreaterThan(viewPosition);

    const views = await new DatabaseInspector().getCurrentViews(client, ["public"]);
    const view = views.find(function findView(candidate) {
      return candidate.name === "item_summary";
    });
    expect(view?.indexes).toHaveLength(2);
    expect(view?.indexes).toEqual([
      expect.objectContaining({
        name: "item_summary_id_idx",
        columns: ["id"],
        include: ["label"],
        sortOrders: ["DESC"],
        nullsOrders: ["LAST"],
        unique: true,
        storageParameters: { fillfactor: "80" },
      }),
      expect.objectContaining({
        name: "item_summary_label_idx",
        columns: [],
        expression: "lower(label)",
        collations: [{ name: "C" }],
        where: "active",
      }),
    ]);
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);
  });

  test("changes and removes an index without rebuilding the materialized view", async function () {
    const schemaWithC = `
      CREATE TABLE public.source_items (
        id integer NOT NULL,
        label text
      );
      CREATE MATERIALIZED VIEW public.item_summary AS
        SELECT id, label FROM public.source_items;
      CREATE INDEX item_summary_label_idx
        ON public.item_summary (label COLLATE "C");
    `;
    const service = createTestSchemaService();
    await service.apply(schemaWithC, ["public"], true);
    await client.query(`
      INSERT INTO public.source_items VALUES (1, 'alpha'), (2, 'Zulu');
      REFRESH MATERIALIZED VIEW public.item_summary;
    `);

    const schemaWithPosix = schemaWithC.replace(
      'COLLATE "C"',
      'COLLATE "POSIX"'
    );
    const changePlan = await service.plan(schemaWithPosix, ["public"]);
    expect(changePlan.transactional).toEqual([
      'DROP INDEX "public"."item_summary_label_idx";',
      'CREATE INDEX "item_summary_label_idx" ON "public"."item_summary" ("label" COLLATE "POSIX");',
    ]);
    await service.apply(schemaWithPosix, ["public"], true);
    expect((await service.plan(schemaWithPosix, ["public"])).hasChanges).toBe(
      false
    );

    const schemaWithoutIndex = schemaWithC.replace(
      /\s*CREATE INDEX item_summary_label_idx\s+ON public\.item_summary \(label COLLATE "C"\);/,
      ""
    );
    const removePlan = await service.plan(schemaWithoutIndex, ["public"]);
    expect(removePlan.transactional).toEqual([
      'DROP INDEX "public"."item_summary_label_idx";',
    ]);
    await service.apply(schemaWithoutIndex, ["public"], true);
    expect((await service.plan(schemaWithoutIndex, ["public"])).hasChanges).toBe(
      false
    );

    const rows = await client.query(
      "SELECT id, label FROM public.item_summary ORDER BY id"
    );
    expect(rows.rows).toEqual([
      { id: 1, label: "alpha" },
      { id: 2, label: "Zulu" },
    ]);
  });

  test("converges with an externally created index and restores it after view replacement", async function () {
    const baseSchema = `
      CREATE TABLE public.source_items (
        id integer NOT NULL,
        label text
      );
      CREATE MATERIALIZED VIEW public.item_summary AS
        SELECT id, label FROM public.source_items;
    `;
    const schemaWithIndex = `${baseSchema}
      CREATE UNIQUE INDEX item_summary_id_idx
        ON public.item_summary (id);
    `;
    const service = createTestSchemaService();
    await service.apply(baseSchema, ["public"], true);
    await client.query(`
      CREATE UNIQUE INDEX item_summary_id_idx
        ON public.item_summary (id)
    `);
    expect((await service.plan(schemaWithIndex, ["public"])).hasChanges).toBe(
      false
    );

    const replacedSchema = schemaWithIndex.replace(
      "SELECT id, label FROM public.source_items",
      "SELECT id, label, upper(label) AS normalized_label FROM public.source_items"
    );
    const replacePlan = await service.plan(replacedSchema, ["public"]);
    expect(replacePlan.transactional.some(function dropsView(statement) {
      return statement.includes("DROP MATERIALIZED VIEW");
    })).toBe(true);
    expect(replacePlan.transactional.at(-1)).toBe(
      'CREATE UNIQUE INDEX "item_summary_id_idx" ON "public"."item_summary" ("id");'
    );
    await service.apply(replacedSchema, ["public"], true);
    expect((await service.plan(replacedSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("keeps same-name materialized view indexes isolated by schema", async function () {
    const schema = `
      CREATE SCHEMA tenant_a;
      CREATE SCHEMA tenant_b;
      CREATE TABLE tenant_a.source_items (
        id integer NOT NULL,
        label text
      );
      CREATE TABLE tenant_b.source_items (
        id integer NOT NULL,
        label text
      );
      CREATE MATERIALIZED VIEW tenant_a.item_summary AS
        SELECT id, label FROM tenant_a.source_items;
      CREATE MATERIALIZED VIEW tenant_b.item_summary AS
        SELECT id, label FROM tenant_b.source_items;
      CREATE INDEX item_summary_lookup_idx
        ON tenant_a.item_summary (label COLLATE "C");
      CREATE INDEX item_summary_lookup_idx
        ON tenant_b.item_summary (id DESC);
    `;
    const service = createTestSchemaService();
    const managedSchemas = ["tenant_a", "tenant_b"];
    await service.apply(schema, managedSchemas, true);
    expect((await service.plan(schema, managedSchemas)).hasChanges).toBe(false);

    const views = await new DatabaseInspector().getCurrentViews(
      client,
      managedSchemas
    );
    const tenantA = views.find(function findView(view) {
      return view.schema === "tenant_a" && view.name === "item_summary";
    });
    const tenantB = views.find(function findView(view) {
      return view.schema === "tenant_b" && view.name === "item_summary";
    });
    expect(tenantA?.indexes?.[0]).toEqual(
      expect.objectContaining({
        schema: "tenant_a",
        columns: ["label"],
        collations: [{ name: "C" }],
      })
    );
    expect(tenantB?.indexes?.[0]).toEqual(
      expect.objectContaining({
        schema: "tenant_b",
        columns: ["id"],
        sortOrders: ["DESC"],
      })
    );

    const withoutTenantAIndex = schema.replace(
      /\s*CREATE INDEX item_summary_lookup_idx\s+ON tenant_a\.item_summary \(label COLLATE "C"\);/,
      ""
    );
    const plan = await service.plan(withoutTenantAIndex, managedSchemas);
    expect(plan.transactional).toEqual([
      'DROP INDEX "tenant_a"."item_summary_lookup_idx";',
    ]);
    await service.apply(withoutTenantAIndex, managedSchemas, true);
    expect(
      (await service.plan(withoutTenantAIndex, managedSchemas)).hasChanges
    ).toBe(false);
  });
});
