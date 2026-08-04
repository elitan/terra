import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { createTestClient, createTestSchemaService } from "./utils";

const MANAGED_SCHEMA = "advanced_drop_contract";
const EXTERNAL_SCHEMA = "advanced_drop_external";
const FOREIGN_SERVER = "terradb_drop_contract_server";

describe("PostgreSQL advanced object drop safety", function () {
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

  test("rolls back partition removal instead of cascading into unmanaged dependents", async function () {
    await client.query(`
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.events (
        id integer,
        bucket integer,
        PRIMARY KEY (id, bucket)
      ) PARTITION BY RANGE (bucket);
      CREATE TABLE ${MANAGED_SCHEMA}.events_0
        PARTITION OF ${MANAGED_SCHEMA}.events
        FOR VALUES FROM (0) TO (10);
      INSERT INTO ${MANAGED_SCHEMA}.events VALUES (1, 1);
      CREATE VIEW ${MANAGED_SCHEMA}.managed_events AS
        SELECT id, bucket FROM ${MANAGED_SCHEMA}.events_0;

      CREATE SCHEMA ${EXTERNAL_SCHEMA};
      CREATE VIEW ${EXTERNAL_SCHEMA}.events AS
        SELECT id, bucket FROM ${MANAGED_SCHEMA}.events_0;
      CREATE TABLE ${EXTERNAL_SCHEMA}.audit_log (
        audit_id integer PRIMARY KEY,
        event_id integer,
        bucket integer,
        FOREIGN KEY (event_id, bucket)
          REFERENCES ${MANAGED_SCHEMA}.events_0(id, bucket)
      );
      INSERT INTO ${EXTERNAL_SCHEMA}.audit_log VALUES (1, 1, 1);
    `);
    const service = createTestSchemaService();
    const desired = `CREATE SCHEMA ${MANAGED_SCHEMA};`;
    const plan = await service.plan(desired, [MANAGED_SCHEMA]);
    const partitionDrops = plan.transactional.filter(isPartitionDrop);
    const managedViewDropIndex = statementIndex(
      plan.transactional,
      `DROP VIEW IF EXISTS "${MANAGED_SCHEMA}"."managed_events";`
    );

    expect(partitionDrops).toEqual([
      `DROP TABLE IF EXISTS "${MANAGED_SCHEMA}"."events_0" RESTRICT;`,
      `DROP TABLE IF EXISTS "${MANAGED_SCHEMA}"."events" RESTRICT;`,
    ]);
    expect(managedViewDropIndex).toBeGreaterThanOrEqual(0);
    expect(managedViewDropIndex).toBeLessThan(
      statementIndex(plan.transactional, `"${MANAGED_SCHEMA}"."events_0" RESTRICT`)
    );
    await expect(
      service.apply(desired, [MANAGED_SCHEMA], true)
    ).rejects.toMatchObject({ code: "MIGRATION_ERROR" });

    expect(await relationExists(client, `${MANAGED_SCHEMA}.events`)).toBe(true);
    expect(await relationExists(client, `${MANAGED_SCHEMA}.events_0`)).toBe(true);
    expect(await relationExists(client, `${MANAGED_SCHEMA}.managed_events`)).toBe(true);
    expect(await relationExists(client, `${EXTERNAL_SCHEMA}.events`)).toBe(true);
    expect(await foreignKeyExists(client, EXTERNAL_SCHEMA, "audit_log")).toBe(true);
    expect(
      (await client.query(`SELECT id, bucket FROM ${MANAGED_SCHEMA}.events`)).rows
    ).toEqual([{ id: 1, bucket: 1 }]);
    expect(
      (await client.query(
        `SELECT audit_id, event_id, bucket FROM ${EXTERNAL_SCHEMA}.audit_log`
      )).rows
    ).toEqual([{ audit_id: 1, event_id: 1, bucket: 1 }]);
  });

  test("removes a managed foreign key before its referenced partitions", async function () {
    await client.query(`
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.events (
        id integer,
        bucket integer,
        PRIMARY KEY (id, bucket)
      ) PARTITION BY RANGE (bucket);
      CREATE TABLE ${MANAGED_SCHEMA}.events_0
        PARTITION OF ${MANAGED_SCHEMA}.events
        FOR VALUES FROM (0) TO (10);
      CREATE TABLE ${MANAGED_SCHEMA}.audit_log (
        audit_id integer PRIMARY KEY,
        event_id integer,
        bucket integer,
        FOREIGN KEY (event_id, bucket)
          REFERENCES ${MANAGED_SCHEMA}.events_0(id, bucket)
      );
      INSERT INTO ${MANAGED_SCHEMA}.events VALUES (1, 1);
      INSERT INTO ${MANAGED_SCHEMA}.audit_log VALUES (1, 1, 1);
    `);
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.audit_log (
        audit_id integer PRIMARY KEY,
        event_id integer,
        bucket integer
      );
    `;
    const plan = await service.plan(desired, [MANAGED_SCHEMA]);
    const foreignKeyDropIndex = statementIndex(
      plan.transactional,
      "DROP CONSTRAINT"
    );
    const firstPartitionDropIndex = plan.transactional.findIndex(isPartitionDrop);

    expect(foreignKeyDropIndex).toBeGreaterThanOrEqual(0);
    expect(firstPartitionDropIndex).toBeGreaterThan(foreignKeyDropIndex);
    expect(plan.transactional.filter(isPartitionDrop)).toEqual([
      `DROP TABLE IF EXISTS "${MANAGED_SCHEMA}"."events_0" RESTRICT;`,
      `DROP TABLE IF EXISTS "${MANAGED_SCHEMA}"."events" RESTRICT;`,
    ]);

    await service.apply(desired, [MANAGED_SCHEMA], true);
    expect(await relationExists(client, `${MANAGED_SCHEMA}.events`)).toBe(false);
    expect(await relationExists(client, `${MANAGED_SCHEMA}.events_0`)).toBe(false);
    expect(await foreignKeyExists(client, MANAGED_SCHEMA, "audit_log")).toBe(false);
    expect(
      (await client.query(
        `SELECT audit_id, event_id, bucket FROM ${MANAGED_SCHEMA}.audit_log`
      )).rows
    ).toEqual([{ audit_id: 1, event_id: 1, bucket: 1 }]);
    expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });

  test("alters a foreign server without dropping an unmanaged user mapping", async function () {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS postgres_fdw;
      CREATE SERVER ${FOREIGN_SERVER}
        FOREIGN DATA WRAPPER postgres_fdw;
      CREATE USER MAPPING FOR CURRENT_USER SERVER ${FOREIGN_SERVER};
      CREATE SCHEMA ${MANAGED_SCHEMA};
    `);
    const service = createTestSchemaService();
    const desired = `
      CREATE EXTENSION postgres_fdw;
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.rollback_guard (id integer);
      CREATE SERVER ${FOREIGN_SERVER}
        FOREIGN DATA WRAPPER postgres_fdw
        OPTIONS (host '127.0.0.1');
    `;
    const plan = await service.plan(desired, [MANAGED_SCHEMA]);
    expect(plan.transactional).toContain(
      `ALTER SERVER "${FOREIGN_SERVER}" OPTIONS (` +
        `ADD "host" '127.0.0.1');`
    );
    expect(plan.transactional.some(isServerDrop)).toBe(false);

    await service.apply(desired, [MANAGED_SCHEMA], true);

    expect(await relationExists(client, `${MANAGED_SCHEMA}.rollback_guard`)).toBe(true);
    expect(await foreignServerExists(client, FOREIGN_SERVER)).toBe(true);
    expect(await userMappingExists(client, FOREIGN_SERVER)).toBe(true);
    expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });
});

function isPartitionDrop(statement: string): boolean {
  return statement.startsWith("DROP TABLE IF EXISTS");
}

function isServerDrop(statement: string): boolean {
  return statement.startsWith("DROP SERVER");
}

function statementIndex(statements: string[], fragment: string): number {
  return statements.findIndex(function includesFragment(statement) {
    return statement.includes(fragment);
  });
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

async function foreignServerExists(client: Client, name: string): Promise<boolean> {
  const result = await client.query(
    "SELECT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = $1) AS exists",
    [name]
  );
  return result.rows[0]?.exists === true;
}

async function userMappingExists(client: Client, server: string): Promise<boolean> {
  const result = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_user_mappings
        WHERE srvname = $1
          AND usename = current_user
      ) AS exists
    `,
    [server]
  );
  return result.rows[0]?.exists === true;
}

async function cleanup(client: Client): Promise<void> {
  await client.query(`DROP SERVER IF EXISTS ${FOREIGN_SERVER} CASCADE`);
  await client.query(`DROP SCHEMA IF EXISTS ${EXTERNAL_SCHEMA} CASCADE`);
  await client.query(`DROP SCHEMA IF EXISTS ${MANAGED_SCHEMA} CASCADE`);
}
