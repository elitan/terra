import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { getStatementRisk } from "../utils/statement-classifier";
import { createTestClient, createTestSchemaService } from "./utils";

const MANAGED_SCHEMA = "default_privilege_contract";
const FUTURE_SCHEMA = "default_privilege_future";
const BLOCKER_SCHEMA = "default_privilege_blocker";
const OWNER_ROLE = "default_privilege_owner";
const READER_ROLE = "default_privilege_reader";
const MARKER_ROLE = "default_privilege_marker";
const BLOCKER_ROLE = "default_privilege_blocker";

describe("PostgreSQL default privilege lifecycle", function () {
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

  test("manages future-object defaults, drift, options, and omission", async function () {
    await createExistingObjectBeforeDefaults(client);
    const service = createTestSchemaService();
    const grantable = desiredDefaultPrivileges(true);

    const initialPlan = await service.plan(grantable, [MANAGED_SCHEMA]);
    expect(initialPlan.transactional).toContain(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER_ROLE}" ` +
        `GRANT SELECT ON TABLES TO "${READER_ROLE}";`
    );
    expect(initialPlan.transactional).toContain(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER_ROLE}" ` +
        `IN SCHEMA "${MANAGED_SCHEMA}" GRANT INSERT ON TABLES ` +
        `TO "${READER_ROLE}" WITH GRANT OPTION;`
    );

    await service.apply(grantable, [MANAGED_SCHEMA], true);
    expect(
      await relationPrivilege(client, "existing_table", "SELECT")
    ).toEqual({ granted: false, grantable: false });

    await createFutureObjects(client, "managed");
    await createFutureSchema(client);
    expect(await managedFuturePrivilegeState(client)).toEqual({
      tableSelect: { granted: true, grantable: false },
      tableInsert: { granted: true, grantable: true },
      sequenceUsage: { granted: true, grantable: false },
      routineReaderExecute: { granted: true, grantable: false },
      routinePublicExecute: { granted: false, grantable: false },
      typeUsage: { granted: true, grantable: false },
      schemaUsage: { granted: true, grantable: false },
    });
    await dropFutureObjects(client, "managed");
    await client.query(`DROP SCHEMA ${FUTURE_SCHEMA}`);
    const serverVersion = await getServerVersion(client);
    if (serverVersion >= 170000) {
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} ` +
          `GRANT MAINTAIN ON TABLES TO ${READER_ROLE}`
      );
    }
    if (serverVersion >= 180000) {
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} ` +
          `GRANT SELECT ON LARGE OBJECTS TO ${READER_ROLE}`
      );
    }
    expect((await service.plan(grantable, [MANAGED_SCHEMA])).hasChanges).toBe(
      false
    );

    await client.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
        REVOKE SELECT ON TABLES FROM ${READER_ROLE};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
        IN SCHEMA ${MANAGED_SCHEMA}
        REVOKE GRANT OPTION FOR INSERT ON TABLES FROM ${READER_ROLE};
    `);
    const repairPlan = await service.plan(grantable, [MANAGED_SCHEMA]);
    expect(repairPlan.transactional).toContain(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER_ROLE}" ` +
        `GRANT SELECT ON TABLES TO "${READER_ROLE}";`
    );
    expect(repairPlan.transactional).toContain(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER_ROLE}" ` +
        `IN SCHEMA "${MANAGED_SCHEMA}" GRANT INSERT ON TABLES ` +
        `TO "${READER_ROLE}" WITH GRANT OPTION;`
    );
    await service.apply(grantable, [MANAGED_SCHEMA], true);

    const plain = desiredDefaultPrivileges(false);
    const downgrade = await service.plan(plain, [MANAGED_SCHEMA]);
    const revokeOption =
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER_ROLE}" ` +
      `IN SCHEMA "${MANAGED_SCHEMA}" REVOKE GRANT OPTION FOR INSERT ` +
      `ON TABLES FROM "${READER_ROLE}" RESTRICT;`;
    expect(downgrade.transactional).toContain(revokeOption);
    expect(getStatementRisk(revokeOption, "transactional")).toBe(
      "destructive"
    );
    await service.apply(plain, [MANAGED_SCHEMA], true);
    await createFutureObjects(client, "plain");
    expect(await relationPrivilege(client, "plain_table", "INSERT")).toEqual({
      granted: true,
      grantable: false,
    });
    await dropFutureObjects(client, "plain");

    const omitted = baseDesiredSchema();
    const removalPlan = await service.plan(omitted, [MANAGED_SCHEMA]);
    const readerRevoke =
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER_ROLE}" ` +
      `REVOKE SELECT ON TABLES FROM "${READER_ROLE}" RESTRICT;`;
    expect(removalPlan.transactional).toContain(readerRevoke);
    expect(getStatementRisk(readerRevoke, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(omitted, [MANAGED_SCHEMA], true, undefined, true, true)
    ).rejects.toThrow(/strict mode blocked/i);
    expect((await service.plan(plain, [MANAGED_SCHEMA])).hasChanges).toBe(false);

    await service.apply(omitted, [MANAGED_SCHEMA], true);
    expect((await service.plan(omitted, [MANAGED_SCHEMA])).hasChanges).toBe(
      false
    );
    if (serverVersion >= 170000) {
      expect(
        await hasDefaultPrivilege(client, "r", "MAINTAIN")
      ).toBe(true);
    }
    if (serverVersion >= 180000) {
      expect(
        await hasDefaultPrivilege(client, "L", "SELECT")
      ).toBe(true);
    }
    await createFutureObjects(client, "baseline");
    expect(
      await relationPrivilege(client, "baseline_table", "SELECT")
    ).toEqual({ granted: false, grantable: false });
    expect(
      await relationPrivilege(client, "baseline_table", "INSERT")
    ).toEqual({ granted: false, grantable: false });
    expect(
      await routinePrivilege(client, "baseline_function", true)
    ).toEqual({ granted: true, grantable: false });
    await dropFutureObjects(client, "baseline");

    await installDefaultsDirectly(client, false);
    expect((await service.plan(plain, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });

  test("rolls default privileges back when a later statement fails", async function () {
    await client.query(`
      CREATE ROLE ${BLOCKER_ROLE};
      CREATE SCHEMA ${BLOCKER_SCHEMA} AUTHORIZATION ${BLOCKER_ROLE};
    `);
    const service = createTestSchemaService();
    const desired = `
      CREATE ROLE ${OWNER_ROLE};
      CREATE ROLE ${READER_ROLE};
      CREATE SCHEMA ${MANAGED_SCHEMA};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
        GRANT SELECT ON TABLES TO ${READER_ROLE};
      DROP ROLE IF EXISTS ${BLOCKER_ROLE};
    `;

    await expect(
      service.apply(desired, [MANAGED_SCHEMA], true)
    ).rejects.toMatchObject({ code: "MIGRATION_ERROR" });

    expect(await roleExists(client, OWNER_ROLE)).toBe(false);
    expect(await roleExists(client, READER_ROLE)).toBe(false);
    expect(await schemaExists(client, MANAGED_SCHEMA)).toBe(false);
    expect(await defaultPrivilegeRowCount(client, OWNER_ROLE)).toBe(0);
  });

  test("restores default ACLs before explicitly removing their owner", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE ROLE ${OWNER_ROLE};
      CREATE ROLE ${READER_ROLE};
      CREATE SCHEMA ${MANAGED_SCHEMA};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
        GRANT SELECT ON TABLES TO ${READER_ROLE};
    `;
    await service.apply(initial, [MANAGED_SCHEMA], true);

    const removed = `
      CREATE ROLE ${READER_ROLE};
      CREATE SCHEMA ${MANAGED_SCHEMA};
      DROP ROLE IF EXISTS ${OWNER_ROLE};
    `;
    const plan = await service.plan(removed, [MANAGED_SCHEMA]);
    const restore =
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER_ROLE}" ` +
      `REVOKE SELECT ON TABLES FROM "${READER_ROLE}" RESTRICT;`;
    const drop = `DROP ROLE IF EXISTS "${OWNER_ROLE}";`;
    expect(plan.transactional).toContain(restore);
    expect(plan.transactional).toContain(drop);
    expect(plan.transactional.indexOf(restore)).toBeLessThan(
      plan.transactional.indexOf(drop)
    );

    await service.apply(removed, [MANAGED_SCHEMA], true);
    expect(await roleExists(client, OWNER_ROLE)).toBe(false);
    expect(await roleExists(client, READER_ROLE)).toBe(true);
    expect((await service.plan(removed, [MANAGED_SCHEMA])).hasChanges).toBe(
      false
    );
  });

  test("rejects ambiguous and version-specific defaults before mutation", async function () {
    const service = createTestSchemaService();
    const unsupported = `
      CREATE ROLE ${MARKER_ROLE};
      CREATE ROLE ${OWNER_ROLE};
      CREATE ROLE ${READER_ROLE};
      ALTER DEFAULT PRIVILEGES
        GRANT SELECT ON TABLES TO ${READER_ROLE};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
        GRANT MAINTAIN ON TABLES TO ${READER_ROLE};
    `;

    await expect(
      service.apply(unsupported, [MANAGED_SCHEMA], true)
    ).rejects.toMatchObject({ code: "PARSER_ERROR" });
    expect(await roleExists(client, MARKER_ROLE)).toBe(false);
    expect(await roleExists(client, OWNER_ROLE)).toBe(false);
  });
});

