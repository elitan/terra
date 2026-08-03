import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { ParserError } from "../../types/errors";
import { createColumnTestServices } from "../columns/column-test-utils";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

describe("PostgreSQL index schema scope", function () {
  let client: Client;
  const services = createColumnTestServices();
  const managedSchemas = ["tenant_a", "tenant_b"];

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client, managedSchemas);
    await client.query("CREATE SCHEMA tenant_a; CREATE SCHEMA tenant_b;");
  });

  afterEach(async function () {
    await cleanDatabase(client, managedSchemas);
    await client.end();
  });

  async function planSchema(schema: string): Promise<MigrationPlan> {
    const current = await services.inspector.getCurrentSchema(
      client,
      managedSchemas
    );
    const desired = await services.parser.parseSchema(schema);
    return services.differ.generateMigrationPlan(desired.tables, current);
  }

  function allStatements(plan: MigrationPlan): string[] {
    return [...plan.transactional, ...plan.concurrent];
  }

  test("associates same-name tables and indexes by schema", async function () {
    const parsed = await services.parser.parseSchema(`
      CREATE SCHEMA tenant_a;
      CREATE SCHEMA tenant_b;
      CREATE TABLE tenant_a.accounts (
        id integer NOT NULL,
        label text
      );
      CREATE TABLE tenant_b.accounts (
        id integer NOT NULL,
        label text
      );
      CREATE INDEX accounts_label_idx
        ON tenant_a.accounts (label COLLATE "C");
      CREATE INDEX accounts_label_idx
        ON tenant_b.accounts (id DESC);
    `);

    const tenantA = parsed.tables.find(function findTable(table) {
      return table.schema === "tenant_a" && table.name === "accounts";
    });
    const tenantB = parsed.tables.find(function findTable(table) {
      return table.schema === "tenant_b" && table.name === "accounts";
    });
    expect(tenantA?.indexes).toEqual([
      expect.objectContaining({
        name: "accounts_label_idx",
        schema: "tenant_a",
        columns: ["label"],
        collations: [{ name: "C" }],
      }),
    ]);
    expect(tenantB?.indexes).toEqual([
      expect.objectContaining({
        name: "accounts_label_idx",
        schema: "tenant_b",
        columns: ["id"],
        sortOrders: ["DESC"],
      }),
    ]);
  });

  test("creates, changes, and removes only the qualified index target", async function () {
    const baseSchema = `
      CREATE TABLE tenant_a.accounts (
        id integer NOT NULL,
        label text
      );
      CREATE TABLE tenant_b.accounts (
        id integer NOT NULL,
        label text
      );
      CREATE INDEX accounts_label_idx
        ON tenant_a.accounts (label COLLATE "C");
      CREATE INDEX accounts_label_idx
        ON tenant_b.accounts (id DESC);
    `;
    await services.executor.executePlan(client, await planSchema(baseSchema), true);
    await client.query(`
      INSERT INTO tenant_a.accounts VALUES (1, 'tenant a');
      INSERT INTO tenant_b.accounts VALUES (2, 'tenant b');
    `);
    expect((await planSchema(baseSchema)).hasChanges).toBe(false);

    const changedSchema = baseSchema.replace(
      'label COLLATE "C"',
      'label COLLATE "POSIX"'
    );
    const changePlan = await planSchema(changedSchema);
    expect(allStatements(changePlan)).toEqual([
      'DROP INDEX "tenant_a"."accounts_label_idx";',
      'CREATE INDEX "accounts_label_idx" ON "tenant_a"."accounts" ("label" COLLATE "POSIX");',
    ]);
    await services.executor.executePlan(client, changePlan, true);
    expect((await planSchema(changedSchema)).hasChanges).toBe(false);

    const withoutTenantAIndex = changedSchema.replace(
      /\s*CREATE INDEX accounts_label_idx\s+ON tenant_a\.accounts \(label COLLATE "POSIX"\);/,
      ""
    );
    const removePlan = await planSchema(withoutTenantAIndex);
    expect(allStatements(removePlan)).toEqual([
      'DROP INDEX CONCURRENTLY "tenant_a"."accounts_label_idx";',
    ]);
    await services.executor.executePlan(client, removePlan, true);
    expect((await planSchema(withoutTenantAIndex)).hasChanges).toBe(false);

    const objects = await client.query(`
      SELECT schemaname, indexname
      FROM pg_indexes
      WHERE tablename = 'accounts'
      ORDER BY schemaname, indexname
    `);
    expect(objects.rows).toEqual([
      { schemaname: "tenant_b", indexname: "accounts_label_idx" },
    ]);
    const rows = await client.query(`
      SELECT 'tenant_a' AS tenant, id, label FROM tenant_a.accounts
      UNION ALL
      SELECT 'tenant_b' AS tenant, id, label FROM tenant_b.accounts
      ORDER BY tenant
    `);
    expect(rows.rows).toEqual([
      { tenant: "tenant_a", id: 1, label: "tenant a" },
      { tenant: "tenant_b", id: 2, label: "tenant b" },
    ]);
  });

  test("rejects an index whose target table is absent from the desired schema", async function () {
    const schema = `
      CREATE TABLE public.safe_table (id integer NOT NULL);
      CREATE INDEX orphaned_index ON tenant_a.external_table (id);
    `;

    let error: unknown;
    try {
      await createTestSchemaService().apply(
        schema,
        ["public", "tenant_a"],
        true
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ParserError);
    expect((error as ParserError).code).toBe("PARSER_ERROR");
    expect((error as Error).message).toContain(
      "Index orphaned_index targets tenant_a.external_table"
    );
    expect((error as Error).message).toContain(
      "define the table in the desired schema"
    );

    const safeTable = await client.query(
      "SELECT to_regclass('public.safe_table') AS relation"
    );
    expect(safeTable.rows[0]?.relation).toBeNull();
  });

  test("requires qualification instead of guessing a non-public search path", async function () {
    await expect(
      services.parser.parseSchema(`
        CREATE TABLE tenant_a.accounts (id integer NOT NULL);
        CREATE INDEX accounts_id_idx ON accounts (id);
      `)
    ).rejects.toThrow("Index accounts_id_idx targets public.accounts");
  });
});
