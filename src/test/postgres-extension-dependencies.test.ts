import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { SchemaParser } from "../core/schema/parser";
import { createTestClient, createTestSchemaService } from "./utils";

const MANAGED_SCHEMA = "extension_contract";
const EXTERNAL_SCHEMA = "extension_external";

describe("PostgreSQL extension parser fidelity", function () {
  test("preserves install options and rejects ambiguous declarations", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE EXTENSION IF NOT EXISTS earthdistance
        WITH SCHEMA extension_contract VERSION '1.2' CASCADE;
    `);
    expect(parsed.extensions).toEqual([
      {
        name: "earthdistance",
        schema: "extension_contract",
        version: "1.2",
        cascade: true,
      },
    ]);

    for (const sql of [
      "CREATE EXTENSION hstore SCHEMA first_schema SCHEMA second_schema;",
      "CREATE EXTENSION hstore; CREATE EXTENSION hstore CASCADE;",
    ]) {
      await expect(
        new SchemaParser().parseSchema(sql, "extensions.sql")
      ).rejects.toMatchObject({
        code: "PARSER_ERROR",
        filePath: "extensions.sql",
      });
    }
  });
});

describe("PostgreSQL extension dependency safety", function () {
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

  test("retains cascade-installed requirements and drops dependents first", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE EXTENSION earthdistance WITH SCHEMA ${MANAGED_SCHEMA} CASCADE;
    `;

    await service.apply(desired, [MANAGED_SCHEMA], true);
    expect(await installedExtensions(client, ["cube", "earthdistance"])).toEqual([
      { name: "cube", schema: MANAGED_SCHEMA },
      { name: "earthdistance", schema: MANAGED_SCHEMA },
    ]);
    expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);

    const withoutExtensions = `CREATE SCHEMA ${MANAGED_SCHEMA};`;
    const removal = await service.plan(withoutExtensions, [MANAGED_SCHEMA]);
    expect(removal.transactional.filter(isExtensionDrop)).toEqual([
      'DROP EXTENSION "earthdistance" RESTRICT;',
      'DROP EXTENSION "cube" RESTRICT;',
    ]);

    await service.apply(withoutExtensions, [MANAGED_SCHEMA], true);
    expect(await installedExtensions(client, ["cube", "earthdistance"])).toEqual([]);
    expect((await service.plan(withoutExtensions, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });

  test("rolls back removal when an unmanaged object depends on the extension", async function () {
    await client.query(`
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE SCHEMA ${EXTERNAL_SCHEMA};
      CREATE EXTENSION pgcrypto WITH SCHEMA ${MANAGED_SCHEMA};
      CREATE VIEW ${EXTERNAL_SCHEMA}.secret_hash AS
        SELECT ${MANAGED_SCHEMA}.digest('secret'::text, 'sha256'::text) AS value;
    `);
    const service = createTestSchemaService();
    const desired = `CREATE SCHEMA ${MANAGED_SCHEMA};`;
    const plan = await service.plan(desired, [MANAGED_SCHEMA]);

    expect(plan.transactional.filter(isExtensionDrop)).toEqual([
      'DROP EXTENSION "pgcrypto" RESTRICT;',
    ]);
    await expect(
      service.apply(desired, [MANAGED_SCHEMA], true)
    ).rejects.toMatchObject({ code: "MIGRATION_ERROR" });

    expect(await installedExtensions(client, ["pgcrypto"])).toEqual([
      { name: "pgcrypto", schema: MANAGED_SCHEMA },
    ]);
    const view = await client.query(
      "SELECT to_regclass($1) AS relation",
      [`${EXTERNAL_SCHEMA}.secret_hash`]
    );
    expect(view.rows[0]?.relation).toBe(`${EXTERNAL_SCHEMA}.secret_hash`);
  });

  test("relocates a desired global extension without touching unmanaged peers", async function () {
    await client.query(`
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE SCHEMA ${EXTERNAL_SCHEMA};
      CREATE EXTENSION hstore WITH SCHEMA ${EXTERNAL_SCHEMA};
      CREATE EXTENSION pgcrypto WITH SCHEMA ${EXTERNAL_SCHEMA};
    `);
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE EXTENSION hstore WITH SCHEMA ${MANAGED_SCHEMA};
    `;

    const plan = await service.plan(desired, [MANAGED_SCHEMA]);
    expect(plan.transactional).toContain(
      `ALTER EXTENSION "hstore" SET SCHEMA "${MANAGED_SCHEMA}";`
    );
    expect(plan.transactional.some(function dropsPgcrypto(statement) {
      return statement.includes('DROP EXTENSION "pgcrypto"');
    })).toBe(false);

    await service.apply(desired, [MANAGED_SCHEMA], true);
    expect(await installedExtensions(client, ["hstore", "pgcrypto"])).toEqual([
      { name: "hstore", schema: MANAGED_SCHEMA },
      { name: "pgcrypto", schema: EXTERNAL_SCHEMA },
    ]);
    expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });
});

function isExtensionDrop(statement: string): boolean {
  return statement.startsWith("DROP EXTENSION");
}

async function installedExtensions(
  client: Client,
  names: string[]
): Promise<Array<{ name: string; schema: string }>> {
  const result = await client.query(
    `
      SELECT e.extname AS name, n.nspname AS schema
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = ANY($1::text[])
      ORDER BY e.extname
    `,
    [names]
  );
  return result.rows;
}

async function cleanup(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${EXTERNAL_SCHEMA} CASCADE`);
  for (const extension of ["earthdistance", "cube", "hstore", "pgcrypto"]) {
    await client.query(`DROP EXTENSION IF EXISTS ${extension} CASCADE`);
  }
  await client.query(`DROP SCHEMA IF EXISTS ${MANAGED_SCHEMA} CASCADE`);
}