function baseDesiredSchema(): string {
  return `
    CREATE ROLE ${OWNER_ROLE};
    CREATE ROLE ${READER_ROLE};
    CREATE SCHEMA ${MANAGED_SCHEMA};
    CREATE TABLE ${MANAGED_SCHEMA}.existing_table (id integer);
    GRANT CREATE, USAGE ON SCHEMA ${MANAGED_SCHEMA} TO ${OWNER_ROLE};
  `;
}

function desiredDefaultPrivileges(insertGrantable: boolean): string {
  const option = insertGrantable ? " WITH GRANT OPTION" : "";
  return `
    ${baseDesiredSchema()}
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      GRANT SELECT ON TABLES TO ${READER_ROLE};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      IN SCHEMA ${MANAGED_SCHEMA}
      GRANT INSERT ON TABLES TO ${READER_ROLE}${option};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      GRANT USAGE ON SEQUENCES TO ${READER_ROLE};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      REVOKE EXECUTE ON ROUTINES FROM PUBLIC RESTRICT;
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      GRANT EXECUTE ON ROUTINES TO ${READER_ROLE};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      GRANT USAGE ON TYPES TO ${READER_ROLE};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      GRANT USAGE ON SCHEMAS TO ${READER_ROLE};
  `;
}

async function createExistingObjectBeforeDefaults(client: Client): Promise<void> {
  await client.query(`
    CREATE ROLE ${OWNER_ROLE};
    CREATE ROLE ${READER_ROLE};
    CREATE SCHEMA ${MANAGED_SCHEMA};
    GRANT CREATE, USAGE ON SCHEMA ${MANAGED_SCHEMA} TO ${OWNER_ROLE};
  `);
  await client.query(`SET ROLE ${OWNER_ROLE}`);
  try {
    await client.query(
      `CREATE TABLE ${MANAGED_SCHEMA}.existing_table (id integer)`
    );
  } finally {
    await client.query("RESET ROLE");
  }
}

