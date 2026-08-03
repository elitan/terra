import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL index null ordering", function () {
  let client: Client;
  const services = createColumnTestServices();

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
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

  test("creates, inspects, and reapplies mixed key ordering", async function () {
    const schema = `
      CREATE TABLE public.null_order_metadata (
        id integer NOT NULL,
        starts_at timestamp,
        ends_at timestamp,
        code text,
        payload text,
        active boolean NOT NULL DEFAULT true
      );
      CREATE INDEX null_order_metadata_idx
        ON public.null_order_metadata (
          starts_at ASC NULLS FIRST,
          ends_at DESC NULLS LAST,
          id DESC,
          code ASC
        )
        INCLUDE (payload)
        WITH (fillfactor=80)
        WHERE active;
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "null_order_metadata";
      }
    );
    expect(table?.indexes?.[0]?.sortOrders).toEqual([
      "ASC",
      "DESC",
      "DESC",
      "ASC",
    ]);
    expect(table?.indexes?.[0]?.nullsOrders).toEqual([
      "FIRST",
      "LAST",
      "FIRST",
      "LAST",
    ]);
    expect(table?.indexes?.[0]?.include).toEqual(["payload"]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("normalizes explicit default null placement", async function () {
    const schema = `
      CREATE TABLE public.null_order_defaults (
        id integer NOT NULL,
        created_at timestamp
      );
      CREATE INDEX null_order_defaults_idx
        ON public.null_order_defaults (
          created_at ASC NULLS LAST,
          id DESC NULLS FIRST
        );
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "null_order_defaults";
      }
    );
    expect(table?.indexes?.[0]?.sortOrders).toEqual(["ASC", "DESC"]);
    expect(table?.indexes?.[0]?.nullsOrders).toBeUndefined();
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("supports expression keys with reversed null placement", async function () {
    const schema = `
      CREATE TABLE public.null_order_expression (
        id integer NOT NULL,
        code text,
        payload text
      );
      CREATE INDEX null_order_expression_idx
        ON public.null_order_expression ((lower(code)) DESC NULLS LAST)
        INCLUDE (payload);
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "null_order_expression";
      }
    );
    expect(table?.indexes?.[0]?.expression).toBe("lower(code)");
    expect(table?.indexes?.[0]?.sortOrders).toEqual(["DESC"]);
    expect(table?.indexes?.[0]?.nullsOrders).toEqual(["LAST"]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("uses the index for a matching null-aware ordering", async function () {
    const schema = `
      CREATE TABLE public.null_order_plan (
        id integer NOT NULL,
        event_at timestamp
      );
      CREATE INDEX null_order_plan_idx
        ON public.null_order_plan (event_at NULLS FIRST, id);
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);
    await client.query(`
      INSERT INTO public.null_order_plan VALUES
        (1, '2026-08-03 12:00:00'),
        (2, NULL),
        (3, '2026-08-02 12:00:00');
      SET enable_seqscan = off;
    `);

    const explained = await client.query(`
      EXPLAIN (COSTS OFF)
      SELECT id, event_at
      FROM public.null_order_plan
      ORDER BY event_at NULLS FIRST, id;
    `);
    const plan = explained.rows.map(function getPlanLine(row) {
      return row["QUERY PLAN"];
    }).join("\n");
    expect(plan).toContain("null_order_plan_idx");
    expect(plan).not.toContain("Sort");

    const rows = await client.query(`
      SELECT id
      FROM public.null_order_plan
      ORDER BY event_at NULLS FIRST, id;
    `);
    expect(rows.rows).toEqual([{ id: 2 }, { id: 3 }, { id: 1 }]);
  });

  test("changes and removes null placement without losing rows", async function () {
    await client.query(`
      CREATE TABLE public.null_order_lifecycle (
        id integer NOT NULL,
        event_at timestamp
      );
      CREATE INDEX null_order_lifecycle_idx
        ON public.null_order_lifecycle (event_at);
      INSERT INTO public.null_order_lifecycle VALUES
        (1, NULL),
        (2, '2026-08-03 12:00:00');
    `);
    const reversedSchema = `
      CREATE TABLE public.null_order_lifecycle (
        id integer NOT NULL,
        event_at timestamp
      );
      CREATE INDEX null_order_lifecycle_idx
        ON public.null_order_lifecycle (event_at NULLS FIRST);
    `;
    const reversedPlan = await planSchema(reversedSchema);
    const reversedSql = [
      ...reversedPlan.transactional,
      ...reversedPlan.concurrent,
    ].join("\n");
    expect(reversedSql).toContain('"event_at" NULLS FIRST');
    await services.executor.executePlan(client, reversedPlan, true);
    expect((await planSchema(reversedSchema)).hasChanges).toBe(false);

    const defaultSchema = reversedSchema.replace(" NULLS FIRST", "");
    await services.executor.executePlan(client, await planSchema(defaultSchema), true);
    expect(
      (await client.query("SELECT id FROM public.null_order_lifecycle ORDER BY id"))
        .rows
    ).toEqual([{ id: 1 }, { id: 2 }]);
    expect((await planSchema(defaultSchema)).hasChanges).toBe(false);
  });
});
