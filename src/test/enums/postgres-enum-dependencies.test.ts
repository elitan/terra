import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { DatabaseInspector } from "../../core/schema/inspector";
import { createTestClient, createTestSchemaService } from "../utils";

const SCHEMA = "enum_dependency_safety";
const OTHER_SCHEMA = "enum_dependency_safety_other";

const dependencySchema = `
  CREATE SCHEMA "${SCHEMA}";
  CREATE TYPE "${SCHEMA}"."mood" AS ENUM ('calm', 'busy');
  CREATE TABLE "${SCHEMA}"."events" (
    id integer,
    state "${SCHEMA}"."mood",
    states "${SCHEMA}"."mood"[]
  );
  CREATE TYPE "${SCHEMA}"."payload" AS (
    state "${SCHEMA}"."mood"
  );
  CREATE DOMAIN "${SCHEMA}"."mood_domain" AS "${SCHEMA}"."mood";
  CREATE TYPE "${SCHEMA}"."mood_range" AS RANGE (
    subtype = "${SCHEMA}"."mood"
  );
  CREATE FUNCTION "${SCHEMA}"."echo_mood"("${SCHEMA}"."mood")
  RETURNS "${SCHEMA}"."mood"
  LANGUAGE sql
  IMMUTABLE
  AS 'SELECT $1';
`;

