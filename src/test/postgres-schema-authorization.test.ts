import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { SchemaParser } from "../core/schema/parser";
import { getStatementRisk } from "../utils/statement-classifier";
import { createTestClient, createTestSchemaService } from "./utils";

const ROLE_NAME = "TerraDB Schema Contract Owner";
const GUARD_TABLE = "terradb_schema_contract_guard";

describe("PostgreSQL CREATE SCHEMA parser fidelity", function () {
  test("preserves concrete authorization and implicit schema names", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE SCHEMA "Application Data" AUTHORIZATION "Application Owner";
      CREATE SCHEMA AUTHORIZATION "Implicit Schema Owner";
      CREATE SCHEMA IF NOT EXISTS normalized AUTHORIZATION normalized_owner;
    `);

    expect(parsed.schemas).toEqual([
      { name: "Application Data", owner: "Application Owner" },
      { name: "Implicit Schema Owner", owner: "Implicit Schema Owner" },
      { name: "normalized", owner: "normalized_owner" },
    ]);
  });

  test("rejects contextual owners inline elements and duplicate schemas", async function () {
    const cases = [
      "CREATE SCHEMA app AUTHORIZATION CURRENT_ROLE;",
      "CREATE SCHEMA app AUTHORIZATION CURRENT_USER;",
      "CREATE SCHEMA app AUTHORIZATION SESSION_USER;",
      "CREATE SCHEMA app CREATE TABLE events (id integer);",
      "CREATE SCHEMA app; CREATE SCHEMA app AUTHORIZATION app_owner;",
    ];

    for (const sql of cases) {
      await expect(
        new SchemaParser().parseSchema(sql, "schema.sql")
      ).rejects.toMatchObject({
        code: "PARSER_ERROR",
        filePath: "schema.sql",
      });
    }
  });
});

describe("PostgreSQL schema authorization lifecycle", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanup(client);
  });

  afterEach(async function () {
    await cleanup(client);
    await client.end();
  });

  test("creates inspects and repairs an explicitly owned implicit-name schema", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE ROLE "${ROLE_NAME}" NOLOGIN;
      CREATE SCHEMA AUTHORIZATION "${ROLE_NAME}";
      CREATE TABLE "${ROLE_NAME}".ownership_guard (
        id integer PRIMARY KEY,
        payload text NOT NULL
      );
    `;

    await service.apply(desired, [ROLE_NAME], true);
    await client.query(
      `INSERT INTO "${ROLE_NAME}".ownership_guard VALUES (1, 'preserved')`
    );
    const originalSchemaOid = await schemaOid(client, ROLE_NAME);
    expect(await schemaOwner(client, ROLE_NAME)).toBe(ROLE_NAME);

    const unchanged = await service.plan(desired, [ROLE_NAME]);
    expect(unchanged.hasChanges).toBe(false);

    await client.query(
      `ALTER SCHEMA ${client.escapeIdentifier(ROLE_NAME)} OWNER TO CURRENT_USER`
    );
    const repair = await service.plan(desired, [ROLE_NAME]);
    const ownerStatement =
      `ALTER SCHEMA ${client.escapeIdentifier(ROLE_NAME)} OWNER TO ` +
      `${client.escapeIdentifier(ROLE_NAME)};`;
    expect(repair.transactional).toContain(ownerStatement);
    expect(getStatementRisk(ownerStatement, "transactional")).toBe(
      "destructive"
    );
    const previousOwner = await currentUser(client);
    await expect(
      service.apply(
        desired,
        [ROLE_NAME],
        true,
        undefined,
        false,
        true
      )
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: expect.arrayContaining([ownerStatement]),
    });
    expect(await schemaOwner(client, ROLE_NAME)).toBe(previousOwner);
    expect(await schemaOid(client, ROLE_NAME)).toBe(originalSchemaOid);
    expect(
      (
        await client.query(
          `SELECT * FROM "${ROLE_NAME}".ownership_guard`
        )
      ).rows
    ).toEqual([{ id: 1, payload: "preserved" }]);

    await service.apply(desired, [ROLE_NAME], true);
    expect(await schemaOwner(client, ROLE_NAME)).toBe(ROLE_NAME);
    expect(await schemaOid(client, ROLE_NAME)).toBe(originalSchemaOid);
    expect(
      (
        await client.query(
          `SELECT * FROM "${ROLE_NAME}".ownership_guard`
        )
      ).rows
    ).toEqual([{ id: 1, payload: "preserved" }]);
    expect((await service.plan(desired, [ROLE_NAME])).hasChanges).toBe(false);
  });

  test("rejects inline schema elements before preceding mutations", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE TABLE public.${GUARD_TABLE} (id integer);
      CREATE SCHEMA inline_contract
        CREATE TABLE events (id integer);
    `;

    await expect(
      service.apply(desired, ["public", "inline_contract"], true)
    ).rejects.toMatchObject({ code: "PARSER_ERROR" });

    const result = await client.query(
      "SELECT to_regclass($1) AS relation",
      [`public.${GUARD_TABLE}`]
    );
    expect(result.rows[0]?.relation).toBeNull();
  });
});

async function schemaOwner(client: Client, schema: string): Promise<string | null> {
  const result = await client.query(
    `
      SELECT pg_get_userbyid(nspowner) AS owner
      FROM pg_namespace
      WHERE nspname = $1
    `,
    [schema]
  );
  return result.rows[0]?.owner || null;
}

async function schemaOid(client: Client, schema: string): Promise<number> {
  const result = await client.query(
    "SELECT oid::integer FROM pg_namespace WHERE nspname = $1",
    [schema]
  );
  return result.rows[0]?.oid;
}

async function currentUser(client: Client): Promise<string> {
  const result = await client.query("SELECT current_user AS name");
  return result.rows[0]?.name;
}

async function cleanup(client: Client): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS public.${GUARD_TABLE}`);
  await client.query("DROP SCHEMA IF EXISTS inline_contract CASCADE");
  await client.query(`DROP SCHEMA IF EXISTS ${client.escapeIdentifier(ROLE_NAME)} CASCADE`);
  await client.query(`DROP ROLE IF EXISTS ${client.escapeIdentifier(ROLE_NAME)}`);
}
