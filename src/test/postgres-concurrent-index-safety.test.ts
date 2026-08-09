import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { cleanDatabase, createTestClient, createTestSchemaService } from "./utils";

describe("PostgreSQL concurrent index safety", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    try {
      await cleanDatabase(client);
    } finally {
      await client.end();
    }
  });

  test("rejects mixed or multiple concurrent work before mutation", async function () {
    const service = createTestSchemaService();
    await client.query(`
      CREATE TABLE public.concurrent_guard (
        id integer,
        value integer
      );
    `);
    const mixed = `
      CREATE TABLE public.concurrent_guard (
        id integer,
        value integer,
        label text
      );
      CREATE INDEX CONCURRENTLY concurrent_guard_id_idx
        ON public.concurrent_guard (id);
    `;
    const multiple = `
      CREATE TABLE public.concurrent_guard (id integer, value integer);
      CREATE INDEX CONCURRENTLY concurrent_guard_id_idx
        ON public.concurrent_guard (id);
      CREATE INDEX CONCURRENTLY concurrent_guard_value_idx
        ON public.concurrent_guard (value);
    `;

    for (const desired of [mixed, multiple]) {
      await expect(service.plan(desired, ["public"])).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        entity: "concurrent index",
        field: "standalone migration",
      });
      await expect(service.apply(desired, ["public"], true)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }

    expect(await indexStates(client, "concurrent_guard")).toEqual([]);
    expect(await tableColumns(client, "concurrent_guard")).toEqual([
      "id",
      "value",
    ]);
  });

  test("removes an invalid index artifact after a standalone concurrent failure", async function () {
    const service = createTestSchemaService();
    await client.query(`
      CREATE TABLE public.concurrent_failure (
        id integer,
        value integer
      );
      INSERT INTO public.concurrent_failure VALUES (1, 9), (2, 9);
    `);
    const desired = `
      CREATE TABLE public.concurrent_failure (id integer, value integer);
      CREATE UNIQUE INDEX CONCURRENTLY concurrent_failure_value_idx
        ON public.concurrent_failure (value);
    `;

    const plan = await service.plan(desired, ["public"]);
    expect(plan.concurrent).toEqual([
      'CREATE UNIQUE INDEX CONCURRENTLY "concurrent_failure_value_idx" ON "public"."concurrent_failure" ("value");',
    ]);
    await expect(service.apply(desired, ["public"], true)).rejects.toMatchObject({
      code: "23505",
    });

    expect(await indexStates(client, "concurrent_failure")).toEqual([]);
    expect(
      (await client.query("SELECT id, value FROM public.concurrent_failure ORDER BY id")).rows
    ).toEqual([
      { id: 1, value: 9 },
      { id: 2, value: 9 },
    ]);
  });

  test("applies a standalone concurrent index and converges", async function () {
    const service = createTestSchemaService();
    await client.query("CREATE TABLE public.concurrent_success (id integer)");
    const desired = `
      CREATE TABLE public.concurrent_success (id integer);
      CREATE INDEX CONCURRENTLY concurrent_success_id_idx
        ON public.concurrent_success (id);
    `;

    await service.apply(desired, ["public"], true);
    expect(await indexStates(client, "concurrent_success")).toEqual([
      { name: "concurrent_success_id_idx", valid: true },
    ]);
    expect((await service.plan(desired, ["public"])).hasChanges).toBe(false);
  });

  test("keeps a single index removal concurrent but makes mixed removals atomic", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE TABLE public.concurrent_drops (
        id integer,
        value integer,
        label text
      );
      CREATE INDEX concurrent_drops_id_idx ON public.concurrent_drops (id);
      CREATE INDEX concurrent_drops_value_idx ON public.concurrent_drops (value);
    `;
    const singleDrop = `
      CREATE TABLE public.concurrent_drops (
        id integer,
        value integer,
        label text
      );
      CREATE INDEX concurrent_drops_id_idx ON public.concurrent_drops (id);
    `;
    const mixedDrop = `
      CREATE TABLE public.concurrent_drops (
        id integer,
        value integer,
        label text,
        revision integer
      );
    `;

    await service.apply(initial, ["public"], true);
    const singleDropPlan = await service.plan(singleDrop, ["public"]);
    expect(singleDropPlan.concurrent).toEqual([
      'DROP INDEX CONCURRENTLY "public"."concurrent_drops_value_idx";',
    ]);
    await service.apply(singleDrop, ["public"], true);

    await service.apply(initial, ["public"], true);
    const mixedDropPlan = await service.plan(mixedDrop, ["public"]);
    expect(mixedDropPlan.concurrent).toEqual([]);
    expect(mixedDropPlan.deferred).toEqual([]);
    expect(mixedDropPlan.transactional).toContain(
      'DROP INDEX "public"."concurrent_drops_id_idx";'
    );
    expect(mixedDropPlan.transactional).toContain(
      'DROP INDEX "public"."concurrent_drops_value_idx";'
    );
    await service.apply(mixedDrop, ["public"], true);
    expect((await service.plan(mixedDrop, ["public"])).hasChanges).toBe(false);
  });
});

async function indexStates(
  client: Client,
  tableName: string
): Promise<Array<{ name: string; valid: boolean }>> {
  const result = await client.query<{ name: string; valid: boolean }>(
    `SELECT index_relation.relname AS name, index_catalog.indisvalid AS valid
     FROM pg_class relation
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     JOIN pg_index index_catalog ON index_catalog.indrelid = relation.oid
     JOIN pg_class index_relation ON index_relation.oid = index_catalog.indexrelid
     WHERE namespace.nspname = 'public' AND relation.relname = $1
     ORDER BY index_relation.relname`,
    [tableName]
  );
  return result.rows;
}

async function tableColumns(client: Client, tableName: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );
  return result.rows.map(function (row) {
    return row.column_name;
  });
}