async function createFutureObjects(
  client: Client,
  prefix: string
): Promise<void> {
  await client.query(`SET ROLE ${OWNER_ROLE}`);
  try {
    await client.query(`
      CREATE TABLE ${MANAGED_SCHEMA}.${prefix}_table (id integer);
      CREATE SEQUENCE ${MANAGED_SCHEMA}.${prefix}_sequence;
      CREATE FUNCTION ${MANAGED_SCHEMA}.${prefix}_function()
        RETURNS integer LANGUAGE sql AS 'SELECT 1';
      CREATE TYPE ${MANAGED_SCHEMA}.${prefix}_type AS ENUM ('one');
    `);
  } finally {
    await client.query("RESET ROLE");
  }
}

async function dropFutureObjects(
  client: Client,
  prefix: string
): Promise<void> {
  await client.query(`
    DROP FUNCTION ${MANAGED_SCHEMA}.${prefix}_function();
    DROP TYPE ${MANAGED_SCHEMA}.${prefix}_type;
    DROP SEQUENCE ${MANAGED_SCHEMA}.${prefix}_sequence;
    DROP TABLE ${MANAGED_SCHEMA}.${prefix}_table;
  `);
}

async function createFutureSchema(client: Client): Promise<void> {
  const database = await client.query("SELECT current_database() AS name");
  const databaseName = client.escapeIdentifier(database.rows[0].name);
  await client.query(`GRANT CREATE ON DATABASE ${databaseName} TO ${OWNER_ROLE}`);
  await client.query(`SET ROLE ${OWNER_ROLE}`);
  try {
    await client.query(`CREATE SCHEMA ${FUTURE_SCHEMA}`);
  } finally {
    await client.query("RESET ROLE");
  }
}

