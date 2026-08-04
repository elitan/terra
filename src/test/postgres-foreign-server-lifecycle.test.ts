import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { createTestClient, createTestSchemaService } from "./utils";

const MANAGED_SCHEMA = "foreign_server_contract";
const EXTERNAL_SCHEMA = "foreign_server_external";
const SERVER_NAME = "Remote Server";

describe("PostgreSQL foreign server lifecycle", function () {
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

  test("alters version and options natively without losing dependents or grants", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE EXTENSION postgres_fdw;
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE SERVER IF NOT EXISTS "${SERVER_NAME}"
        TYPE 'postgresql'
        VERSION '14'
        FOREIGN DATA WRAPPER postgres_fdw
        OPTIONS (port '5432', host 'localhost', dbname 'source');
      GRANT USAGE ON FOREIGN SERVER "${SERVER_NAME}" TO PUBLIC;
    `;
    const initialPlan = await service.plan(initial, [MANAGED_SCHEMA]);
    const createStatement = initialPlan.transactional.find(isServerCreate);

    expect(createStatement).toBe(
      `CREATE SERVER "${SERVER_NAME}" TYPE 'postgresql' VERSION '14' ` +
        `FOREIGN DATA WRAPPER "postgres_fdw" OPTIONS (` +
        `"dbname" 'source', "host" 'localhost', "port" '5432');`
    );
    expect(createStatement).not.toContain("IF NOT EXISTS");

    await service.apply(initial, [MANAGED_SCHEMA], true);
    await client.query(
      `CREATE USER MAPPING FOR CURRENT_USER SERVER "${SERVER_NAME}"`
    );
    await client.query(`
      CREATE SCHEMA ${EXTERNAL_SCHEMA};
      CREATE FOREIGN TABLE ${EXTERNAL_SCHEMA}.remote_rows (id integer)
        SERVER "${SERVER_NAME}"
        OPTIONS (schema_name 'public', table_name 'rows');
    `);
    const originalOid = await foreignServerOid(client);

    const changed = `
      CREATE EXTENSION postgres_fdw;
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE SERVER "${SERVER_NAME}"
        TYPE 'postgresql'
        VERSION '15'
        FOREIGN DATA WRAPPER postgres_fdw
        OPTIONS (
          fetch_size '1000',
          port '5432',
          host 'db.internal'
        );
      GRANT USAGE ON FOREIGN SERVER "${SERVER_NAME}" TO PUBLIC;
    `;
    const changedPlan = await service.plan(changed, [MANAGED_SCHEMA]);

    expect(changedPlan.transactional).toContain(
      `ALTER SERVER "${SERVER_NAME}" VERSION '15' OPTIONS (` +
        `DROP "dbname", SET "host" 'db.internal', ADD "fetch_size" '1000');`
    );
    expect(changedPlan.transactional.some(isServerDrop)).toBe(false);
    expect(changedPlan.transactional.some(isServerCreate)).toBe(false);

    await service.apply(changed, [MANAGED_SCHEMA], true);
    expect(await foreignServerOid(client)).toBe(originalOid);
    expect(await userMappingExists(client)).toBe(true);
    expect(await foreignTableUsesServer(client)).toBe(true);
    expect(await publicHasUsage(client)).toBe(true);
    expect(await inspectForeignServer(client)).toEqual({
      type: "postgresql",
      version: "15",
      options: {
        fetch_size: "1000",
        host: "db.internal",
        port: "5432",
      },
    });
    expect((await service.plan(changed, [MANAGED_SCHEMA])).hasChanges).toBe(false);

    const cleared = `
      CREATE EXTENSION postgres_fdw;
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE SERVER "${SERVER_NAME}"
        TYPE 'postgresql'
        FOREIGN DATA WRAPPER postgres_fdw
        OPTIONS (port '5432', host 'db.internal');
      GRANT USAGE ON FOREIGN SERVER "${SERVER_NAME}" TO PUBLIC;
    `;
    const clearedPlan = await service.plan(cleared, [MANAGED_SCHEMA]);

    expect(clearedPlan.transactional).toContain(
      `ALTER SERVER "${SERVER_NAME}" VERSION NULL OPTIONS (` +
        `DROP "fetch_size");`
    );
    await service.apply(cleared, [MANAGED_SCHEMA], true);
    expect(await foreignServerOid(client)).toBe(originalOid);
    expect(await userMappingExists(client)).toBe(true);
    expect(await foreignTableUsesServer(client)).toBe(true);
    expect(await publicHasUsage(client)).toBe(true);
    expect(await inspectForeignServer(client)).toEqual({
      type: "postgresql",
      version: null,
      options: {
        host: "db.internal",
        port: "5432",
      },
    });
    expect((await service.plan(cleared, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });

  test("rejects immutable type and foreign-data-wrapper changes before mutation", async function () {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS postgres_fdw;
      CREATE EXTENSION IF NOT EXISTS file_fdw;
      CREATE SERVER "${SERVER_NAME}"
        TYPE 'postgresql'
        VERSION '14'
        FOREIGN DATA WRAPPER postgres_fdw
        OPTIONS (host 'localhost');
      CREATE USER MAPPING FOR CURRENT_USER SERVER "${SERVER_NAME}";
      CREATE SCHEMA ${MANAGED_SCHEMA};
    `);
    const service = createTestSchemaService();
    const typeChange = desiredServer("mysql", "postgres_fdw");
    const wrapperChange = desiredServer("postgresql", "file_fdw");

    await expect(
      service.plan(typeChange, [MANAGED_SCHEMA])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("server type"),
    });
    await expect(
      service.plan(wrapperChange, [MANAGED_SCHEMA])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("foreign-data wrapper"),
    });

    expect(await userMappingExists(client)).toBe(true);
    expect(await inspectForeignServer(client)).toEqual({
      type: "postgresql",
      version: "14",
      options: { host: "localhost" },
    });
  });
});

