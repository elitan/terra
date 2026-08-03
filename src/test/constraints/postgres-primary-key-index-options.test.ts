import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL primary key index options", function () {
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

  test("creates, inspects, reapplies, and enforces the primary key", async function () {
    const schema = `
      CREATE TABLE public.primary_options (
        tenant_id integer NOT NULL,
        id integer NOT NULL,
        display_name text,
        updated_at timestamp,
        CONSTRAINT primary_options_pkey
          PRIMARY KEY (tenant_id, id)
          INCLUDE (display_name, updated_at)
          WITH (fillfactor=75)
          USING INDEX TABLESPACE pg_default
          DEFERRABLE INITIALLY DEFERRED
      );
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "primary_options";
      }
    );
    expect(table?.primaryKey).toEqual({
      name: "primary_options_pkey",
      columns: ["tenant_id", "id"],
      include: ["display_name", "updated_at"],
      storageParameters: { fillfactor: "75" },
      deferrable: true,
      initiallyDeferred: true,
    });
    expect(table?.indexes).toEqual([]);
    expect((await planSchema(schema)).hasChanges).toBe(false);

    await client.query("INSERT INTO public.primary_options VALUES (1, 1, 'First', NULL)");
    await expect(
      client.query("INSERT INTO public.primary_options VALUES (1, 1, 'Second', now())")
    ).rejects.toThrow(/primary_options_pkey/);
  });

  test("changes and removes physical options without losing rows", async function () {
    await client.query(`
      CREATE TABLE public.primary_options_lifecycle (
        id integer NOT NULL,
        display_name text,
        updated_at timestamp,
        CONSTRAINT primary_options_lifecycle_pkey
          PRIMARY KEY (id) INCLUDE (display_name) WITH (fillfactor=70)
      );
      INSERT INTO public.primary_options_lifecycle
        VALUES (1, 'First', '2026-08-03 12:00:00');
    `);
    const changedSchema = `
      CREATE TABLE public.primary_options_lifecycle (
        id integer NOT NULL,
        display_name text,
        updated_at timestamp,
        CONSTRAINT primary_options_lifecycle_pkey
          PRIMARY KEY (id)
          INCLUDE (updated_at, display_name)
          WITH (fillfactor=80)
      );
    `;
    const changedPlan = await planSchema(changedSchema);
    const sql = [...changedPlan.transactional, ...changedPlan.concurrent].join("\n");
    expect(sql).toContain('DROP CONSTRAINT "primary_options_lifecycle_pkey"');
    expect(sql).toContain('INCLUDE ("updated_at", "display_name")');
    expect(sql).toContain("WITH (fillfactor=80)");
    await services.executor.executePlan(client, changedPlan, true);
    expect((await planSchema(changedSchema)).hasChanges).toBe(false);

    const plainSchema = changedSchema
      .replace("\n          INCLUDE (updated_at, display_name)", "")
      .replace("\n          WITH (fillfactor=80)", "");
    await services.executor.executePlan(client, await planSchema(plainSchema), true);
    expect(
      (await client.query("SELECT id FROM public.primary_options_lifecycle"))
        .rows
    ).toEqual([{ id: 1 }]);
    expect((await planSchema(plainSchema)).hasChanges).toBe(false);
  });
});
