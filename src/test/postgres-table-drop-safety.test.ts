import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { createTestClient, createTestSchemaService } from "./utils";

const MANAGED_SCHEMA = "table_drop_contract";
const EXTERNAL_SCHEMA = "table_drop_external";

describe("PostgreSQL table drop dependency safety", function () {
  let client!: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanup(client);
  });

  afterEach(async function () {
    if (!client) {
      return;
    }
    await cleanup(client);
    await client.end();
  });

  test("rolls back instead of cascading into unmanaged dependents", async function () {
    await client.query(`
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.accounts (
        id integer PRIMARY KEY
      );
      INSERT INTO ${MANAGED_SCHEMA}.accounts VALUES (1);
      CREATE VIEW ${MANAGED_SCHEMA}.account_ids AS
        SELECT id FROM ${MANAGED_SCHEMA}.accounts;

      CREATE SCHEMA ${EXTERNAL_SCHEMA};
      CREATE TABLE ${EXTERNAL_SCHEMA}.audit_log (
        id integer PRIMARY KEY,
        account_id integer NOT NULL
          REFERENCES ${MANAGED_SCHEMA}.accounts(id)
      );
      INSERT INTO ${EXTERNAL_SCHEMA}.audit_log VALUES (1, 1);
      CREATE VIEW ${EXTERNAL_SCHEMA}.account_ids AS
        SELECT id FROM ${MANAGED_SCHEMA}.accounts;
    `);
    const service = createTestSchemaService();
    const desired = `CREATE SCHEMA ${MANAGED_SCHEMA};`;
    const plan = await service.plan(desired, [MANAGED_SCHEMA]);

    expect(plan.transactional.filter(isTableDrop)).toEqual([
      `DROP TABLE "${MANAGED_SCHEMA}"."accounts" RESTRICT;`,
    ]);
    await expect(
      service.apply(desired, [MANAGED_SCHEMA], true)
    ).rejects.toMatchObject({ code: "MIGRATION_ERROR" });

    expect(await relationExists(client, `${MANAGED_SCHEMA}.accounts`)).toBe(true);
    expect(await relationExists(client, `${MANAGED_SCHEMA}.account_ids`)).toBe(true);
    expect(await relationExists(client, `${EXTERNAL_SCHEMA}.account_ids`)).toBe(true);
    expect(await foreignKeyExists(client, EXTERNAL_SCHEMA, "audit_log")).toBe(true);
    const rows = await client.query(
      `SELECT id, account_id FROM ${EXTERNAL_SCHEMA}.audit_log`
    );
    expect(rows.rows).toEqual([{ id: 1, account_id: 1 }]);
  });

  test("drops managed views before their table", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.accounts (
        id integer PRIMARY KEY
      );
      CREATE VIEW ${MANAGED_SCHEMA}.account_ids AS
        SELECT id FROM ${MANAGED_SCHEMA}.accounts;
      CREATE MATERIALIZED VIEW ${MANAGED_SCHEMA}.account_count AS
        SELECT count(*) AS total FROM ${MANAGED_SCHEMA}.accounts;
    `;
    const desired = `CREATE SCHEMA ${MANAGED_SCHEMA};`;

    await service.apply(initial, [MANAGED_SCHEMA], true);
    const plan = await service.plan(desired, [MANAGED_SCHEMA]);
    const tableDropIndex = plan.transactional.findIndex(isTableDrop);
    const viewDropIndexes = plan.transactional
      .map(function mapStatement(statement, index) {
        return /^DROP (?:MATERIALIZED )?VIEW\b/.test(statement) ? index : -1;
      })
      .filter(function isPresent(index) {
        return index >= 0;
      });

    expect(viewDropIndexes).toHaveLength(2);
    expect(tableDropIndex).toBeGreaterThan(Math.max(...viewDropIndexes));
    expect(plan.transactional[tableDropIndex]).toBe(
      `DROP TABLE "${MANAGED_SCHEMA}"."accounts" RESTRICT;`
    );

    await service.apply(desired, [MANAGED_SCHEMA], true);
    expect(await relationExists(client, `${MANAGED_SCHEMA}.accounts`)).toBe(false);
    expect(await relationExists(client, `${MANAGED_SCHEMA}.account_ids`)).toBe(false);
    expect(await relationExists(client, `${MANAGED_SCHEMA}.account_count`)).toBe(false);
    expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });

  test("removes a managed foreign key before its referenced table", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.accounts (
        id integer PRIMARY KEY
      );
      CREATE TABLE ${MANAGED_SCHEMA}.audit_log (
        id integer PRIMARY KEY,
        account_id integer REFERENCES ${MANAGED_SCHEMA}.accounts(id)
      );
    `;
    const desired = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.audit_log (
        id integer PRIMARY KEY,
        account_id integer
      );
    `;

    await service.apply(initial, [MANAGED_SCHEMA], true);
    await client.query(
      `INSERT INTO ${MANAGED_SCHEMA}.accounts VALUES (1)`
    );
    await client.query(
      `INSERT INTO ${MANAGED_SCHEMA}.audit_log VALUES (1, 1)`
    );

    const plan = await service.plan(desired, [MANAGED_SCHEMA]);
    const foreignKeyDropIndex = plan.transactional.findIndex(function isForeignKeyDrop(
      statement
    ) {
      return statement.includes("DROP CONSTRAINT");
    });
    const tableDropIndex = plan.transactional.findIndex(isTableDrop);
    expect(foreignKeyDropIndex).toBeGreaterThanOrEqual(0);
    expect(tableDropIndex).toBeGreaterThan(foreignKeyDropIndex);

    await service.apply(desired, [MANAGED_SCHEMA], true);
    expect(await relationExists(client, `${MANAGED_SCHEMA}.accounts`)).toBe(false);
    expect(await foreignKeyExists(client, MANAGED_SCHEMA, "audit_log")).toBe(false);
    const rows = await client.query(
      `SELECT id, account_id FROM ${MANAGED_SCHEMA}.audit_log`
    );
    expect(rows.rows).toEqual([{ id: 1, account_id: 1 }]);
    expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });
});

function isTableDrop(statement: string): boolean {
  return statement.startsWith("DROP TABLE");
}

async function relationExists(client: Client, name: string): Promise<boolean> {
  const result = await client.query("SELECT to_regclass($1) IS NOT NULL AS exists", [
    name,
  ]);
  return result.rows[0]?.exists === true;
}

async function foreignKeyExists(
  client: Client,
  schema: string,
  table: string
): Promise<boolean> {
  const result = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_class relation ON relation.oid = constraint_record.conrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE constraint_record.contype = 'f'
          AND namespace.nspname = $1
          AND relation.relname = $2
      ) AS exists
    `,
    [schema, table]
  );
  return result.rows[0]?.exists === true;
}

async function cleanup(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${EXTERNAL_SCHEMA} CASCADE`);
  await client.query(`DROP SCHEMA IF EXISTS ${MANAGED_SCHEMA} CASCADE`);
}
