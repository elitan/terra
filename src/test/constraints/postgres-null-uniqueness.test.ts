import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationContext, MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL NULLS NOT DISTINCT uniqueness", function () {
  let client: Client;
  let context: MigrationContext;
  const services = createColumnTestServices();

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    const result = await client.query(
      "SELECT current_setting('server_version_num') AS version"
    );
    context = { postgresVersionNum: Number(result.rows[0]?.version) };
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  async function planSchema(schema: string): Promise<MigrationPlan> {
    const current = await services.inspector.getCurrentSchema(client);
    const desired = await services.parser.parseSchema(schema);
    return services.differ.generateMigrationPlan(
      desired.tables,
      current,
      context
    );
  }

  test("fails closed on PostgreSQL 14 and inspects its catalogs safely", async function () {
    await client.query(`
      CREATE TABLE public.nulls_version_probe (email text UNIQUE);
      CREATE UNIQUE INDEX nulls_version_probe_idx
        ON public.nulls_version_probe (email);
    `);
    const inspected = await services.inspector.getCurrentSchema(client);
    const probe = inspected.find(function findProbe(table) {
      return table.name === "nulls_version_probe";
    });
    expect(probe?.uniqueConstraints?.[0]?.nullsNotDistinct).toBeUndefined();
    expect(probe?.indexes?.[0]?.nullsNotDistinct).toBeUndefined();

    const desired = await services.parser.parseSchema(`
      CREATE TABLE public.nulls_version_probe (
        email text UNIQUE NULLS NOT DISTINCT
      );
    `);
    expect(function rejectPostgres14() {
      services.differ.generateMigrationPlan(desired.tables, inspected, {
        postgresVersionNum: 140000,
      });
    }).toThrow("PostgreSQL 15 or newer is required");
    expect(function rejectUnknownVersion() {
      services.differ.generateMigrationPlan(desired.tables, inspected);
    }).toThrow("without the PostgreSQL server version");
  });

  test("creates, inspects, reapplies, and enforces a unique constraint", async function () {
    if ((context.postgresVersionNum || 0) < 150000) return;
    const schema = `
      CREATE TABLE public.nulls_constraint (
        id integer NOT NULL,
        email text,
        CONSTRAINT nulls_constraint_email_key
          UNIQUE NULLS NOT DISTINCT (email)
      );
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);

    const tables = await services.inspector.getCurrentSchema(client);
    const table = tables.find(function findTable(candidate) {
      return candidate.name === "nulls_constraint";
    });
    expect(table?.uniqueConstraints).toEqual([
      {
        name: "nulls_constraint_email_key",
        columns: ["email"],
        nullsNotDistinct: true,
      },
    ]);
    expect(table?.indexes).toEqual([]);
    expect((await planSchema(schema)).hasChanges).toBe(false);

    await client.query("INSERT INTO public.nulls_constraint VALUES (1, NULL)");
    await expect(
      client.query("INSERT INTO public.nulls_constraint VALUES (2, NULL)")
    ).rejects.toThrow(/nulls_constraint_email_key/);
  });

  test("creates, inspects, reapplies, and enforces a unique index", async function () {
    if ((context.postgresVersionNum || 0) < 150000) return;
    const schema = `
      CREATE TABLE public.nulls_index (id integer NOT NULL, code text);
      CREATE UNIQUE INDEX nulls_index_code_idx
        ON public.nulls_index (code) NULLS NOT DISTINCT
        WITH (fillfactor=80)
        WHERE (code IS NULL OR code IS NOT NULL);
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);

    const tables = await services.inspector.getCurrentSchema(client);
    const table = tables.find(function findTable(candidate) {
      return candidate.name === "nulls_index";
    });
    expect(table?.indexes?.[0]?.nullsNotDistinct).toBe(true);
    expect(table?.indexes?.[0]?.storageParameters).toEqual({
      fillfactor: "80",
    });
    expect(table?.indexes?.[0]?.where).toContain("code IS NULL");
    expect((await planSchema(schema)).hasChanges).toBe(false);

    await client.query("INSERT INTO public.nulls_index VALUES (1, NULL)");
    await expect(
      client.query("INSERT INTO public.nulls_index VALUES (2, NULL)")
    ).rejects.toThrow(/nulls_index_code_idx/);
  });

  test("changes constraint and index null semantics without losing rows", async function () {
    if ((context.postgresVersionNum || 0) < 150000) return;
    await client.query(`
      CREATE TABLE public.nulls_lifecycle (
        id integer NOT NULL,
        email text,
        code text,
        CONSTRAINT nulls_lifecycle_email_key UNIQUE (email)
      );
      CREATE UNIQUE INDEX nulls_lifecycle_code_idx
        ON public.nulls_lifecycle (code);
      INSERT INTO public.nulls_lifecycle VALUES (1, NULL, NULL);
    `);
    const strictSchema = `
      CREATE TABLE public.nulls_lifecycle (
        id integer NOT NULL,
        email text,
        code text,
        CONSTRAINT nulls_lifecycle_email_key
          UNIQUE NULLS NOT DISTINCT (email)
      );
      CREATE UNIQUE INDEX nulls_lifecycle_code_idx
        ON public.nulls_lifecycle (code) NULLS NOT DISTINCT;
    `;
    const strictPlan = await planSchema(strictSchema);
    const strictSql = [
      ...strictPlan.transactional,
      ...strictPlan.concurrent,
    ].join("\n");
    expect(strictSql).toContain(
      'DROP CONSTRAINT "nulls_lifecycle_email_key"'
    );
    expect(strictSql).toContain("UNIQUE NULLS NOT DISTINCT");
    expect(strictSql).toContain("NULLS NOT DISTINCT");
    await services.executor.executePlan(client, strictPlan, true);
    expect((await planSchema(strictSchema)).hasChanges).toBe(false);

    const ordinarySchema = strictSchema.replaceAll(" NULLS NOT DISTINCT", "");
    await services.executor.executePlan(
      client,
      await planSchema(ordinarySchema),
      true
    );
    await client.query(
      "INSERT INTO public.nulls_lifecycle VALUES (2, NULL, NULL)"
    );
    expect(
      (await client.query("SELECT id FROM public.nulls_lifecycle ORDER BY id"))
        .rows
    ).toEqual([{ id: 1 }, { id: 2 }]);
    expect((await planSchema(ordinarySchema)).hasChanges).toBe(false);
  });
});
