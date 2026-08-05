import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { getStatementRisk } from "../utils/statement-classifier";
import { createTestClient, createTestSchemaService } from "./utils";

const MANAGED_SCHEMA = "grant_contract";
const SERVER_NAME = "grant_contract_server";
const READER_ROLE = "grant_contract_reader";
const CHILD_ROLE = "grant_contract_child";
const GRANTOR_ROLE = "grant_contract_grantor";
const MARKER_ROLE = "grant_contract_rollback_marker";

describe("PostgreSQL privilege grant lifecycle", function () {
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

  test("creates repairs and removes concrete object privileges idempotently", async function () {
    const service = createTestSchemaService();
    const desired = desiredPrivileges(false, true);
    const initialPlan = await service.plan(desired, [MANAGED_SCHEMA]);

    expect(initialPlan.transactional).toContain(
      `GRANT SELECT ON TABLE "${MANAGED_SCHEMA}"."accounts" TO "${READER_ROLE}";`
    );
    expect(initialPlan.transactional).toContain(
      `GRANT INSERT ON TABLE "${MANAGED_SCHEMA}"."accounts" TO "${READER_ROLE}";`
    );
    expect(initialPlan.transactional).toContain(
      `GRANT USAGE ON SEQUENCE "${MANAGED_SCHEMA}"."ticket_numbers" TO "${READER_ROLE}";`
    );
    expect(initialPlan.transactional).toContain(
      `GRANT USAGE ON SCHEMA "${MANAGED_SCHEMA}" TO "${READER_ROLE}";`
    );
    expect(initialPlan.transactional).toContain(
      `GRANT USAGE ON FOREIGN SERVER "${SERVER_NAME}" TO "${READER_ROLE}";`
    );

    await service.apply(desired, [MANAGED_SCHEMA], true);
    expect(await privilegeState(client)).toEqual({
      tableSelect: { granted: true, grantable: false },
      tableInsert: { granted: true, grantable: false },
      sequenceUsage: { granted: true, grantable: false },
      schemaUsage: { granted: true, grantable: false },
      serverUsage: { granted: true, grantable: false },
    });
    expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);

    if (await supportsMaintainPrivilege(client)) {
      await client.query(
        `GRANT MAINTAIN ON TABLE ${MANAGED_SCHEMA}.accounts TO ${READER_ROLE}`
      );
      expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);
      expect(
        await hasPrivilege(client, READER_ROLE, "TABLE", "accounts", "MAINTAIN")
      ).toEqual({ granted: true, grantable: false });
    }

    await client.query(
      `REVOKE INSERT ON TABLE ${MANAGED_SCHEMA}.accounts FROM ${READER_ROLE}`
    );
    const repairPlan = await service.plan(desired, [MANAGED_SCHEMA]);
    expect(repairPlan.transactional).toEqual([
      `GRANT INSERT ON TABLE "${MANAGED_SCHEMA}"."accounts" TO "${READER_ROLE}";`,
    ]);
    await service.apply(desired, [MANAGED_SCHEMA], true);
    expect((await privilegeState(client)).tableInsert.granted).toBe(true);

    const removed = desiredPrivileges(false, false);
    const removalPlan = await service.plan(removed, [MANAGED_SCHEMA]);
    const revoke =
      `REVOKE INSERT ON TABLE "${MANAGED_SCHEMA}"."accounts" ` +
      `FROM "${READER_ROLE}" RESTRICT;`;
    expect(removalPlan.transactional).toContain(revoke);
    expect(getStatementRisk(revoke, "transactional")).toBe("destructive");
    await expect(
      service.apply(removed, [MANAGED_SCHEMA], true, undefined, true, true)
    ).rejects.toThrow(/strict mode blocked/i);
    expect((await privilegeState(client)).tableInsert.granted).toBe(true);

    await service.apply(removed, [MANAGED_SCHEMA], true);
    expect((await privilegeState(client)).tableInsert.granted).toBe(false);
    expect((await privilegeState(client)).tableSelect.granted).toBe(true);
    expect((await service.plan(removed, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });

  test("upgrades and downgrades grant options without revoking access", async function () {
    const service = createTestSchemaService();
    const plain = desiredPrivileges(false, true);
    const grantable = desiredPrivileges(true, true);
    await service.apply(plain, [MANAGED_SCHEMA], true);

    const upgrade = await service.plan(grantable, [MANAGED_SCHEMA]);
    expect(upgrade.transactional).toContain(
      `GRANT SELECT ON TABLE "${MANAGED_SCHEMA}"."accounts" ` +
        `TO "${READER_ROLE}" WITH GRANT OPTION;`
    );
    await service.apply(grantable, [MANAGED_SCHEMA], true);
    expect((await privilegeState(client)).tableSelect).toEqual({
      granted: true,
      grantable: true,
    });
    expect((await service.plan(grantable, [MANAGED_SCHEMA])).hasChanges).toBe(false);

    const downgrade = await service.plan(plain, [MANAGED_SCHEMA]);
    const revokeOption =
      `REVOKE GRANT OPTION FOR SELECT ON TABLE ` +
      `"${MANAGED_SCHEMA}"."accounts" FROM "${READER_ROLE}" RESTRICT;`;
    expect(downgrade.transactional).toContain(revokeOption);
    expect(getStatementRisk(revokeOption, "transactional")).toBe("destructive");
    await service.apply(plain, [MANAGED_SCHEMA], true);
    expect((await privilegeState(client)).tableSelect).toEqual({
      granted: true,
      grantable: false,
    });
    expect((await service.plan(plain, [MANAGED_SCHEMA])).hasChanges).toBe(false);
  });

  test("distinguishes PUBLIC from a quoted role named PUBLIC", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE ROLE "PUBLIC";
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.accounts (id integer);
      GRANT SELECT ON TABLE ${MANAGED_SCHEMA}.accounts TO PUBLIC;
      GRANT INSERT ON TABLE ${MANAGED_SCHEMA}.accounts TO "PUBLIC";
    `;

    await service.apply(desired, [MANAGED_SCHEMA], true);
    expect(await publicPrivilegeRows(client)).toEqual([
      { privilege_type: "INSERT", grantee_name: "PUBLIC", is_public: false },
      { privilege_type: "SELECT", grantee_name: null, is_public: true },
    ]);
    expect((await service.plan(desired, [MANAGED_SCHEMA])).hasChanges).toBe(false);

    const withoutQuotedRoleGrant = `
      CREATE ROLE "PUBLIC";
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.accounts (id integer);
      GRANT SELECT ON TABLE ${MANAGED_SCHEMA}.accounts TO PUBLIC;
    `;
    const plan = await service.plan(withoutQuotedRoleGrant, [MANAGED_SCHEMA]);
    expect(plan.transactional).toContain(
      `REVOKE INSERT ON TABLE "${MANAGED_SCHEMA}"."accounts" ` +
        `FROM "PUBLIC" RESTRICT;`
    );
    await service.apply(withoutQuotedRoleGrant, [MANAGED_SCHEMA], true);
    expect(await publicPrivilegeRows(client)).toEqual([
      { privilege_type: "SELECT", grantee_name: null, is_public: true },
    ]);
  });

  test("rejects dependent grant provenance before earlier mutations", async function () {
    const service = createTestSchemaService();
    const grantable = desiredPrivileges(true, true);
    await service.apply(grantable, [MANAGED_SCHEMA], true);
    await client.query(`CREATE ROLE ${CHILD_ROLE}`);
    await client.query(
      `GRANT USAGE ON SCHEMA ${MANAGED_SCHEMA} TO ${READER_ROLE}`
    );
    await client.query(`SET ROLE ${READER_ROLE}`);
    try {
      await client.query(
        `GRANT SELECT ON TABLE ${MANAGED_SCHEMA}.accounts TO ${CHILD_ROLE}`
      );
    } finally {
      await client.query("RESET ROLE");
    }

    const downgradeWithMarker =
      `CREATE ROLE ${MARKER_ROLE};\n` + desiredPrivileges(false, true);
    await expect(
      service.apply(downgradeWithMarker, [MANAGED_SCHEMA], true)
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("non-owner role"),
    });

    expect(await roleExists(client, MARKER_ROLE)).toBe(false);
    expect((await privilegeState(client)).tableSelect.grantable).toBe(true);
    expect(
      await hasPrivilege(client, CHILD_ROLE, "TABLE", "accounts", "SELECT")
    ).toEqual({ granted: true, grantable: false });
  });

  test("rejects unsupported syntax and non-owner grantors before mutation", async function () {
    const service = createTestSchemaService();
    const unsupported = `
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.should_not_exist (id integer);
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${MANAGED_SCHEMA}
        GRANT SELECT ON TABLES TO ${READER_ROLE};
    `;
    await expect(
      service.apply(unsupported, [MANAGED_SCHEMA], true)
    ).rejects.toMatchObject({ code: "PARSER_ERROR" });
    expect(await relationExists(client, "should_not_exist")).toBe(false);

    await client.query(`
      CREATE SCHEMA ${MANAGED_SCHEMA};
      CREATE TABLE ${MANAGED_SCHEMA}.accounts (id integer);
      CREATE ROLE ${GRANTOR_ROLE};
      CREATE ROLE ${CHILD_ROLE};
      GRANT USAGE ON SCHEMA ${MANAGED_SCHEMA} TO ${GRANTOR_ROLE};
      GRANT SELECT ON TABLE ${MANAGED_SCHEMA}.accounts
        TO ${GRANTOR_ROLE} WITH GRANT OPTION;
    `);
    await client.query(`SET ROLE ${GRANTOR_ROLE}`);
    try {
      await client.query(
        `GRANT SELECT ON TABLE ${MANAGED_SCHEMA}.accounts TO ${CHILD_ROLE}`
      );
    } finally {
      await client.query("RESET ROLE");
    }

    await expect(
      service.plan(
        `CREATE SCHEMA ${MANAGED_SCHEMA};`,
        [MANAGED_SCHEMA]
      )
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("non-owner role"),
    });
    expect(await roleExists(client, MARKER_ROLE)).toBe(false);
  });
});

function desiredPrivileges(selectGrantable: boolean, includeInsert: boolean): string {
  const selectOption = selectGrantable ? " WITH GRANT OPTION" : "";
  const insert = includeInsert
    ? `GRANT INSERT ON TABLE ${MANAGED_SCHEMA}.accounts TO ${READER_ROLE};`
    : "";
  return `
    CREATE EXTENSION postgres_fdw;
    CREATE ROLE ${READER_ROLE};
    CREATE SCHEMA ${MANAGED_SCHEMA};
    CREATE TABLE ${MANAGED_SCHEMA}.accounts (id integer PRIMARY KEY);
    CREATE SEQUENCE ${MANAGED_SCHEMA}.ticket_numbers;
    CREATE SERVER ${SERVER_NAME} FOREIGN DATA WRAPPER postgres_fdw;
    GRANT SELECT ON TABLE ${MANAGED_SCHEMA}.accounts
      TO ${READER_ROLE}${selectOption};
    ${insert}
    GRANT USAGE ON SEQUENCE ${MANAGED_SCHEMA}.ticket_numbers TO ${READER_ROLE};
    GRANT USAGE ON SCHEMA ${MANAGED_SCHEMA} TO ${READER_ROLE};
    GRANT USAGE ON FOREIGN SERVER ${SERVER_NAME} TO ${READER_ROLE};
  `;
}

async function privilegeState(client: Client): Promise<{
  tableSelect: { granted: boolean; grantable: boolean };
  tableInsert: { granted: boolean; grantable: boolean };
  sequenceUsage: { granted: boolean; grantable: boolean };
  schemaUsage: { granted: boolean; grantable: boolean };
  serverUsage: { granted: boolean; grantable: boolean };
}> {
  return {
    tableSelect: await hasPrivilege(
      client,
      READER_ROLE,
      "TABLE",
      "accounts",
      "SELECT"
    ),
    tableInsert: await hasPrivilege(
      client,
      READER_ROLE,
      "TABLE",
      "accounts",
      "INSERT"
    ),
    sequenceUsage: await hasPrivilege(
      client,
      READER_ROLE,
      "SEQUENCE",
      "ticket_numbers",
      "USAGE"
    ),
    schemaUsage: await hasPrivilege(
      client,
      READER_ROLE,
      "SCHEMA",
      MANAGED_SCHEMA,
      "USAGE"
    ),
    serverUsage: await hasPrivilege(
      client,
      READER_ROLE,
      "FOREIGN SERVER",
      SERVER_NAME,
      "USAGE"
    ),
  };
}

async function hasPrivilege(
  client: Client,
  grantee: string,
  objectType: "TABLE" | "SEQUENCE" | "SCHEMA" | "FOREIGN SERVER",
  objectName: string,
  privilege: string
): Promise<{ granted: boolean; grantable: boolean }> {
  const result = await client.query(
    `
      WITH target_acl AS (
        SELECT relation.relacl AS acl
        FROM pg_class relation
        JOIN pg_namespace namespace
          ON namespace.oid = relation.relnamespace
        WHERE $2 IN ('TABLE', 'SEQUENCE')
          AND namespace.nspname = $4
          AND relation.relname = $3
          AND (
            ($2 = 'SEQUENCE' AND relation.relkind = 'S')
            OR ($2 = 'TABLE' AND relation.relkind <> 'S')
          )
        UNION ALL
        SELECT namespace.nspacl
        FROM pg_namespace namespace
        WHERE $2 = 'SCHEMA'
          AND namespace.nspname = $3
        UNION ALL
        SELECT server.srvacl
        FROM pg_foreign_server server
        WHERE $2 = 'FOREIGN SERVER'
          AND server.srvname = $3
      ), matched AS (
        SELECT
          privilege.privilege_type,
          privilege.is_grantable
        FROM target_acl
        CROSS JOIN LATERAL aclexplode(target_acl.acl) privilege
        JOIN pg_roles grantee ON grantee.oid = privilege.grantee
        WHERE grantee.rolname = $1
          AND privilege.privilege_type = $5
      )
      SELECT
        EXISTS (SELECT 1 FROM matched) AS granted,
        EXISTS (
          SELECT 1 FROM matched WHERE matched.is_grantable
        ) AS grantable
    `,
    [grantee, objectType, objectName, MANAGED_SCHEMA, privilege]
  );
  return result.rows[0];
}

async function roleExists(client: Client, role: string): Promise<boolean> {
  const result = await client.query(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [role]
  );
  return result.rows[0]?.exists === true;
}

async function supportsMaintainPrivilege(client: Client): Promise<boolean> {
  const result = await client.query(
    "SELECT current_setting('server_version_num')::integer AS version"
  );
  return Number(result.rows[0]?.version) >= 170000;
}

async function publicPrivilegeRows(client: Client): Promise<Array<{
  privilege_type: string;
  grantee_name: string | null;
  is_public: boolean;
}>> {
  const result = await client.query(
    `
      SELECT
        privilege.privilege_type,
        grantee.rolname AS grantee_name,
        privilege.grantee = 0 AS is_public
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(relation.relacl) privilege
      LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
      WHERE namespace.nspname = $1
        AND relation.relname = 'accounts'
        AND (
          privilege.grantee = 0
          OR grantee.rolname = 'PUBLIC'
        )
      ORDER BY privilege.privilege_type
    `,
    [MANAGED_SCHEMA]
  );
  return result.rows;
}

async function relationExists(client: Client, relation: string): Promise<boolean> {
  const result = await client.query(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`${MANAGED_SCHEMA}.${relation}`]
  );
  return result.rows[0]?.exists === true;
}

async function cleanup(client: Client): Promise<void> {
  await client.query(`DROP SERVER IF EXISTS ${SERVER_NAME} CASCADE`);
  await client.query(`DROP SCHEMA IF EXISTS ${MANAGED_SCHEMA} CASCADE`);
  for (const role of [
    CHILD_ROLE,
    GRANTOR_ROLE,
    MARKER_ROLE,
    READER_ROLE,
    "PUBLIC",
  ]) {
    if (!(await roleExists(client, role))) {
      continue;
    }
    const quotedRole = `"${role.replace(/"/g, '""')}"`;
    await client.query(`DROP OWNED BY ${quotedRole}`);
    await client.query(`DROP ROLE ${quotedRole}`);
  }
}
