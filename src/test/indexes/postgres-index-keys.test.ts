import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

describe("PostgreSQL ordered index keys", function () {
  let client: Client;
  const services = createColumnTestServices();

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  async function planSchema(schema: string): Promise<MigrationPlan> {
    const current = await services.inspector.getCurrentSchema(client);
    const desired = await services.parser.parseSchema(schema);
    return services.differ.generateMigrationPlan(desired.tables, current);
  }

  test("parses every mixed key and operator-class option in order", async function () {
    const parsed = await services.parser.parseSchema(`
      CREATE TABLE public.index_key_parser (
        title text,
        body text,
        score integer
      );
      CREATE INDEX index_key_parser_idx
        ON public.index_key_parser USING btree (
          title COLLATE pg_catalog."C" text_pattern_ops DESC NULLS LAST,
          (lower(body)) COLLATE "C" text_pattern_ops ASC NULLS FIRST,
          ((score + 1)) DESC
        );
      ALTER INDEX public.index_key_parser_idx
        ALTER COLUMN 2 SET STATISTICS 321;
      ALTER INDEX public.index_key_parser_idx
        ALTER COLUMN 3 SET STATISTICS 654;
      CREATE INDEX index_key_parser_options_idx
        ON public.index_key_parser USING gist (
          title public.gist_trgm_ops (siglen=64),
          (lower(body)) public.gist_trgm_ops (
            siglen='128',
            buffering=auto,
            custom_true=true,
            custom_false=false
          )
        );
    `);

    expect(parsed.tables[0]?.indexes?.[0]?.terms).toEqual([
      {
        column: "title",
        collation: { name: "C", schema: "pg_catalog" },
        opclass: { name: "text_pattern_ops" },
        order: "DESC",
        nullsOrder: "LAST",
      },
      {
        expression: "lower(body)",
        collation: { name: "C" },
        opclass: { name: "text_pattern_ops" },
        order: "ASC",
        nullsOrder: "FIRST",
        statisticsTarget: 321,
      },
      {
        expression: "score + 1",
        order: "DESC",
        nullsOrder: "FIRST",
        statisticsTarget: 654,
      },
    ]);
    expect(parsed.tables[0]?.indexes?.[1]?.terms).toEqual([
      {
        column: "title",
        opclass: { name: "gist_trgm_ops", schema: "public" },
        opclassOptions: { siglen: "64" },
        order: "ASC",
        nullsOrder: "LAST",
      },
      {
        expression: "lower(body)",
        opclass: { name: "gist_trgm_ops", schema: "public" },
        opclassOptions: {
          siglen: "128",
          buffering: "auto",
          custom_true: "true",
          custom_false: "false",
        },
        order: "ASC",
        nullsOrder: "LAST",
      },
    ]);
  });

  test("creates, inspects, and reapplies mixed ordered expression keys", async function () {
    const schema = `
      CREATE TABLE public.index_key_lifecycle (
        id integer NOT NULL,
        title text,
        body text,
        score integer,
        payload text
      );
      CREATE INDEX index_key_lifecycle_idx
        ON public.index_key_lifecycle USING btree (
          title COLLATE "C" text_pattern_ops DESC NULLS LAST,
          (lower(body)) COLLATE "C" text_pattern_ops NULLS FIRST,
          ((score + 1)) DESC
        ) INCLUDE (payload);
      ALTER INDEX public.index_key_lifecycle_idx
        ALTER COLUMN 2 SET STATISTICS 321;
      ALTER INDEX public.index_key_lifecycle_idx
        ALTER COLUMN 3 SET STATISTICS 654;
    `;

    const creationPlan = await planSchema(schema);
    const creationSql = [
      ...creationPlan.transactional,
      ...creationPlan.concurrent,
    ].join("\n");
    expect(creationSql).toContain('"title" COLLATE "C" text_pattern_ops DESC NULLS LAST');
    expect(creationSql).toContain('lower(body) COLLATE "C" text_pattern_ops NULLS FIRST');
    expect(creationSql).toContain('(score + 1) DESC');
    expect(creationSql).toContain("ALTER COLUMN 2 SET STATISTICS 321");
    expect(creationSql).toContain("ALTER COLUMN 3 SET STATISTICS 654");
    await services.executor.executePlan(client, creationPlan, true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "index_key_lifecycle";
      }
    );
    expect(table?.indexes?.[0]?.columns).toEqual(["title"]);
    expect(table?.indexes?.[0]?.include).toEqual(["payload"]);
    expect(table?.indexes?.[0]?.terms).toEqual([
      expect.objectContaining({
        column: "title",
        collation: { name: "C" },
        opclass: expect.objectContaining({ name: "text_pattern_ops" }),
        order: "DESC",
        nullsOrder: "LAST",
      }),
      expect.objectContaining({
        expression: "lower(body)",
        collation: { name: "C" },
        opclass: expect.objectContaining({ name: "text_pattern_ops" }),
        order: "ASC",
        nullsOrder: "FIRST",
        statisticsTarget: 321,
      }),
      expect.objectContaining({
        expression: "score + 1",
        order: "DESC",
        nullsOrder: "FIRST",
        statisticsTarget: 654,
      }),
    ]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("changes and restores per-key operator-class options", async function () {
    const schema = `
      CREATE TABLE public.index_key_options (
        id integer NOT NULL,
        title text,
        body text
      );
      CREATE INDEX index_key_options_idx
        ON public.index_key_options USING gist (
          title gist_trgm_ops (siglen=64),
          (lower(body)) gist_trgm_ops (siglen=128)
        );
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);
    expect((await planSchema(schema)).hasChanges).toBe(false);

    const changedSchema = schema.replace("siglen=128", "siglen=256");
    const changedPlan = await planSchema(changedSchema);
    const changedSql = [
      ...changedPlan.transactional,
      ...changedPlan.concurrent,
    ].join("\n");
    expect(changedSql).toContain('DROP INDEX "public"."index_key_options_idx"');
    expect(changedSql).toContain("siglen='256'");

    await expect(
      services.executor.executePlan(
        client,
        {
          ...changedPlan,
          transactional: [
            ...changedPlan.transactional,
            "SELECT * FROM public.index_key_missing_relation;",
          ],
        },
        true
      )
    ).rejects.toThrow();
    expect((await planSchema(schema)).hasChanges).toBe(false);

    await services.executor.executePlan(client, changedPlan, true);
    expect((await planSchema(changedSchema)).hasChanges).toBe(false);

    await services.executor.executePlan(client, await planSchema(schema), true);
    expect((await planSchema(schema)).hasChanges).toBe(false);
    const rows = await client.query("SELECT count(*)::integer AS count FROM public.index_key_options");
    expect(rows.rows).toEqual([{ count: 0 }]);
  });

  test("normalizes explicit default operator classes", async function () {
    const schema = `
      CREATE TABLE public.index_key_defaults (
        id integer NOT NULL,
        title text
      );
      CREATE INDEX index_key_defaults_idx
        ON public.index_key_defaults (
          id pg_catalog.int4_ops,
          title pg_catalog.text_ops
        );
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "index_key_defaults";
      }
    );
    expect(table?.indexes?.[0]?.opclasses).toBeUndefined();
    expect(table?.indexes?.[0]?.terms).toEqual([
      expect.objectContaining({
        column: "id",
        opclass: {
          name: "int4_ops",
          schema: "pg_catalog",
        },
        opclassDefault: true,
      }),
      expect.objectContaining({
        column: "title",
        opclass: {
          name: "text_ops",
          schema: "pg_catalog",
        },
        opclassDefault: true,
      }),
    ]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("changes one expression target without replacing the index", async function () {
    const schema = `
      CREATE TABLE public.index_key_statistics (
        title text,
        body text
      );
      CREATE INDEX index_key_statistics_idx
        ON public.index_key_statistics (
          (lower(title)),
          (length(body))
        );
      ALTER INDEX public.index_key_statistics_idx
        ALTER COLUMN 1 SET STATISTICS 111;
      ALTER INDEX public.index_key_statistics_idx
        ALTER COLUMN 2 SET STATISTICS 222;
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);

    const resetSchema = schema.replace(
      "ALTER COLUMN 2 SET STATISTICS 222",
      "ALTER COLUMN 2 SET STATISTICS -1"
    );
    const resetPlan = await planSchema(resetSchema);
    const resetSql = [
      ...resetPlan.transactional,
      ...resetPlan.concurrent,
    ].join("\n");
    expect(resetSql).toContain("ALTER COLUMN 2 SET STATISTICS -1");
    expect(resetSql).not.toContain("DROP INDEX");
    await services.executor.executePlan(client, resetPlan, true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "index_key_statistics";
      }
    );
    expect(table?.indexes?.[0]?.terms?.[0]?.statisticsTarget).toBe(111);
    expect(table?.indexes?.[0]?.terms?.[1]?.statisticsTarget).toBeUndefined();
    expect((await planSchema(resetSchema)).hasChanges).toBe(false);
  });

  test("supports multiple expression targets on materialized-view indexes", async function () {
    const schema = `
      CREATE TABLE public.index_key_view_source (
        title text,
        body text
      );
      CREATE MATERIALIZED VIEW public.index_key_view AS
        SELECT title, body FROM public.index_key_view_source;
      CREATE INDEX index_key_view_idx
        ON public.index_key_view (
          (lower(title)),
          (length(body))
        );
      ALTER INDEX public.index_key_view_idx
        ALTER COLUMN 1 SET STATISTICS 333;
      ALTER INDEX public.index_key_view_idx
        ALTER COLUMN 2 SET STATISTICS 444;
    `;
    const service = createTestSchemaService();
    await service.apply(schema, ["public"], true);

    const view = (await services.inspector.getCurrentViews(client, ["public"]))
      .find(function findView(candidate) {
        return candidate.name === "index_key_view";
      });
    expect(view?.indexes?.[0]?.terms?.[0]?.statisticsTarget).toBe(333);
    expect(view?.indexes?.[0]?.terms?.[1]?.statisticsTarget).toBe(444);
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);
  });
});
