import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { SchemaParser } from "../../core/schema/parser";
import { DatabaseInspector } from "../../core/schema/inspector";
import {
  generateCreateViewSQL,
  generateRefreshMaterializedViewSQL,
} from "../../utils/sql";
import { getStatementRisk } from "../../utils/statement-classifier";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

describe("PostgreSQL materialized view population state", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  async function getPopulationState(viewName: string): Promise<boolean> {
    const result = await client.query(
      `
        SELECT ispopulated
        FROM pg_matviews
        WHERE schemaname = 'public' AND matviewname = $1
      `,
      [viewName]
    );
    return result.rows[0]?.ispopulated;
  }

  async function getMaterializedViewOid(viewName: string): Promise<number> {
    const result = await client.query(
      `
        SELECT relation.oid::integer
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = $1
          AND relation.relkind = 'm'
      `,
      [viewName]
    );
    return result.rows[0]?.oid;
  }

  test("parses and generates WITH NO DATA distinctly from the populated default", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE MATERIALIZED VIEW public.default_summary
        AS SELECT 1 AS id;
      CREATE MATERIALIZED VIEW public.explicit_summary
        AS SELECT 1 AS id WITH DATA;
      CREATE MATERIALIZED VIEW public.empty_summary
        AS SELECT 1 AS id WITH NO DATA;
    `);

    expect(parsed.views.map(function population(view) {
      return [view.name, view.populated];
    })).toEqual([
      ["default_summary", true],
      ["explicit_summary", true],
      ["empty_summary", false],
    ]);
    expect(generateCreateViewSQL(parsed.views[2])).toBe(
      'CREATE MATERIALIZED VIEW "public"."empty_summary" AS SELECT 1 AS id WITH NO DATA;'
    );
    expect(
      generateRefreshMaterializedViewSQL(
        "empty_summary",
        false,
        "public",
        true
      )
    ).toBe(
      'REFRESH MATERIALIZED VIEW "public"."empty_summary" WITH DATA;'
    );
    expect(
      generateRefreshMaterializedViewSQL(
        "empty_summary",
        false,
        "public",
        false
      )
    ).toBe(
      'REFRESH MATERIALIZED VIEW "public"."empty_summary" WITH NO DATA;'
    );
    function generateInvalidConcurrentRefresh(): string {
      return generateRefreshMaterializedViewSQL(
        "empty_summary",
        true,
        "public",
        false
      );
    }
    expect(generateInvalidConcurrentRefresh).toThrow(
      "PostgreSQL does not allow CONCURRENTLY with WITH NO DATA"
    );
  });

  test("creates, inspects, and reapplies an unpopulated materialized view", async function () {
    const schema = `
      CREATE TABLE public.source_items (id integer NOT NULL);
      CREATE MATERIALIZED VIEW public.item_summary AS
        SELECT id FROM public.source_items
        WITH NO DATA;
    `;
    const service = createTestSchemaService();
    const createPlan = await service.apply(schema, ["public"], true);
    expect(createPlan.transactional.some(function createsUnpopulatedView(statement) {
      return statement.startsWith(
        'CREATE MATERIALIZED VIEW "public"."item_summary"'
      ) && statement.endsWith("WITH NO DATA;");
    })).toBe(true);
    expect(await getPopulationState("item_summary")).toBe(false);

    const views = await new DatabaseInspector().getCurrentViews(client, ["public"]);
    const view = views.find(function findView(candidate) {
      return candidate.name === "item_summary";
    });
    expect(view?.populated).toBe(false);
    await expect(
      client.query("SELECT * FROM public.item_summary")
    ).rejects.toThrow("has not been populated");
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);
  });

  test("changes population state without rebuilding the materialized view", async function () {
    const tableSchema = `
      CREATE TABLE public.source_items (id integer NOT NULL);
    `;
    const populatedSchema = `${tableSchema}
      CREATE MATERIALIZED VIEW public.item_summary AS
        SELECT id FROM public.source_items;
    `;
    const unpopulatedSchema = populatedSchema.replace(
      "SELECT id FROM public.source_items;",
      "SELECT id FROM public.source_items WITH NO DATA;"
    );
    const service = createTestSchemaService();
    await service.apply(tableSchema, ["public"], true);
    await client.query("INSERT INTO public.source_items VALUES (1), (2)");
    await service.apply(populatedSchema, ["public"], true);
    expect(await getPopulationState("item_summary")).toBe(true);
    const originalOid = await getMaterializedViewOid("item_summary");
    const materializedRows = [{ id: 1 }, { id: 2 }];
    expect(
      await client.query("SELECT id FROM public.item_summary ORDER BY id")
    ).toMatchObject({ rows: materializedRows });

    const emptyPlan = await service.plan(unpopulatedSchema, ["public"]);
    const depopulationStatement =
      'REFRESH MATERIALIZED VIEW "public"."item_summary" WITH NO DATA;';
    expect(emptyPlan.transactional).toEqual([depopulationStatement]);
    expect(getStatementRisk(depopulationStatement, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(
        unpopulatedSchema,
        ["public"],
        true,
        undefined,
        false,
        true
      )
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: [depopulationStatement],
    });
    expect(await getPopulationState("item_summary")).toBe(true);
    expect(await getMaterializedViewOid("item_summary")).toBe(originalOid);
    expect(
      await client.query("SELECT id FROM public.item_summary ORDER BY id")
    ).toMatchObject({ rows: materializedRows });

    await service.apply(unpopulatedSchema, ["public"], true);
    expect(await getPopulationState("item_summary")).toBe(false);
    expect(await getMaterializedViewOid("item_summary")).toBe(originalOid);
    await expect(
      client.query("SELECT id FROM public.item_summary")
    ).rejects.toThrow("has not been populated");
    expect((await service.plan(unpopulatedSchema, ["public"])).hasChanges).toBe(
      false
    );

    const populatePlan = await service.plan(populatedSchema, ["public"]);
    const populationStatement =
      'REFRESH MATERIALIZED VIEW "public"."item_summary" WITH DATA;';
    expect(populatePlan.transactional).toEqual([populationStatement]);
    expect(getStatementRisk(populationStatement, "transactional")).toBe(
      "safe"
    );
    await service.apply(populatedSchema, ["public"], true);
    expect(await getPopulationState("item_summary")).toBe(true);
    expect(await getMaterializedViewOid("item_summary")).toBe(originalOid);
    expect(
      await client.query("SELECT id FROM public.item_summary ORDER BY id")
    ).toMatchObject({ rows: materializedRows });
    expect((await service.plan(populatedSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("rolls back a failed population transition", async function () {
    const unpopulatedSchema = `
      CREATE MATERIALIZED VIEW public.risky_summary AS
        SELECT 1 / 0 AS value
        WITH NO DATA;
    `;
    const populatedSchema = `
      CREATE TABLE public.rollback_marker (id integer);
      CREATE MATERIALIZED VIEW public.risky_summary AS
        SELECT 1 / 0 AS value;
    `;
    const service = createTestSchemaService();
    await service.apply(unpopulatedSchema, ["public"], true);

    await expect(
      service.apply(populatedSchema, ["public"], true)
    ).rejects.toThrow("division by zero");
    expect(await getPopulationState("risky_summary")).toBe(false);
    const marker = await client.query(
      "SELECT to_regclass('public.rollback_marker') AS relation"
    );
    expect(marker.rows[0]?.relation).toBeNull();
  });
});
