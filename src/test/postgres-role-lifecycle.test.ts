import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { getStatementRisk } from "../utils/statement-classifier";
import { createTestClient, createTestSchemaService } from "./utils";

const MANAGED_SCHEMA = "role_contract";
const EXTERNAL_SCHEMA = "role_contract_external";
const ROLE_NAME = "TerraDB Lifecycle Role";
const MEMBER_NAME = "TerraDB Lifecycle Member";
const CONNECTION_LIMIT_ROLE = "TerraDB Connection Limited Role";
const ROLLBACK_ROLE = "TerraDB Role Rollback";
const REMOVAL_ROLE = "TerraDB Removal Role";
const UNSUPPORTED_ROLE = "TerraDB Unsupported Role";
const REMOVAL_GUARD = "removal_guard";

describe("PostgreSQL role lifecycle", function () {
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

  test("alters every role attribute in place and preserves unmanaged state", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE USER "${ROLE_NAME}" NOLOGIN SUPERUSER CREATEDB CREATEROLE
        NOINHERIT REPLICATION BYPASSRLS CONNECTION LIMIT 4;
    `;
    const createStatement =
      `CREATE ROLE "${ROLE_NAME}" WITH NOLOGIN SUPERUSER CREATEDB ` +
      `CREATEROLE NOINHERIT REPLICATION BYPASSRLS CONNECTION LIMIT 4;`;
    const initialPlan = await service.plan(initial, [MANAGED_SCHEMA]);

    expect(initialPlan.transactional).toContain(createStatement);
    await service.apply(initial, [MANAGED_SCHEMA, "public"], true);
    const original = await inspectRole(client, ROLE_NAME);
    expect(original).toMatchObject({
      login: false,
      superuser: true,
      create_database: true,
      create_role: true,
      inherit: false,
      replication: true,
      bypass_rls: true,
      connection_limit: 4,
    });

    await client.query(
      `CREATE SCHEMA ${EXTERNAL_SCHEMA} AUTHORIZATION "${ROLE_NAME}"`
    );
    await client.query(`CREATE ROLE "${MEMBER_NAME}"`);
    await client.query(`GRANT "${ROLE_NAME}" TO "${MEMBER_NAME}"`);
    await client.query(
      `ALTER ROLE "${ROLE_NAME}" PASSWORD 'temporary-contract-secret' ` +
        `VALID UNTIL '2035-01-02 03:04:05+00'`
    );
    await client.query(
      `ALTER ROLE "${ROLE_NAME}" SET application_name TO 'terradb-role-contract'`
    );
    const unmanagedState = await inspectUnmanagedRoleState(client);

    const changed = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE ROLE "${ROLE_NAME}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;
    `;
    const changedPlan = await service.plan(changed, [MANAGED_SCHEMA]);
    const alterStatement =
      `ALTER ROLE "${ROLE_NAME}" WITH LOGIN NOSUPERUSER NOCREATEDB ` +
      `NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;`;

    expect(changedPlan.transactional).toContain(alterStatement);
    expect(changedPlan.transactional.some(isRoleCreate)).toBe(false);
    expect(changedPlan.transactional.some(isRoleDrop)).toBe(false);
    expect(getStatementRisk(alterStatement, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(
        changed,
        [MANAGED_SCHEMA],
        true,
        undefined,
        false,
        true
      )
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: expect.arrayContaining([alterStatement]),
    });
    expect(await inspectRole(client, ROLE_NAME)).toEqual(original);
    expect(await schemaOwner(client, EXTERNAL_SCHEMA)).toBe(ROLE_NAME);
    expect(await roleMembershipExists(client)).toBe(true);
    expect(await inspectUnmanagedRoleState(client)).toEqual(unmanagedState);

    await service.apply(changed, [MANAGED_SCHEMA], true);

    const changedRole = await inspectRole(client, ROLE_NAME);
    expect(changedRole).toMatchObject({
      oid: original.oid,
      login: true,
      superuser: false,
      create_database: false,
      create_role: false,
      inherit: true,
      replication: false,
      bypass_rls: false,
      connection_limit: -1,
    });
    expect(await schemaOwner(client, EXTERNAL_SCHEMA)).toBe(ROLE_NAME);
    expect(await roleMembershipExists(client)).toBe(true);
    expect(await inspectUnmanagedRoleState(client)).toEqual(unmanagedState);
    expect(await service.plan(changed, [MANAGED_SCHEMA])).toMatchObject({
      hasChanges: false,
    });

    const restricted = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE ROLE "${ROLE_NAME}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;
    `;
    const restrictionStatement =
      `ALTER ROLE "${ROLE_NAME}" WITH NOLOGIN NOINHERIT;`;
    const restrictionPlan = await service.plan(restricted, [MANAGED_SCHEMA]);
    expect(restrictionPlan.transactional).toContain(restrictionStatement);
    expect(getStatementRisk(restrictionStatement, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(
        restricted,
        [MANAGED_SCHEMA],
        true,
        undefined,
        false,
        true
      )
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: expect.arrayContaining([restrictionStatement]),
    });
    expect(await inspectRole(client, ROLE_NAME)).toEqual(changedRole);
    expect(await schemaOwner(client, EXTERNAL_SCHEMA)).toBe(ROLE_NAME);
    expect(await roleMembershipExists(client)).toBe(true);
    expect(await inspectUnmanagedRoleState(client)).toEqual(unmanagedState);

    await client.query(
      `ALTER ROLE "${ROLE_NAME}" NOLOGIN CREATEDB NOINHERIT CONNECTION LIMIT 7`
    );
    const repairPlan = await service.plan(changed, [MANAGED_SCHEMA]);
    expect(repairPlan.transactional).toContain(
      `ALTER ROLE "${ROLE_NAME}" WITH LOGIN NOCREATEDB INHERIT ` +
        `CONNECTION LIMIT -1;`
    );
    await service.apply(changed, [MANAGED_SCHEMA], true);
    expect(await inspectRole(client, ROLE_NAME)).toMatchObject({
      oid: original.oid,
      login: true,
      superuser: false,
      create_database: false,
      create_role: false,
      inherit: true,
      replication: false,
      bypass_rls: false,
      connection_limit: -1,
    });
    expect(await schemaOwner(client, EXTERNAL_SCHEMA)).toBe(ROLE_NAME);
    expect(await roleMembershipExists(client)).toBe(true);
    expect(await inspectUnmanagedRoleState(client)).toEqual(unmanagedState);
    expect((await service.plan(changed, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });

  test("blocks removal of a finite role connection limit", async function () {
    const service = createTestSchemaService();
    const limited = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE ROLE "${CONNECTION_LIMIT_ROLE}" LOGIN CONNECTION LIMIT 3;
    `;
    const unlimited = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE ROLE "${CONNECTION_LIMIT_ROLE}" LOGIN CONNECTION LIMIT -1;
    `;
    const restricted = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE ROLE "${CONNECTION_LIMIT_ROLE}" LOGIN CONNECTION LIMIT 2;
    `;

    await service.apply(limited, [MANAGED_SCHEMA], true);
    const original = await inspectRole(client, CONNECTION_LIMIT_ROLE);
    expect(original).toMatchObject({
      login: true,
      connection_limit: 3,
    });

    const removalPlan = await service.plan(unlimited, [MANAGED_SCHEMA]);
    const removalStatement =
      `ALTER ROLE "${CONNECTION_LIMIT_ROLE}" WITH CONNECTION LIMIT -1;`;
    expect(removalPlan.transactional).toContain(removalStatement);
    expect(getStatementRisk(removalStatement, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(
        unlimited,
        [MANAGED_SCHEMA],
        true,
        undefined,
        false,
        true
      )
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: [removalStatement],
    });
    expect(await inspectRole(client, CONNECTION_LIMIT_ROLE)).toEqual(original);

    await service.apply(unlimited, [MANAGED_SCHEMA], true);
    expect(await inspectRole(client, CONNECTION_LIMIT_ROLE)).toMatchObject({
      oid: original.oid,
      login: true,
      connection_limit: -1,
    });
    expect((await service.plan(unlimited, [MANAGED_SCHEMA])).hasChanges).toBe(
      false
    );

    const restrictionPlan = await service.plan(restricted, [MANAGED_SCHEMA]);
    const restrictionStatement =
      `ALTER ROLE "${CONNECTION_LIMIT_ROLE}" WITH CONNECTION LIMIT 2;`;
    expect(restrictionPlan.transactional).toContain(restrictionStatement);
    expect(getStatementRisk(restrictionStatement, "transactional")).toBe(
      "safe"
    );
    await service.apply(
      restricted,
      [MANAGED_SCHEMA],
      true,
      undefined,
      false,
      true
    );
    expect(await inspectRole(client, CONNECTION_LIMIT_ROLE)).toMatchObject({
      oid: original.oid,
      login: true,
      connection_limit: 2,
    });
    expect((await service.plan(restricted, [MANAGED_SCHEMA])).hasChanges).toBe(
      false
    );
  });

  test("rolls an in-place role alteration back when a later routine fails", async function () {
    const service = createTestSchemaService();
    const initial = `CREATE ROLE "${ROLLBACK_ROLE}" LOGIN CONNECTION LIMIT 2;`;
    const failing = `
      CREATE ROLE "${ROLLBACK_ROLE}" NOLOGIN CONNECTION LIMIT 7;

      CREATE FUNCTION public.role_rollback_invalid()
      RETURNS void
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE NOTICE;
      END;
      $$;
    `;

    await service.apply(initial, [MANAGED_SCHEMA], true);
    const before = await inspectRole(client, ROLLBACK_ROLE);
    const plan = await service.plan(failing, [MANAGED_SCHEMA, "public"]);
    const rolePosition = plan.transactional.findIndex(function findsRoleAlteration(statement) {
      return statement.startsWith(`ALTER ROLE "${ROLLBACK_ROLE}"`);
    });
    const functionPosition = plan.transactional.findIndex(function findsInvalidFunction(statement) {
      return statement.includes('CREATE FUNCTION "public"."role_rollback_invalid"');
    });
    expect(rolePosition).toBeGreaterThanOrEqual(0);
    expect(functionPosition).toBeGreaterThan(rolePosition);

    await expect(
      service.apply(failing, [MANAGED_SCHEMA, "public"], true)
    ).rejects.toThrow();
    expect(await inspectRole(client, ROLLBACK_ROLE)).toEqual(before);
    expect((await service.plan(initial, [MANAGED_SCHEMA, "public"])).hasChanges).toBe(
      false
    );
  });

  test("removes roles explicitly, blocks strict mode, and rolls back dependencies", async function () {
    await client.query(`CREATE ROLE "${REMOVAL_ROLE}"`);
    await client.query(
      `CREATE SCHEMA ${EXTERNAL_SCHEMA} AUTHORIZATION "${REMOVAL_ROLE}"`
    );
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.${REMOVAL_GUARD} (id integer);
      DROP ROLE IF EXISTS "${REMOVAL_ROLE}";
    `;
    const dropStatement = `DROP ROLE IF EXISTS "${REMOVAL_ROLE}";`;

    await expect(
      service.apply(desired, [MANAGED_SCHEMA], true)
    ).rejects.toMatchObject({ code: "MIGRATION_ERROR" });
    expect(await roleExists(client, REMOVAL_ROLE)).toBe(true);
    expect(
      await relationExists(client, `${MANAGED_SCHEMA}.${REMOVAL_GUARD}`)
    ).toBe(false);

    await client.query(`DROP SCHEMA ${EXTERNAL_SCHEMA}`);
    const plan = await service.plan(desired, [MANAGED_SCHEMA]);
    expect(plan.transactional).toContain(dropStatement);
    expect(getStatementRisk(dropStatement, "transactional")).toBe("destructive");
    await expect(
      service.apply(desired, [MANAGED_SCHEMA], true, undefined, true, true)
    ).rejects.toThrow(/strict mode blocked/i);
    expect(await roleExists(client, REMOVAL_ROLE)).toBe(true);

    await service.apply(desired, [MANAGED_SCHEMA], true);
    expect(await roleExists(client, REMOVAL_ROLE)).toBe(false);
    expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });

  test("rejects unobservable role clauses before preceding mutations", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.should_not_exist (id integer);
      CREATE ROLE "${UNSUPPORTED_ROLE}" LOGIN PASSWORD 'secret';
    `;

    await expect(
      service.apply(desired, [MANAGED_SCHEMA], true)
    ).rejects.toMatchObject({ code: "PARSER_ERROR" });
    expect(await schemaOwner(client, MANAGED_SCHEMA)).toBeUndefined();
    expect(await roleExists(client, UNSUPPORTED_ROLE)).toBe(false);
  });
});

