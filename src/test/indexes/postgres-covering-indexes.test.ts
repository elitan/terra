import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL covering indexes", function () {
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

  test("creates, inspects, and reapplies key and payload metadata", async function () {
    const schema = `
      CREATE TABLE public.covering_metadata (
        id integer NOT NULL,
        tenant_id integer NOT NULL,
        email text NOT NULL,
        display_name text,
        updated_at timestamp,
        active boolean NOT NULL DEFAULT true
      );
      CREATE INDEX covering_metadata_lookup_idx
        ON public.covering_metadata (tenant_id, email DESC)
        INCLUDE (display_name, updated_at)
        WITH (fillfactor=80)
        WHERE active;
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);

    const tables = await services.inspector.getCurrentSchema(client);
    const table = tables.find(function findTable(candidate) {
      return candidate.name === "covering_metadata";
    });
    expect(table?.indexes).toEqual([
      {
        name: "covering_metadata_lookup_idx",
        tableName: "covering_metadata",
        schema: "public",
        columns: ["tenant_id", "email"],
        include: ["display_name", "updated_at"],
        sortOrders: ["ASC", "DESC"],
        opclasses: undefined,
        type: "btree",
        unique: false,
        concurrent: false,
        where: "active",
        expression: undefined,
        storageParameters: { fillfactor: "80" },
        tablespace: undefined,
      },
    ]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("keeps payload columns out of unique index semantics", async function () {
    const schema = `
      CREATE TABLE public.covering_unique (
        id integer NOT NULL,
        email text,
        display_name text
      );
      CREATE UNIQUE INDEX covering_unique_email_idx
        ON public.covering_unique (email)
        INCLUDE (display_name);
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);
    await client.query(
      "INSERT INTO public.covering_unique VALUES (1, 'a@example.com', 'First')"
    );
    await expect(
      client.query(
        "INSERT INTO public.covering_unique VALUES (2, 'a@example.com', 'Second')"
      )
    ).rejects.toThrow(/covering_unique_email_idx/);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "covering_unique";
      }
    );
    expect(table?.indexes?.[0]?.columns).toEqual(["email"]);
    expect(table?.indexes?.[0]?.include).toEqual(["display_name"]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("supports expression keys with plain included columns", async function () {
    const schema = `
      CREATE TABLE public.covering_expression (
        id integer NOT NULL,
        email text NOT NULL,
        display_name text
      );
      CREATE INDEX covering_expression_email_idx
        ON public.covering_expression ((lower(email)))
        INCLUDE (display_name);
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "covering_expression";
      }
    );
    expect(table?.indexes?.[0]?.columns).toEqual([]);
    expect(table?.indexes?.[0]?.expression).toBe("lower(email)");
    expect(table?.indexes?.[0]?.include).toEqual(["display_name"]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("supports every built-in access method that accepts payload columns", async function () {
    const schema = `
      CREATE TABLE public.covering_methods (
        id integer NOT NULL,
        location point,
        prefix text,
        payload text
      );
      CREATE INDEX covering_methods_location_idx
        ON public.covering_methods USING gist (location)
        INCLUDE (payload);
      CREATE INDEX covering_methods_prefix_idx
        ON public.covering_methods USING spgist (prefix)
        INCLUDE (id, payload);
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "covering_methods";
      }
    );
    expect(table?.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "covering_methods_location_idx",
          type: "gist",
          columns: ["location"],
          include: ["payload"],
        }),
        expect.objectContaining({
          name: "covering_methods_prefix_idx",
          type: "spgist",
          columns: ["prefix"],
          include: ["id", "payload"],
        }),
      ])
    );
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("adds, reorders, and removes payload columns without losing rows", async function () {
    await client.query(`
      CREATE TABLE public.covering_lifecycle (
        id integer NOT NULL,
        email text NOT NULL,
        display_name text,
        updated_at timestamp
      );
      CREATE INDEX covering_lifecycle_email_idx
        ON public.covering_lifecycle (email)
        INCLUDE (display_name);
      INSERT INTO public.covering_lifecycle
        VALUES (1, 'a@example.com', 'First', '2026-08-03 12:00:00');
    `);
    const expandedSchema = `
      CREATE TABLE public.covering_lifecycle (
        id integer NOT NULL,
        email text NOT NULL,
        display_name text,
        updated_at timestamp
      );
      CREATE INDEX covering_lifecycle_email_idx
        ON public.covering_lifecycle (email)
        INCLUDE (updated_at, display_name);
    `;
    const expandedPlan = await planSchema(expandedSchema);
    const expandedSql = [
      ...expandedPlan.transactional,
      ...expandedPlan.concurrent,
    ].join("\n");
    expect(expandedSql).toContain('DROP INDEX "public"."covering_lifecycle_email_idx"');
    expect(expandedSql).toContain('INCLUDE ("updated_at", "display_name")');
    await services.executor.executePlan(client, expandedPlan, true);
    expect((await planSchema(expandedSchema)).hasChanges).toBe(false);

    const plainSchema = expandedSchema.replace(
      "\n        INCLUDE (updated_at, display_name)",
      ""
    );
    await services.executor.executePlan(client, await planSchema(plainSchema), true);
    const rows = await client.query(
      "SELECT id, email, display_name FROM public.covering_lifecycle"
    );
    expect(rows.rows).toEqual([
      { id: 1, email: "a@example.com", display_name: "First" },
    ]);
    expect((await planSchema(plainSchema)).hasChanges).toBe(false);
  });
});