describe("PostgreSQL enum dependency safety", function () {
  let client: Client;

  beforeEach(async function prepareSchemas() {
    client = await createTestClient();
    await client.query(`DROP SCHEMA IF EXISTS "${OTHER_SCHEMA}" CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  });

  afterEach(async function removeSchemas() {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS "${OTHER_SCHEMA}" CASCADE`);
    await client.end();
  });

  test("inspects relation, derived-type, routine, and unmodeled dependents", async function () {
    await client.query(dependencySchema);
    await client.query(
      `CREATE CAST ("${SCHEMA}"."mood" AS text) WITH INOUT AS ASSIGNMENT`
    );

    const inspector = new DatabaseInspector();
    const enums = await inspector.getCurrentEnums(client, [SCHEMA]);
    const mood = enums.find(function findMood(enumType) {
      return enumType.name === "mood";
    })!;

    expect(
      mood.attributeDependents?.map(function renderAttribute(dependent) {
        return `${dependent.schema}.${dependent.relation}.${dependent.attribute}`;
      })
    ).toEqual([
      `${SCHEMA}.events.state`,
      `${SCHEMA}.events.states`,
      `${SCHEMA}.payload.state`,
    ]);
    expect(mood.typeDependents).toEqual([
      { schema: SCHEMA, name: "mood_domain", kind: "domain" },
      { schema: SCHEMA, name: "mood_range", kind: "range" },
    ]);
    expect(mood.routineDependents).toEqual([
      {
        schema: SCHEMA,
        name: "echo_mood",
        kind: "function",
        identityArguments: `${SCHEMA}.mood`,
      },
    ]);
    expect(mood.catalogDependents).toEqual([
      {
        type: "cast",
        identity: `(${SCHEMA}.mood AS pg_catalog.text)`,
      },
    ]);
  });

  test("rejects retained managed dependents before database mutation", async function () {
    const service = createTestSchemaService();
    await service.apply(dependencySchema, [SCHEMA], true);

    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TABLE "${SCHEMA}"."events" (
        id integer,
        state "${SCHEMA}"."mood",
        states "${SCHEMA}"."mood"[]
      );
      CREATE TYPE "${SCHEMA}"."payload" AS (
        state "${SCHEMA}"."mood"
      );
      CREATE DOMAIN "${SCHEMA}"."mood_domain" AS "${SCHEMA}"."mood";
      CREATE TYPE "${SCHEMA}"."mood_range" AS RANGE (
        subtype = "${SCHEMA}"."mood"
      );
      CREATE FUNCTION "${SCHEMA}"."echo_mood"("${SCHEMA}"."mood")
      RETURNS "${SCHEMA}"."mood"
      LANGUAGE sql
      IMMUTABLE
      AS 'SELECT $1';
      CREATE TABLE "${SCHEMA}"."must_not_exist" (id integer);
    `;

    await expect(service.apply(desired, [SCHEMA], true)).rejects.toThrow(
      /enum .*mood.*events\.state.*payload\.state.*domain.*mood_domain.*range.*mood_range.*echo_mood/is
    );
    const newTable = await client.query(
      `SELECT to_regclass($1) AS relation`,
      [`${SCHEMA}.must_not_exist`]
    );
    expect(newTable.rows[0].relation).toBeNull();
  });

  test("removes a complete managed dependency graph in one apply", async function () {
    const service = createTestSchemaService();
    await service.apply(dependencySchema, [SCHEMA], true);

    await service.apply(`CREATE SCHEMA "${SCHEMA}";`, [SCHEMA], true);

    const remaining = await client.query(
      `SELECT to_regtype($1) AS type`,
      [`${SCHEMA}.mood`]
    );
    expect(remaining.rows[0].type).toBeNull();
  });

  test("reports retained defaults, constraints, and indexes before mutation", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."mood" AS ENUM ('calm', 'busy');
      CREATE TABLE "${SCHEMA}"."events" (
        id integer,
        state "${SCHEMA}"."mood" DEFAULT 'calm',
        CONSTRAINT "allowed_mood" CHECK (state <> 'busy')
      );
      CREATE INDEX "mood_partial_idx"
      ON "${SCHEMA}"."events" (id)
      WHERE state = 'calm';
    `;
    const desired = initial.replace(
      `CREATE TYPE "${SCHEMA}"."mood" AS ENUM ('calm', 'busy');`,
      ""
    );
    await service.apply(initial, [SCHEMA], true);

    await expect(service.apply(desired, [SCHEMA], true)).rejects.toThrow(
      /default value.*mood_partial_idx.*allowed_mood/is
    );
  });

  test("allows a managed column to stop using an enum before its removal", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."mood" AS ENUM ('calm', 'busy');
      CREATE TABLE "${SCHEMA}"."events" (
        id integer,
        state "${SCHEMA}"."mood" DEFAULT 'calm',
        CONSTRAINT "allowed_mood" CHECK (state <> 'busy')
      );
      CREATE INDEX "mood_partial_idx"
      ON "${SCHEMA}"."events" (id)
      WHERE state = 'calm';
    `;
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TABLE "${SCHEMA}"."events" (id integer);
    `;
    await service.apply(initial, [SCHEMA], true);
    await client.query(
      `INSERT INTO "${SCHEMA}"."events" (id, state) VALUES (7, 'calm')`
    );

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect([...plan.transactional, ...plan.concurrent].join("\n")).not.toMatch(
      /DROP INDEX/i
    );
    await service.apply(desired, [SCHEMA], true);

    const rows = await client.query(`SELECT * FROM "${SCHEMA}"."events"`);
    expect(rows.rows).toEqual([{ id: 7 }]);
    const remaining = await client.query(
      `SELECT to_regtype($1) AS type`,
      [`${SCHEMA}.mood`]
    );
    expect(remaining.rows[0].type).toBeNull();
  });

  test("allows a routine signature to stop using an enum before its removal", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."mood" AS ENUM ('calm', 'busy');
      CREATE FUNCTION "${SCHEMA}"."echo_value"("${SCHEMA}"."mood")
      RETURNS "${SCHEMA}"."mood"
      LANGUAGE sql
      IMMUTABLE
      AS 'SELECT $1';
    `;
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE FUNCTION "${SCHEMA}"."echo_value"(integer)
      RETURNS integer
      LANGUAGE sql
      IMMUTABLE
      AS 'SELECT $1';
    `;
    await service.apply(initial, [SCHEMA], true);

    await service.apply(desired, [SCHEMA], true);

    const routine = await client.query(
      `SELECT to_regprocedure($1) AS identity`,
      [`${SCHEMA}.echo_value(integer)`]
    );
    expect(routine.rows[0].identity).not.toBeNull();
    const remaining = await client.query(
      `SELECT to_regtype($1) AS type`,
      [`${SCHEMA}.mood`]
    );
    expect(remaining.rows[0].type).toBeNull();
  });

  test("recreates an index after its enum column auto-drops the old definition", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."mood" AS ENUM ('calm', 'busy');
      CREATE TABLE "${SCHEMA}"."events" (
        id integer,
        state "${SCHEMA}"."mood"
      );
      CREATE INDEX "mood_lookup_idx"
      ON "${SCHEMA}"."events" (id)
      WHERE state = 'calm';
    `;
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TABLE "${SCHEMA}"."events" (id integer);
      CREATE INDEX "mood_lookup_idx"
      ON "${SCHEMA}"."events" (id);
    `;
    await service.apply(initial, [SCHEMA], true);

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const sql = [...plan.transactional, ...plan.concurrent].join("\n");
    expect(sql).not.toMatch(/DROP INDEX/i);
    expect(sql).toMatch(/CREATE INDEX .*mood_lookup_idx/i);
    await service.apply(desired, [SCHEMA], true);

    const index = await client.query(
      `SELECT to_regclass($1) AS identity`,
      [`${SCHEMA}.mood_lookup_idx`]
    );
    expect(index.rows[0].identity).not.toBeNull();
    const remaining = await client.query(
      `SELECT to_regtype($1) AS type`,
      [`${SCHEMA}.mood`]
    );
    expect(remaining.rows[0].type).toBeNull();
  });

  test("rejects unmodeled catalog dependents with a stable identity", async function () {
    const service = createTestSchemaService();
    await service.apply(
      `
        CREATE SCHEMA "${SCHEMA}";
        CREATE TYPE "${SCHEMA}"."mood" AS ENUM ('calm', 'busy');
      `,
      [SCHEMA],
      true
    );
    await client.query(
      `CREATE CAST ("${SCHEMA}"."mood" AS text) WITH INOUT AS ASSIGNMENT`
    );

    await expect(
      service.apply(`CREATE SCHEMA "${SCHEMA}";`, [SCHEMA], true)
    ).rejects.toThrow(
      /cast.*enum_dependency_safety\.mood AS pg_catalog\.text/i
    );
    const remaining = await client.query(
      `SELECT to_regtype($1) AS type`,
      [`${SCHEMA}.mood`]
    );
    expect(remaining.rows[0].type).not.toBeNull();
  });

  test("rejects retained managed catalog objects it cannot coordinate", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."mood" AS ENUM ('calm', 'busy');
      CREATE TABLE "${SCHEMA}"."accounts" (state text);
      ALTER TABLE "${SCHEMA}"."accounts" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "mood_policy" ON "${SCHEMA}"."accounts"
      TO PUBLIC
      USING (state::"${SCHEMA}"."mood" = 'calm');
    `;
    const desired = initial.replace(
      `CREATE TYPE "${SCHEMA}"."mood" AS ENUM ('calm', 'busy');`,
      ""
    );
    await service.apply(initial, [SCHEMA], true);

    await expect(service.apply(desired, [SCHEMA], true)).rejects.toThrow(
      /policy mood_policy on enum_dependency_safety\.accounts/i
    );
  });

  test("rejects dependents in unmanaged schemas", async function () {
    const service = createTestSchemaService();
    await service.apply(
      `
        CREATE SCHEMA "${SCHEMA}";
        CREATE TYPE "${SCHEMA}"."mood" AS ENUM ('calm', 'busy');
      `,
      [SCHEMA],
      true
    );
    await client.query(`CREATE SCHEMA "${OTHER_SCHEMA}"`);
    await client.query(
      `CREATE TABLE "${OTHER_SCHEMA}"."external_events" (state "${SCHEMA}"."mood")`
    );

    await expect(
      service.apply(`CREATE SCHEMA "${SCHEMA}";`, [SCHEMA], true)
    ).rejects.toThrow(/enum_dependency_safety_other\.external_events\.state/i);
  });

  test("rejects catalog dependents owned by unmanaged schemas", async function () {
    const service = createTestSchemaService();
    await service.apply(
      `
        CREATE SCHEMA "${SCHEMA}";
        CREATE TYPE "${SCHEMA}"."mood" AS ENUM ('calm', 'busy');
      `,
      [SCHEMA],
      true
    );
    await client.query(`CREATE SCHEMA "${OTHER_SCHEMA}"`);
    await client.query(`
      CREATE TABLE "${OTHER_SCHEMA}"."external_events" (
        state text,
        CONSTRAINT "external_mood"
          CHECK (state::"${SCHEMA}"."mood" IS NOT NULL)
      )
    `);

    await expect(
      service.apply(`CREATE SCHEMA "${SCHEMA}";`, [SCHEMA], true)
    ).rejects.toThrow(
      /table constraint external_mood on enum_dependency_safety_other\.external_events/i
    );
  });
});