function isRoleCreate(statement: string): boolean {
  return statement.startsWith("CREATE ROLE");
}

function isRoleDrop(statement: string): boolean {
  return statement.startsWith("DROP ROLE");
}

async function inspectRole(client: Client, name: string): Promise<any> {
  const result = await client.query(
    `
      SELECT
        oid::integer,
        rolcanlogin AS login,
        rolsuper AS superuser,
        rolcreatedb AS create_database,
        rolcreaterole AS create_role,
        rolinherit AS inherit,
        rolreplication AS replication,
        rolbypassrls AS bypass_rls,
        rolconnlimit AS connection_limit
      FROM pg_roles
      WHERE rolname = $1
    `,
    [name]
  );
  return result.rows[0];
}

async function schemaOwner(
  client: Client,
  schema: string
): Promise<string | undefined> {
  const result = await client.query(
    `
      SELECT pg_get_userbyid(nspowner) AS owner
      FROM pg_namespace
      WHERE nspname = $1
    `,
    [schema]
  );
  return result.rows[0]?.owner;
}

async function roleMembershipExists(client: Client): Promise<boolean> {
  const result = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        JOIN pg_roles granted ON granted.oid = membership.roleid
        JOIN pg_roles member ON member.oid = membership.member
        WHERE granted.rolname = $1
          AND member.rolname = $2
      ) AS exists
    `,
    [ROLE_NAME, MEMBER_NAME]
  );
  return result.rows[0]?.exists === true;
}

async function inspectUnmanagedRoleState(client: Client): Promise<{
  password: string | null;
  validUntil: string | null;
  configuration: string[] | null;
}> {
  const result = await client.query(
    `
      SELECT
        auth.rolpassword AS password,
        auth.rolvaliduntil::text AS "validUntil",
        roles.rolconfig AS configuration
      FROM pg_authid auth
      JOIN pg_roles roles ON roles.oid = auth.oid
      WHERE auth.rolname = $1
    `,
    [ROLE_NAME]
  );
  return result.rows[0];
}

async function roleExists(client: Client, name: string): Promise<boolean> {
  return (await inspectRole(client, name)) !== undefined;
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

async function cleanup(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${EXTERNAL_SCHEMA} CASCADE`);
  await client.query(`DROP SCHEMA IF EXISTS ${MANAGED_SCHEMA} CASCADE`);
  for (const name of [
    MEMBER_NAME,
    ROLE_NAME,
    CONNECTION_LIMIT_ROLE,
    ROLLBACK_ROLE,
    REMOVAL_ROLE,
    UNSUPPORTED_ROLE,
  ]) {
    if (!(await roleExists(client, name))) {
      continue;
    }
    await client.query(`REASSIGN OWNED BY "${name}" TO CURRENT_USER`);
    await client.query(`DROP OWNED BY "${name}"`);
    await client.query(`DROP ROLE "${name}"`);
  }
}
