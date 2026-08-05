import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { DatabaseInspector } from "../core/schema/inspector";
import { createTestClient, createTestSchemaService } from "./utils";

const SCHEMA = "row_security_lifecycle";

const baseSchema = `
  CREATE SCHEMA "${SCHEMA}";
  CREATE TABLE "${SCHEMA}"."Order" (
    id integer PRIMARY KEY,
    tenant_id integer NOT NULL,
    parent_id integer
  );
`;

async function getVisibleOrderIds(client: Client): Promise<number[]> {
  await client.query("SET ROLE pg_signal_backend");
  try {
    const result = await client.query(
      `SELECT id FROM "${SCHEMA}"."Order" ORDER BY id`
    );
    return result.rows.map(function getId(row) {
      return row.id;
    });
  } finally {
    await client.query("RESET ROLE");
  }
}

describe("PostgreSQL row-level security and policy lifecycle", function () {
  let client: Client;

  beforeEach(async function prepareSchema() {
    client = await createTestClient();
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  });

  afterEach(async function removeSchema() {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.end();
  });

  test("creates, inspects, and converges complete policy state", async function () {
    const service = createTestSchemaService();
    const desired = `${baseSchema}
      ALTER TABLE "${SCHEMA}"."Order"
        ENABLE ROW LEVEL SECURITY,
        FORCE ROW LEVEL SECURITY;
      CREATE POLICY "Tenant Read"
        ON "${SCHEMA}"."Order"
        AS RESTRICTIVE
        FOR SELECT
        TO PUBLIC, CURRENT_USER
        USING (tenant_id = current_setting('app.tenant_id')::integer);
      CREATE POLICY "Tenant Write"
        ON "${SCHEMA}"."Order"
        FOR UPDATE
        TO CURRENT_ROLE, SESSION_USER
        USING (tenant_id > 0);
    `;

    await service.apply(desired, [SCHEMA], true);

    const state = await client.query(`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND relation.relname = 'Order'
    `, [SCHEMA]);
    expect(state.rows).toEqual([
      { relrowsecurity: true, relforcerowsecurity: true },
    ]);

    const inspected = await new DatabaseInspector().getCurrentSqlObjects(
      client,
      [SCHEMA]
    );
    const policy = inspected.find(function findTenantRead(object) {
      return object.key === `policy:${SCHEMA}.Order.Tenant Read`;
    });
    expect(policy?.policyDefinition).toMatchObject({
      command: "select",
      permissive: false,
      roles: [{ kind: "public" }],
    });

    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("converges equivalent externally created policy state", async function () {
    const service = createTestSchemaService();
    await client.query(`${baseSchema}
      ALTER TABLE "${SCHEMA}"."Order" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "${SCHEMA}"."Order" FORCE ROW LEVEL SECURITY;
      CREATE POLICY "External ✓"
        ON "${SCHEMA}"."Order"
        AS PERMISSIVE
        FOR ALL
        TO CURRENT_USER
        USING (tenant_id = current_setting('app.tenant_id')::integer)
        WITH CHECK (tenant_id > 0);
    `);
    const desired = `${baseSchema}
      ALTER TABLE "${SCHEMA}"."Order"
        ENABLE ROW LEVEL SECURITY,
        FORCE ROW LEVEL SECURITY;
      CREATE POLICY "External ✓"
        ON "${SCHEMA}"."Order"
        TO CURRENT_ROLE
        USING (tenant_id = current_setting('app.tenant_id')::integer)
        WITH CHECK (tenant_id > 0);
    `;

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );

    expect(plan.hasChanges).toBe(false);
  });

  test("tracks every policy command and expression form", async function () {
    const service = createTestSchemaService();
    const desired = `${baseSchema}
      ALTER TABLE "${SCHEMA}"."Order" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "select policy" ON "${SCHEMA}"."Order"
        FOR SELECT USING (tenant_id > 0);
      CREATE POLICY "insert policy" ON "${SCHEMA}"."Order"
        FOR INSERT WITH CHECK (tenant_id > 0);
      CREATE POLICY "update policy" ON "${SCHEMA}"."Order"
        FOR UPDATE USING (tenant_id > 0) WITH CHECK (tenant_id >= 10);
      CREATE POLICY "delete policy" ON "${SCHEMA}"."Order"
        FOR DELETE USING (tenant_id > 0);
      CREATE POLICY "all policy" ON "${SCHEMA}"."Order"
        AS RESTRICTIVE FOR ALL
        USING (tenant_id > 0) WITH CHECK (tenant_id >= 10);
    `;

    await service.apply(desired, [SCHEMA], true);
    const inspected = await new DatabaseInspector().getCurrentSqlObjects(
      client,
      [SCHEMA]
    );
    const commands = inspected
      .filter(function isPolicy(object) {
        return object.kind === "policy";
      })
      .map(function getCommand(object) {
        return object.policyDefinition?.command;
      })
      .sort();
    expect(commands).toEqual(["all", "delete", "insert", "select", "update"]);
    expect(
      (await service.apply(desired, [SCHEMA], true, undefined, true)).hasChanges
    ).toBe(false);
  });

  test("enforces inspected policy expressions for a non-owner role", async function () {
    const service = createTestSchemaService();
    const desired = `${baseSchema}
      ALTER TABLE "${SCHEMA}"."Order"
        ENABLE ROW LEVEL SECURITY,
        FORCE ROW LEVEL SECURITY;
      CREATE POLICY "visible tenant" ON "${SCHEMA}"."Order"
        FOR SELECT TO PUBLIC
        USING (tenant_id = current_setting('app.tenant_id')::integer);
      GRANT USAGE ON SCHEMA "${SCHEMA}" TO PUBLIC;
      GRANT SELECT ON TABLE "${SCHEMA}"."Order" TO PUBLIC;
    `;
    await service.apply(desired, [SCHEMA], true);
    await client.query(
      `INSERT INTO "${SCHEMA}"."Order" (id, tenant_id) VALUES (1, 1), (2, 2)`
    );
    await client.query("SELECT set_config('app.tenant_id', '2', false)");
    await client.query("SET ROLE pg_signal_backend");
    try {
      const visible = await client.query(
        `SELECT id, tenant_id FROM "${SCHEMA}"."Order" ORDER BY id`
      );
      expect(visible.rows).toEqual([{ id: 2, tenant_id: 2 }]);
    } finally {
      await client.query("RESET ROLE");
    }
  });

  test("replaces changed policies and removes policy enforcement declaratively", async function () {
    const service = createTestSchemaService();
    const initial = `${baseSchema}
      ALTER TABLE "${SCHEMA}"."Order"
        ENABLE ROW LEVEL SECURITY,
        FORCE ROW LEVEL SECURITY;
      CREATE POLICY "Tenant Access"
        ON "${SCHEMA}"."Order"
        AS RESTRICTIVE
        FOR SELECT
        TO PUBLIC
        USING (tenant_id > 0);
    `;
    const changed = initial
      .replace("AS RESTRICTIVE", "AS PERMISSIVE")
      .replace("FOR SELECT", "FOR DELETE")
      .replace("tenant_id > 0", "tenant_id >= 10");
    await service.apply(initial, [SCHEMA], true);

    const changePlan = await service.apply(
      changed,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(changePlan.transactional).toContain(
      `DROP POLICY IF EXISTS "Tenant Access" ON "${SCHEMA}"."Order";`
    );
    expect(changePlan.transactional.join("\n")).toContain(
      "CREATE POLICY \"Tenant Access\""
    );
    await service.apply(changed, [SCHEMA], true);
    expect(
      (await service.apply(changed, [SCHEMA], true, undefined, true)).hasChanges
    ).toBe(false);

    const removalPlan = await service.apply(
      baseSchema,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(removalPlan.transactional).toEqual(
      expect.arrayContaining([
        `DROP POLICY IF EXISTS "Tenant Access" ON "${SCHEMA}"."Order";`,
        `ALTER TABLE "${SCHEMA}"."Order" NO FORCE ROW LEVEL SECURITY;`,
        `ALTER TABLE "${SCHEMA}"."Order" DISABLE ROW LEVEL SECURITY;`,
      ])
    );
    await service.apply(baseSchema, [SCHEMA], true);

    const state = await client.query(`
      SELECT
        relation.relrowsecurity,
        relation.relforcerowsecurity,
        count(policy.oid)::integer as policy_count
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_policy policy ON policy.polrelid = relation.oid
      WHERE namespace.nspname = $1 AND relation.relname = 'Order'
      GROUP BY relation.relrowsecurity, relation.relforcerowsecurity
    `, [SCHEMA]);
    expect(state.rows).toEqual([{
      relrowsecurity: false,
      relforcerowsecurity: false,
      policy_count: 0,
    }]);
  });

  test("rolls back policy and enforcement changes after a later policy failure", async function () {
    const service = createTestSchemaService();
    const initial = `${baseSchema}
      ALTER TABLE "${SCHEMA}"."Order"
        ENABLE ROW LEVEL SECURITY,
        FORCE ROW LEVEL SECURITY;
      CREATE POLICY "A tenant access"
        ON "${SCHEMA}"."Order"
        FOR SELECT TO PUBLIC
        USING (tenant_id = current_setting('app.tenant_id')::integer);
      GRANT USAGE ON SCHEMA "${SCHEMA}" TO PUBLIC;
      GRANT SELECT ON TABLE "${SCHEMA}"."Order" TO PUBLIC;
    `;
    const failing = `${baseSchema}
      CREATE POLICY "A tenant access"
        ON "${SCHEMA}"."Order"
        FOR SELECT TO PUBLIC
        USING (tenant_id = 1);
      CREATE POLICY "Z invalid policy"
        ON "${SCHEMA}"."Order"
        FOR SELECT TO PUBLIC
        USING (missing_column = 1);
      GRANT USAGE ON SCHEMA "${SCHEMA}" TO PUBLIC;
      GRANT SELECT ON TABLE "${SCHEMA}"."Order" TO PUBLIC;
    `;

    await service.apply(initial, [SCHEMA], true);
    await client.query(
      `INSERT INTO "${SCHEMA}"."Order" (id, tenant_id) VALUES (1, 1), (2, 2)`
    );
    await client.query("SELECT set_config('app.tenant_id', '2', false)");
    expect(await getVisibleOrderIds(client)).toEqual([2]);

    const plan = await service.plan(failing, [SCHEMA]);
    const validPolicyIndex = plan.transactional.findIndex(
      function findValidPolicy(statement) {
        return statement.includes('CREATE POLICY "A tenant access"');
      }
    );
    const invalidPolicyIndex = plan.transactional.findIndex(
      function findInvalidPolicy(statement) {
        return statement.includes('CREATE POLICY "Z invalid policy"');
      }
    );
    expect(plan.transactional).toEqual(
      expect.arrayContaining([
        `DROP POLICY IF EXISTS "A tenant access" ON "${SCHEMA}"."Order";`,
        `ALTER TABLE "${SCHEMA}"."Order" NO FORCE ROW LEVEL SECURITY;`,
        `ALTER TABLE "${SCHEMA}"."Order" DISABLE ROW LEVEL SECURITY;`,
      ])
    );
    expect(validPolicyIndex).toBeGreaterThanOrEqual(0);
    expect(invalidPolicyIndex).toBeGreaterThan(validPolicyIndex);

    await expect(service.apply(failing, [SCHEMA], true)).rejects.toThrow(
      'column "missing_column" does not exist'
    );

    const state = await client.query(`
      SELECT
        relation.relrowsecurity,
        relation.relforcerowsecurity,
        policy.polname,
        policy.polpermissive,
        policy.polcmd,
        pg_get_expr(policy.polqual, policy.polrelid) AS using_expression
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_policy policy ON policy.polrelid = relation.oid
      WHERE namespace.nspname = $1 AND relation.relname = 'Order'
      ORDER BY policy.polname
    `, [SCHEMA]);
    expect(state.rows).toEqual([{
      relrowsecurity: true,
      relforcerowsecurity: true,
      polname: "A tenant access",
      polpermissive: true,
      polcmd: "r",
      using_expression:
        "(tenant_id = (current_setting('app.tenant_id'::text))::integer)",
    }]);
    expect(await getVisibleOrderIds(client)).toEqual([2]);
    const storedRows = await client.query(
      `SELECT count(*)::integer AS count FROM "${SCHEMA}"."Order"`
    );
    expect(storedRows.rows).toEqual([{ count: 2 }]);

    const restoredPlan = await service.plan(initial, [SCHEMA]);
    expect(restoredPlan.hasChanges).toBe(false);
    expect(restoredPlan.transactional).toEqual([]);
    expect(restoredPlan.concurrent).toEqual([]);
  });

  test("combines supported table constraints with row security declarations", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TABLE "${SCHEMA}"."parents" (id integer PRIMARY KEY);
      CREATE TABLE "${SCHEMA}"."children" (
        id integer PRIMARY KEY,
        parent_id integer,
        score integer
      );
      ALTER TABLE "${SCHEMA}"."children"
        ADD CONSTRAINT "parent_fk" FOREIGN KEY (parent_id)
          REFERENCES "${SCHEMA}"."parents" (id),
        ADD CONSTRAINT "positive_score" CHECK (score > 0),
        ENABLE ROW LEVEL SECURITY,
        FORCE ROW LEVEL SECURITY;
    `;

    await service.apply(desired, [SCHEMA], true);
    const state = await client.query(`
      SELECT
        relation.relrowsecurity,
        relation.relforcerowsecurity,
        (array_agg(constraint_name::text ORDER BY constraint_name)
          FILTER (WHERE constraint_name IS NOT NULL))::text[] as constraints
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN information_schema.table_constraints constraint_info
        ON constraint_info.table_schema = namespace.nspname
        AND constraint_info.table_name = relation.relname
      WHERE namespace.nspname = $1 AND relation.relname = 'children'
      GROUP BY relation.relrowsecurity, relation.relforcerowsecurity
    `, [SCHEMA]);
    expect(state.rows[0]).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
      constraints: expect.arrayContaining(["parent_fk", "positive_score"]),
    });
    expect(
      (await service.apply(desired, [SCHEMA], true, undefined, true)).hasChanges
    ).toBe(false);
  });

  test("rejects imperative policy and row-security mutations before database changes", async function () {
    const service = createTestSchemaService();
    const cases = [
      {
        sql: `${baseSchema} ALTER POLICY p ON "${SCHEMA}"."Order" USING (true);`,
        message: /ALTER POLICY.*imperative partial mutation/i,
      },
      {
        sql: `${baseSchema} ALTER TABLE "${SCHEMA}"."Order" DISABLE ROW LEVEL SECURITY;`,
        message: /omit ENABLE ROW LEVEL SECURITY/i,
      },
      {
        sql: `${baseSchema} ALTER TABLE "${SCHEMA}"."Order" NO FORCE ROW LEVEL SECURITY;`,
        message: /omit FORCE ROW LEVEL SECURITY/i,
      },
    ];

    for (const item of cases) {
      await expect(service.apply(item.sql, [SCHEMA], true)).rejects.toThrow(
        item.message
      );
      const schema = await client.query(
        "SELECT to_regnamespace($1)::text as schema_name",
        [SCHEMA]
      );
      expect(schema.rows).toEqual([{ schema_name: null }]);
    }
  });
});
