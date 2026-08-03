import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL table storage parameters", function () {
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

  async function inspectParameters(
    tableName: string
  ): Promise<Record<string, string> | undefined> {
    const tables = await services.inspector.getCurrentSchema(client);
    return tables.find(function findTable(table) {
      return table.name === tableName;
    })?.storageParameters;
  }

  test("parses and renders scalar and toast parameters", async function () {
    const desired = await services.parser.parseSchema(`
      CREATE TABLE public.parameter_parser (
        payload text
      ) WITH (
        fillfactor=70,
        autovacuum_enabled,
        autovacuum_vacuum_scale_factor=0.2,
        vacuum_index_cleanup=auto,
        toast.autovacuum_enabled=false
      );
    `);

    expect(desired.tables[0]?.storageParameters).toEqual({
      fillfactor: "70",
      autovacuum_enabled: "true",
      autovacuum_vacuum_scale_factor: "0.2",
      vacuum_index_cleanup: "auto",
      "toast.autovacuum_enabled": "false",
    });

    const sql = services.differ
      .generateMigrationPlan(desired.tables, [])
      .transactional.join("\n");
    expect(sql).toContain(
      "WITH (autovacuum_enabled=true, autovacuum_vacuum_scale_factor=0.2, fillfactor=70, toast.autovacuum_enabled=false, vacuum_index_cleanup=auto)"
    );
  });

  test("creates, inspects, and reapplies table and toast parameters", async function () {
    const schema = `
      CREATE TABLE public.parameter_create (
        id integer PRIMARY KEY,
        payload text
      ) WITH (
        fillfactor=70,
        autovacuum_enabled=false,
        toast.autovacuum_enabled=false,
        toast_tuple_target=2040,
        parallel_workers=2
      );
    `;

    await services.executor.executePlan(client, await planSchema(schema), true);

    expect(await inspectParameters("parameter_create")).toEqual({
      fillfactor: "70",
      autovacuum_enabled: "false",
      toast_tuple_target: "2040",
      parallel_workers: "2",
      "toast.autovacuum_enabled": "false",
    });
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("sets, changes, and resets parameters without losing rows", async function () {
    await client.query(`
      CREATE TABLE public.parameter_change (
        id integer PRIMARY KEY,
        payload text
      ) WITH (
        fillfactor=70,
        autovacuum_enabled=false,
        toast.autovacuum_enabled=false,
        toast_tuple_target=2040
      );
      INSERT INTO public.parameter_change VALUES (1, 'preserved');
    `);
    const schema = `
      CREATE TABLE public.parameter_change (
        id integer PRIMARY KEY,
        payload text
      ) WITH (fillfactor=85, parallel_workers=3);
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain(
      "RESET (autovacuum_enabled, toast.autovacuum_enabled, toast_tuple_target)"
    );
    expect(sql).toContain("SET (fillfactor=85, parallel_workers=3)");
    expect(sql).not.toMatch(/DROP (?:TABLE|COLUMN)/);
    await services.executor.executePlan(client, plan, true);

    expect(await inspectParameters("parameter_change")).toEqual({
      fillfactor: "85",
      parallel_workers: "3",
    });
    expect(
      (await client.query("SELECT * FROM public.parameter_change")).rows
    ).toEqual([{ id: 1, payload: "preserved" }]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("resets all parameters when the desired table omits WITH", async function () {
    await client.query(`
      CREATE TABLE public.parameter_reset (payload text)
      WITH (fillfactor=75, toast.autovacuum_enabled=false);
    `);
    const schema = `
      CREATE TABLE public.parameter_reset (payload text);
    `;

    const plan = await planSchema(schema);
    expect(plan.transactional.join("\n")).toContain(
      "RESET (fillfactor, toast.autovacuum_enabled)"
    );
    await services.executor.executePlan(client, plan, true);

    expect(await inspectParameters("parameter_reset")).toBeUndefined();
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("combines parameter and column changes in one table plan", async function () {
    await client.query(`
      CREATE TABLE public.parameter_combined (id integer PRIMARY KEY);
    `);
    const schema = `
      CREATE TABLE public.parameter_combined (
        id integer PRIMARY KEY,
        payload text
      ) WITH (fillfactor=75);
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ADD COLUMN "payload" TEXT');
    expect(sql).toContain("SET (fillfactor=75)");
    await services.executor.executePlan(client, plan, true);

    expect(await inspectParameters("parameter_combined")).toEqual({
      fillfactor: "75",
    });
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });
});