async function managedFuturePrivilegeState(client: Client) {
  return {
    tableSelect: await relationPrivilege(client, "managed_table", "SELECT"),
    tableInsert: await relationPrivilege(client, "managed_table", "INSERT"),
    sequenceUsage: await relationPrivilege(
      client,
      "managed_sequence",
      "USAGE"
    ),
    routineReaderExecute: await routinePrivilege(
      client,
      "managed_function",
      false
    ),
    routinePublicExecute: await routinePrivilege(
      client,
      "managed_function",
      true
    ),
    typeUsage: await typePrivilege(client, "managed_type"),
    schemaUsage: await schemaPrivilege(client, FUTURE_SCHEMA),
  };
}

async function relationPrivilege(
  client: Client,
  relationName: string,
  privilege: string
): Promise<{ granted: boolean; grantable: boolean }> {
  const result = await client.query(
    `
      WITH matched AS (
        SELECT acl.privilege_type, acl.is_grantable
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(
          COALESCE(
            relation.relacl,
            acldefault(
              CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
              relation.relowner
            )
          )
        ) acl
        JOIN pg_roles grantee ON grantee.oid = acl.grantee
        WHERE namespace.nspname = $1
          AND relation.relname = $2
          AND grantee.rolname = $3
          AND acl.privilege_type = $4
      )
      SELECT
        EXISTS (SELECT 1 FROM matched) AS granted,
        EXISTS (
          SELECT 1 FROM matched WHERE matched.is_grantable
        ) AS grantable
    `,
    [MANAGED_SCHEMA, relationName, READER_ROLE, privilege]
  );
  return result.rows[0];
}

async function routinePrivilege(
  client: Client,
  routineName: string,
  isPublic: boolean
): Promise<{ granted: boolean; grantable: boolean }> {
  const result = await client.query(
    `
      WITH matched AS (
        SELECT acl.privilege_type, acl.is_grantable
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        CROSS JOIN LATERAL aclexplode(
          COALESCE(routine.proacl, acldefault('f', routine.proowner))
        ) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
        WHERE namespace.nspname = $1
          AND routine.proname = $2
          AND acl.privilege_type = 'EXECUTE'
          AND (($3 AND acl.grantee = 0) OR (NOT $3 AND grantee.rolname = $4))
      )
      SELECT
        EXISTS (SELECT 1 FROM matched) AS granted,
        EXISTS (
          SELECT 1 FROM matched WHERE matched.is_grantable
        ) AS grantable
    `,
    [MANAGED_SCHEMA, routineName, isPublic, READER_ROLE]
  );
  return result.rows[0];
}

async function typePrivilege(
  client: Client,
  typeName: string
): Promise<{ granted: boolean; grantable: boolean }> {
  const result = await client.query(
    `
      WITH matched AS (
        SELECT acl.privilege_type, acl.is_grantable
        FROM pg_type type
        JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
        CROSS JOIN LATERAL aclexplode(
          COALESCE(type.typacl, acldefault('T', type.typowner))
        ) acl
        JOIN pg_roles grantee ON grantee.oid = acl.grantee
        WHERE namespace.nspname = $1
          AND type.typname = $2
          AND grantee.rolname = $3
          AND acl.privilege_type = 'USAGE'
      )
      SELECT
        EXISTS (SELECT 1 FROM matched) AS granted,
        EXISTS (
          SELECT 1 FROM matched WHERE matched.is_grantable
        ) AS grantable
    `,
    [MANAGED_SCHEMA, typeName, READER_ROLE]
  );
  return result.rows[0];
}

