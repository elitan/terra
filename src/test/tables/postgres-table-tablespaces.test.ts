import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

const TEST_TABLESPACE = "terradb_table_tablespace_test";
const TEST_TABLESPACE_PATH = "/tmp/terradb_table_tablespace_test";

describe("PostgreSQL table tablespaces", function () {
  let client: Client;
  const services = createColumnTestServices();

  beforeAll(async function () {
    const setupClient = await createTestClient();
    try {
      await cleanDatabase(setupClient);
      await setupClient.query(`DROP TABLESPACE IF EXISTS ${TEST_TABLESPACE}`);
      await setupClient.query(
        `COPY (SELECT '') TO PROGRAM 'rm -rf ${TEST_TABLESPACE_PATH}'`
      );
      await setupClient.query(
        `COPY (SELECT '') TO PROGRAM 'mkdir -p ${TEST_TABLESPACE_PATH}'`
      );
      await setupClient.query(
        `CREATE TABLESPACE ${TEST_TABLESPACE} LOCATION '${TEST_TABLESPACE_PATH}'`
      );
    } finally {
      await setupClient.end();
    }
  });

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  afterAll(async function () {
    const cleanupClient = await createTestClient();
    try {
      await cleanDatabase(cleanupClient);
      await cleanupClient.query(`DROP TABLESPACE IF EXISTS ${TEST_TABLESPACE}`);
      await cleanupClient.query(
        `COPY (SELECT '') TO PROGRAM 'rm -rf ${TEST_TABLESPACE_PATH}'`
      );
    } finally {
      await cleanupClient.end();
    }
  });

  async function planSchema(schema: string): Promise<MigrationPlan> {
    const current = await services.inspector.getCurrentSchema(client);
    const desired = await services.parser.parseSchema(schema);
    return services.differ.generateMigrationPlan(desired.tables, current);
  }

  async function inspectTablespace(
    tableName: string
  ): Promise<string | undefined> {
    const tables = await services.inspector.getCurrentSchema(client);
    return tables.find(function findTable(table) {
      return table.name === tableName;
    })?.tablespace;
  }

  test("parses and quotes a table tablespace", async function () {
    const desired = await services.parser.parseSchema(`
      CREATE TABLE public.tablespace_parser (id integer)
      TABLESPACE "Fast Table Space";
    `);

    expect(desired.tables[0]?.tablespace).toBe("Fast Table Space");
    const plan = services.differ.generateMigrationPlan(desired.tables, []);
    expect(plan.transactional.join("\n")).toContain(
      'TABLESPACE "Fast Table Space"'
    );
  });

  test("creates, inspects, and reapplies a custom tablespace", async function () {
    const schema = `
      CREATE TABLE public.tablespace_create (
        id integer PRIMARY KEY,
        payload text
      ) TABLESPACE ${TEST_TABLESPACE};
    `;

    await services.executor.executePlan(client, await planSchema(schema), true);

    expect(await inspectTablespace("tablespace_create")).toBe(TEST_TABLESPACE);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("moves a table to a custom tablespace with other changes", async function () {
    await client.query(`
      CREATE TABLE public.tablespace_move (
        id integer PRIMARY KEY,
        payload text
      );
      INSERT INTO public.tablespace_move VALUES (1, 'preserved');
    `);
    const schema = `
      CREATE TABLE public.tablespace_move (
        id integer PRIMARY KEY,
        payload text,
        added integer
      ) TABLESPACE ${TEST_TABLESPACE};
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain(`SET TABLESPACE "${TEST_TABLESPACE}"`);
    expect(sql).toContain('ADD COLUMN "added" INT4');
    expect(sql).not.toMatch(/DROP (?:TABLE|COLUMN)/);
    await services.executor.executePlan(client, plan, true);

    expect(await inspectTablespace("tablespace_move")).toBe(TEST_TABLESPACE);
    expect(
      (await client.query("SELECT * FROM public.tablespace_move")).rows
    ).toEqual([{ id: 1, payload: "preserved", added: null }]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("resets a custom tablespace to the database default", async function () {
    await client.query(`
      CREATE TABLE public.tablespace_reset (id integer, payload text)
      TABLESPACE ${TEST_TABLESPACE};
      INSERT INTO public.tablespace_reset VALUES (1, 'preserved');
    `);
    const schema = `
      CREATE TABLE public.tablespace_reset (id integer, payload text)
      TABLESPACE pg_default;
    `;

    const plan = await planSchema(schema);
    expect(plan.transactional.join("\n")).toContain(
      'SET TABLESPACE "pg_default"'
    );
    await services.executor.executePlan(client, plan, true);

    expect(await inspectTablespace("tablespace_reset")).toBeUndefined();
    expect(
      (await client.query("SELECT * FROM public.tablespace_reset")).rows
    ).toEqual([{ id: 1, payload: "preserved" }]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("canonicalizes an explicit pg_default tablespace", async function () {
    await client.query("CREATE TABLE public.tablespace_default (id integer)");
    const schema = `
      CREATE TABLE public.tablespace_default (id integer)
      TABLESPACE pg_default;
    `;

    const desired = await services.parser.parseSchema(schema);
    expect(desired.tables[0]?.tablespace).toBeUndefined();
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });
});
