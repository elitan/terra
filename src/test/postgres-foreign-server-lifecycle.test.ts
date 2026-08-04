import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { createTestClient, createTestSchemaService } from "./utils";
import { getStatementRisk } from "../utils/statement-classifier";

const MANAGED_SCHEMA = "foreign_server_contract";
const EXTERNAL_SCHEMA = "foreign_server_external";
const SERVER_NAME = "Remote Server";
const OWNER_ROLE = "TerraDB Foreign Server Owner";
const REMOVAL_GUARD = "foreign_server_removal_guard";

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

  test("creates inspects and repairs explicit ownership without replacing dependents", async function () {
    await client.query(`CREATE ROLE "${OWNER_ROLE}" NOLOGIN`);
    const service = createTestSchemaService();
    const desired = `
      CREATE EXTENSION postgres_fdw;
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE SERVER "${SERVER_NAME}"
        FOREIGN DATA WRAPPER postgres_fdw
        OPTIONS (host 'localhost');
      ALTER SERVER "${SERVER_NAME}" OWNER TO "${OWNER_ROLE}";
      GRANT USAGE ON FOREIGN SERVER "${SERVER_NAME}" TO PUBLIC;
    `;
    const initialPlan = await service.plan(desired, [MANAGED_SCHEMA]);
    const createIndex = initialPlan.transactional.findIndex(isServerCreate);
    const grantIndex = initialPlan.transactional.indexOf(
      `GRANT USAGE ON FOREIGN SERVER "${SERVER_NAME}" TO PUBLIC;`
    );
    const ownerIndex = initialPlan.transactional.indexOf(
      `ALTER SERVER "${SERVER_NAME}" OWNER TO "${OWNER_ROLE}";`
    );

    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(grantIndex).toBeGreaterThan(createIndex);
    expect(ownerIndex).toBeGreaterThan(grantIndex);
    await service.apply(desired, [MANAGED_SCHEMA], true);
    expect(await foreignServerOwner(client)).toBe(OWNER_ROLE);
    expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);

    await client.query(
      `CREATE USER MAPPING FOR CURRENT_USER SERVER "${SERVER_NAME}"`
    );
    await client.query(`
      CREATE SCHEMA ${EXTERNAL_SCHEMA};
      CREATE FOREIGN TABLE ${EXTERNAL_SCHEMA}.remote_rows (id integer)
        SERVER "${SERVER_NAME}"
        OPTIONS (schema_name 'public', table_name 'rows');
      ALTER SERVER "${SERVER_NAME}" OWNER TO CURRENT_USER;
    `);
    const originalOid = await foreignServerOid(client);
    const repairPlan = await service.plan(desired, [MANAGED_SCHEMA]);

    expect(repairPlan.transactional).toContain(
      `ALTER SERVER "${SERVER_NAME}" OWNER TO "${OWNER_ROLE}";`
    );
    expect(repairPlan.transactional.some(isServerCreate)).toBe(false);
    expect(repairPlan.transactional.some(isServerDrop)).toBe(false);

    await service.apply(desired, [MANAGED_SCHEMA], true);
    expect(await foreignServerOid(client)).toBe(originalOid);
    expect(await foreignServerOwner(client)).toBe(OWNER_ROLE);
    expect(await userMappingExists(client)).toBe(true);
    expect(await foreignTableUsesServer(client)).toBe(true);
    expect(await publicHasUsage(client)).toBe(true);
    expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });

  test("removes an explicitly absent server safely and idempotently", async function () {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS postgres_fdw;
      CREATE SERVER "${SERVER_NAME}" FOREIGN DATA WRAPPER postgres_fdw;
    `);
    const service = createTestSchemaService();
    const desired = `
      CREATE EXTENSION postgres_fdw;
      CREATE SCHEMA ${MANAGED_SCHEMA};
      DROP SERVER IF EXISTS "${SERVER_NAME}" RESTRICT;
    `;
    const plan = await service.plan(desired, [MANAGED_SCHEMA]);
    const dropStatement = `DROP SERVER IF EXISTS "${SERVER_NAME}" RESTRICT;`;

    expect(plan.transactional).toContain(dropStatement);
    expect(getStatementRisk(dropStatement, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(
        desired,
        [MANAGED_SCHEMA],
        true,
        undefined,
        true,
        true
      )
    ).rejects.toThrow(/strict mode blocked/i);
    expect(await foreignServerExists(client)).toBe(true);

    await service.apply(desired, [MANAGED_SCHEMA], true);
    expect(await foreignServerExists(client)).toBe(false);
    expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });

  test("rolls back restricted removal without deleting unmanaged dependents", async function () {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS postgres_fdw;
      CREATE SERVER "${SERVER_NAME}" FOREIGN DATA WRAPPER postgres_fdw;
      CREATE USER MAPPING FOR CURRENT_USER SERVER "${SERVER_NAME}";
      CREATE SCHEMA ${EXTERNAL_SCHEMA};
      CREATE FOREIGN TABLE ${EXTERNAL_SCHEMA}.remote_rows (id integer)
        SERVER "${SERVER_NAME}"
        OPTIONS (schema_name 'public', table_name 'rows');
    `);
    const service = createTestSchemaService();
    const desired = `
      CREATE EXTENSION postgres_fdw;
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.${REMOVAL_GUARD} (id integer);
      DROP SERVER "${SERVER_NAME}";
    `;

    await expect(
      service.apply(desired, [MANAGED_SCHEMA], true)
    ).rejects.toMatchObject({ code: "MIGRATION_ERROR" });

    expect(
      await relationExists(client, `${MANAGED_SCHEMA}.${REMOVAL_GUARD}`)
    ).toBe(false);
    expect(await foreignServerExists(client)).toBe(true);
    expect(await userMappingExists(client)).toBe(true);
    expect(await foreignTableUsesServer(client)).toBe(true);
  });

  test("rejects cascading removal before preceding mutations", async function () {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS postgres_fdw;
      CREATE SERVER "${SERVER_NAME}" FOREIGN DATA WRAPPER postgres_fdw;
      CREATE USER MAPPING FOR CURRENT_USER SERVER "${SERVER_NAME}";
    `);
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.${REMOVAL_GUARD} (id integer);
      DROP SERVER "${SERVER_NAME}" CASCADE;
    `;

    await expect(
      service.apply(desired, [MANAGED_SCHEMA], true)
    ).rejects.toMatchObject({ code: "PARSER_ERROR" });

    expect(
      await relationExists(client, `${MANAGED_SCHEMA}.${REMOVAL_GUARD}`)
    ).toBe(false);
    expect(await foreignServerExists(client)).toBe(true);
    expect(await userMappingExists(client)).toBe(true);
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

async function foreignServerOid(client: Client): Promise<number | undefined> {
  const result = await client.query(
    "SELECT oid::integer FROM pg_foreign_server WHERE srvname = $1",
    [SERVER_NAME]
  );
  return result.rows[0]?.oid;
}

async function foreignServerExists(client: Client): Promise<boolean> {
  return (await foreignServerOid(client)) !== undefined;
}

async function relationExists(
  client: Client,
  relation: string
): Promise<boolean> {
  const result = await client.query(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [relation]
  );
  return result.rows[0]?.exists === true;
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

async function foreignServerOwner(client: Client): Promise<string | null> {
  const result = await client.query(
    `
      SELECT pg_get_userbyid(srvowner) AS owner
      FROM pg_foreign_server
      WHERE srvname = $1
    `,
    [SERVER_NAME]
  );
  return result.rows[0]?.owner || null;
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
  await client.query(`DROP ROLE IF EXISTS "${OWNER_ROLE}"`);
}