function desiredServer(type: string, wrapper: string): string {
  return `
    CREATE EXTENSION postgres_fdw;
    CREATE EXTENSION file_fdw;
    CREATE SCHEMA ${MANAGED_SCHEMA};
    CREATE SERVER "${SERVER_NAME}"
      TYPE '${type}'
      VERSION '14'
      FOREIGN DATA WRAPPER ${wrapper}
      OPTIONS (host 'localhost');
  `;
}

function isServerCreate(statement: string): boolean {
  return statement.startsWith("CREATE SERVER");
}

function isServerDrop(statement: string): boolean {
  return statement.startsWith("DROP SERVER");
}

async function foreignServerOid(client: Client): Promise<number> {
  const result = await client.query(
    "SELECT oid::integer FROM pg_foreign_server WHERE srvname = $1",
    [SERVER_NAME]
  );
  return result.rows[0]?.oid;
}

async function inspectForeignServer(client: Client): Promise<{
  type: string | null;
  version: string | null;
  options: Record<string, string>;
}> {
  const result = await client.query(
    `
      SELECT
        server.srvtype AS type,
        server.srvversion AS version,
        COALESCE(
          jsonb_object_agg(
            split_part(option_value, '=', 1),
            substring(option_value FROM position('=' IN option_value) + 1)
          ) FILTER (WHERE option_value IS NOT NULL),
          '{}'::jsonb
        ) AS options
      FROM pg_foreign_server server
      LEFT JOIN LATERAL unnest(server.srvoptions) option_value ON true
      WHERE server.srvname = $1
      GROUP BY server.oid
    `,
    [SERVER_NAME]
  );
  return result.rows[0];
}

async function userMappingExists(client: Client): Promise<boolean> {
  const result = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_user_mappings
        WHERE srvname = $1
          AND usename = current_user
      ) AS exists
    `,
    [SERVER_NAME]
  );
  return result.rows[0]?.exists === true;
}

async function foreignTableUsesServer(client: Client): Promise<boolean> {
  const result = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_foreign_table foreign_table
        JOIN pg_class relation ON relation.oid = foreign_table.ftrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_foreign_server server ON server.oid = foreign_table.ftserver
        WHERE namespace.nspname = $1
          AND relation.relname = 'remote_rows'
          AND server.srvname = $2
      ) AS exists
    `,
    [EXTERNAL_SCHEMA, SERVER_NAME]
  );
  return result.rows[0]?.exists === true;
}

async function publicHasUsage(client: Client): Promise<boolean> {
  const result = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_foreign_server server
        CROSS JOIN LATERAL aclexplode(server.srvacl) privilege
        WHERE server.srvname = $1
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'USAGE'
      ) AS allowed
    `,
    [SERVER_NAME]
  );
  return result.rows[0]?.allowed === true;
}

async function cleanup(client: Client): Promise<void> {
  await client.query(`DROP SERVER IF EXISTS "${SERVER_NAME}" CASCADE`);
  await client.query(`DROP SCHEMA IF EXISTS ${EXTERNAL_SCHEMA} CASCADE`);
  await client.query(`DROP SCHEMA IF EXISTS ${MANAGED_SCHEMA} CASCADE`);
}