async function schemaPrivilege(
  client: Client,
  schemaName: string
): Promise<{ granted: boolean; grantable: boolean }> {
  const result = await client.query(
    `
      WITH matched AS (
        SELECT acl.privilege_type, acl.is_grantable
        FROM pg_namespace namespace
        CROSS JOIN LATERAL aclexplode(
          COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
        ) acl
        JOIN pg_roles grantee ON grantee.oid = acl.grantee
        WHERE namespace.nspname = $1
          AND grantee.rolname = $2
          AND acl.privilege_type = 'USAGE'
      )
      SELECT
        EXISTS (SELECT 1 FROM matched) AS granted,
        EXISTS (
          SELECT 1 FROM matched WHERE matched.is_grantable
        ) AS grantable
    `,
    [schemaName, READER_ROLE]
  );
  return result.rows[0];
}

async function installDefaultsDirectly(
  client: Client,
  insertGrantable: boolean
): Promise<void> {
  const option = insertGrantable ? " WITH GRANT OPTION" : "";
  await client.query(`
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      GRANT SELECT ON TABLES TO ${READER_ROLE};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      IN SCHEMA ${MANAGED_SCHEMA}
      GRANT INSERT ON TABLES TO ${READER_ROLE}${option};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      GRANT USAGE ON SEQUENCES TO ${READER_ROLE};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      REVOKE EXECUTE ON ROUTINES FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      GRANT EXECUTE ON ROUTINES TO ${READER_ROLE};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      GRANT USAGE ON TYPES TO ${READER_ROLE};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE}
      GRANT USAGE ON SCHEMAS TO ${READER_ROLE};
  `);
}

async function roleExists(client: Client, role: string): Promise<boolean> {
  const result = await client.query(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [role]
  );
  return result.rows[0]?.exists === true;
}

async function schemaExists(client: Client, schema: string): Promise<boolean> {
  const result = await client.query(
    "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists",
    [schema]
  );
  return result.rows[0]?.exists === true;
}

async function defaultPrivilegeRowCount(
  client: Client,
  owner: string
): Promise<number> {
  const result = await client.query(
    `
      SELECT count(*)::integer AS count
      FROM pg_default_acl defaults
      JOIN pg_roles owner ON owner.oid = defaults.defaclrole
      WHERE owner.rolname = $1
    `,
    [owner]
  );
  return result.rows[0]?.count || 0;
}

async function getServerVersion(client: Client): Promise<number> {
  const result = await client.query(
    "SELECT current_setting('server_version_num')::integer AS version"
  );
  return Number(result.rows[0]?.version);
}

async function hasDefaultPrivilege(
  client: Client,
  objectType: string,
  privilege: string
): Promise<boolean> {
  const result = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_default_acl defaults
        JOIN pg_roles owner ON owner.oid = defaults.defaclrole
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
        JOIN pg_roles grantee ON grantee.oid = acl.grantee
        WHERE owner.rolname = $1
          AND grantee.rolname = $2
          AND defaults.defaclobjtype = $3
          AND acl.privilege_type = $4
      ) AS exists
    `,
    [OWNER_ROLE, READER_ROLE, objectType, privilege]
  );
  return result.rows[0]?.exists === true;
}

async function cleanup(client: Client): Promise<void> {
  for (const schema of [FUTURE_SCHEMA, MANAGED_SCHEMA, BLOCKER_SCHEMA]) {
    await client.query(
      `DROP SCHEMA IF EXISTS ${client.escapeIdentifier(schema)} CASCADE`
    );
  }
  for (const role of [OWNER_ROLE, READER_ROLE, MARKER_ROLE, BLOCKER_ROLE]) {
    if (!(await roleExists(client, role))) {
      continue;
    }
    const quotedRole = client.escapeIdentifier(role);
    await client.query(`DROP OWNED BY ${quotedRole} CASCADE`);
    await client.query(`DROP ROLE ${quotedRole}`);
  }
}
