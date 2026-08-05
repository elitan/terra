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
import type { MigrationContext, MigrationPlan } from "../../types/migration";
import { getStatementRisk } from "../../utils/statement-classifier";
import { createColumnTestServices } from "../columns/column-test-utils";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

const TEST_ACCESS_METHOD = "terradb_heap_access_method_test";

describe("PostgreSQL table access methods", function () {
  let client: Client;
  const services = createColumnTestServices();

  beforeAll(async function () {
    const setupClient = await createTestClient();
    try {
      await cleanDatabase(setupClient);
      await setupClient.query(
        `DROP ACCESS METHOD IF EXISTS ${TEST_ACCESS_METHOD}`
      );
      await setupClient.query(`
        CREATE ACCESS METHOD ${TEST_ACCESS_METHOD}
        TYPE TABLE HANDLER heap_tableam_handler
      `);
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
      await cleanupClient.query(
        `DROP ACCESS METHOD IF EXISTS ${TEST_ACCESS_METHOD}`
      );
    } finally {
      await cleanupClient.end();
    }
  });

  async function getMigrationContext(): Promise<MigrationContext> {
    const result = await client.query(`
      SELECT
        current_setting('server_version_num') as postgres_version_num,
        current_setting('default_table_access_method') as default_table_access_method
    `);
    return {
      postgresVersionNum: Number(result.rows[0]?.postgres_version_num),
      defaultTableAccessMethod:
        result.rows[0]?.default_table_access_method || "heap",
    };
  }

  async function planSchema(schema: string): Promise<MigrationPlan> {
    const current = await services.inspector.getCurrentSchema(client);
    const desired = await services.parser.parseSchema(schema);
    return services.differ.generateMigrationPlan(
      desired.tables,
      current,
      await getMigrationContext()
    );
  }

  async function inspectAccessMethod(tableName: string): Promise<string> {
    const tables = await services.inspector.getCurrentSchema(client);
    const table = tables.find(function findTable(candidate) {
      return candidate.name === tableName;
    });
    if (!table?.accessMethod) {
      throw new Error(`Missing access method for table ${tableName}`);
    }
    return table.accessMethod;
  }

  async function getRelationIdentity(tableName: string) {
    const result = await client.query(
      `SELECT oid::integer AS oid, relfilenode::integer AS relfilenode
       FROM pg_class
       WHERE oid = $1::regclass`,
      [`public.${tableName}`]
    );
    return result.rows[0];
  }

  test("parses and quotes a table access method", async function () {
    const desired = await services.parser.parseSchema(`
      CREATE TABLE public.access_method_parser (id integer)
      USING "Terra Heap";
    `);

    expect(desired.tables[0]?.accessMethod).toBe("Terra Heap");
    const plan = services.differ.generateMigrationPlan(desired.tables, []);
    expect(plan.transactional.join("\n")).toContain('USING "Terra Heap"');
  });

  test("creates, inspects, and reapplies a custom access method", async function () {
    const schema = `
      CREATE TABLE public.access_method_create (
        id integer PRIMARY KEY,
        payload text
      ) USING ${TEST_ACCESS_METHOD};
    `;

    await services.executor.executePlan(client, await planSchema(schema), true);

    expect(await inspectAccessMethod("access_method_create")).toBe(
      TEST_ACCESS_METHOD
    );
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("uses the configured default access method when USING is omitted", async function () {
    await client.query(
      `SET default_table_access_method = ${TEST_ACCESS_METHOD}`
    );
    const schema = `
      CREATE TABLE public.access_method_default (id integer, payload text);
    `;

    await services.executor.executePlan(client, await planSchema(schema), true);

    expect(await inspectAccessMethod("access_method_default")).toBe(
      TEST_ACCESS_METHOD
    );
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("changes access method in place on supported versions", async function () {
    const service = createTestSchemaService();
    await client.query(`
      CREATE TABLE public.access_method_change (
        id integer PRIMARY KEY,
        payload text
      );
      INSERT INTO public.access_method_change VALUES (1, 'preserved');
    `);
    const schema = `
      CREATE TABLE public.access_method_change (
        id integer PRIMARY KEY,
        payload text,
        added integer
      ) USING ${TEST_ACCESS_METHOD};
    `;
    const context = await getMigrationContext();
    const originalIdentity = await getRelationIdentity("access_method_change");

    if ((context.postgresVersionNum || 0) < 150000) {
      await expect(service.plan(schema, ["public"])).rejects.toThrow(
        "PostgreSQL 14 cannot change the access method"
      );
      expect(await inspectAccessMethod("access_method_change")).toBe("heap");
      return;
    }

    const plan = await service.plan(schema, ["public"]);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain(`SET ACCESS METHOD "${TEST_ACCESS_METHOD}"`);
    expect(sql).toContain('ADD COLUMN "added" INT4');
    expect(sql).not.toMatch(/DROP (?:TABLE|COLUMN)/);
    expect(plan.transactional).toHaveLength(1);
    expect(getStatementRisk(plan.transactional[0]!, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(schema, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: plan.transactional,
    });
    expect(await inspectAccessMethod("access_method_change")).toBe("heap");
    expect(await getRelationIdentity("access_method_change")).toEqual(
      originalIdentity
    );
    expect(
      (await client.query("SELECT * FROM public.access_method_change")).rows
    ).toEqual([{ id: 1, payload: "preserved" }]);

    await service.apply(schema, ["public"], true);

    expect(await inspectAccessMethod("access_method_change")).toBe(
      TEST_ACCESS_METHOD
    );
    const changedIdentity = await getRelationIdentity("access_method_change");
    expect(changedIdentity.oid).toBe(originalIdentity.oid);
    expect(changedIdentity.relfilenode).not.toBe(
      originalIdentity.relfilenode
    );
    expect(
      (await client.query("SELECT * FROM public.access_method_change")).rows
    ).toEqual([{ id: 1, payload: "preserved", added: null }]);
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);
  });

  test("resets a custom access method to heap on supported versions", async function () {
    const service = createTestSchemaService();
    await client.query(`
      CREATE TABLE public.access_method_reset (id integer, payload text)
      USING ${TEST_ACCESS_METHOD};
      INSERT INTO public.access_method_reset VALUES (1, 'preserved');
    `);
    const schema = `
      CREATE TABLE public.access_method_reset (id integer, payload text);
    `;
    const context = await getMigrationContext();
    const originalIdentity = await getRelationIdentity("access_method_reset");

    if ((context.postgresVersionNum || 0) < 150000) {
      await expect(service.plan(schema, ["public"])).rejects.toThrow(
        "PostgreSQL 14 cannot change the access method"
      );
      expect(await inspectAccessMethod("access_method_reset")).toBe(
        TEST_ACCESS_METHOD
      );
      return;
    }

    const plan = await service.plan(schema, ["public"]);
    expect(plan.transactional.join("\n")).toContain(
      'SET ACCESS METHOD "heap"'
    );
    expect(getStatementRisk(plan.transactional[0]!, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(schema, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: plan.transactional,
    });
    expect(await inspectAccessMethod("access_method_reset")).toBe(
      TEST_ACCESS_METHOD
    );
    expect(await getRelationIdentity("access_method_reset")).toEqual(
      originalIdentity
    );
    expect(
      (await client.query("SELECT * FROM public.access_method_reset")).rows
    ).toEqual([{ id: 1, payload: "preserved" }]);

    await service.apply(schema, ["public"], true);

    expect(await inspectAccessMethod("access_method_reset")).toBe("heap");
    const resetIdentity = await getRelationIdentity("access_method_reset");
    expect(resetIdentity.oid).toBe(originalIdentity.oid);
    expect(resetIdentity.relfilenode).not.toBe(
      originalIdentity.relfilenode
    );
    expect(
      (await client.query("SELECT * FROM public.access_method_reset")).rows
    ).toEqual([{ id: 1, payload: "preserved" }]);
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);
  });
});
