import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { DatabaseInspector } from "../../core/schema/inspector";
import { createTestClient, createTestSchemaService } from "../utils";

const SCHEMA = "type_catalog_safety";
const OTHER_SCHEMA = "type_catalog_safety_other";

const managedCatalogSchema = `
  CREATE SCHEMA "${SCHEMA}";
  CREATE DOMAIN "${SCHEMA}"."positive_id" AS integer CHECK (VALUE > 0);
  CREATE TYPE "${SCHEMA}"."int_span" AS RANGE (subtype = integer);
  CREATE TYPE "${SCHEMA}"."payload" AS (value integer);
  CREATE TABLE "${SCHEMA}"."accounts" (state text);
  ALTER TABLE "${SCHEMA}"."accounts" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "domain_policy" ON "${SCHEMA}"."accounts"
  USING (((state::integer)::"${SCHEMA}"."positive_id") > 0);
  CREATE POLICY "range_policy" ON "${SCHEMA}"."accounts"
  USING ('[1,2)'::"${SCHEMA}"."int_span" IS NOT NULL);
  CREATE POLICY "composite_policy" ON "${SCHEMA}"."accounts"
  USING (ROW(state::integer)::"${SCHEMA}"."payload" IS NOT NULL);
  CREATE FUNCTION "${SCHEMA}"."keep_new_row"()
  RETURNS trigger
  LANGUAGE plpgsql
  AS 'BEGIN RETURN NEW; END';
  CREATE TRIGGER "domain_trigger"
  BEFORE INSERT ON "${SCHEMA}"."accounts"
  FOR EACH ROW
  WHEN (((NEW.state::integer)::"${SCHEMA}"."positive_id") > 0)
  EXECUTE FUNCTION "${SCHEMA}"."keep_new_row"();
`;

describe("PostgreSQL custom type catalog dependency safety", function () {
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

  test("inspects machine-readable catalog dependents for every custom type family", async function () {
    await client.query(managedCatalogSchema);
    await client.query(
      `CREATE CAST ("${SCHEMA}"."positive_id" AS text) WITH INOUT AS ASSIGNMENT`
    );
    await client.query(
      `CREATE CAST ("${SCHEMA}"."int_span" AS text) WITH INOUT AS ASSIGNMENT`
    );
    await client.query(
      `CREATE CAST ("${SCHEMA}"."payload" AS text) WITH INOUT AS ASSIGNMENT`
    );

    const inspector = new DatabaseInspector();
    const sqlObjects = await inspector.getCurrentSqlObjects(client, [SCHEMA]);
    const compositeTypes = await inspector.getCurrentCompositeTypes(client, [
      SCHEMA,
    ]);
    const domain = sqlObjects.find(function findDomain(object) {
      return object.key === `domain-type:${SCHEMA}.positive_id`;
    });
    const range = sqlObjects.find(function findRange(object) {
      return object.key === `range-type:${SCHEMA}.int_span`;
    });
    const composite = compositeTypes.find(function findComposite(type) {
      return type.name === "payload";
    });

    expect(domain?.catalogDependents).toEqual([
      {
        type: "cast",
        identity: `(${SCHEMA}.positive_id AS pg_catalog.text)`,
      },
      {
        type: "policy",
        name: "domain_policy",
        identity: `domain_policy on ${SCHEMA}.accounts`,
        ownerSchema: SCHEMA,
        ownerRelation: "accounts",
        ownerRelationKind: "r",
      },
      {
        type: "trigger",
        name: "domain_trigger",
        identity: `domain_trigger on ${SCHEMA}.accounts`,
        ownerSchema: SCHEMA,
        ownerRelation: "accounts",
        ownerRelationKind: "r",
      },
    ]);
    expect(range?.catalogDependents).toEqual([
      {
        type: "cast",
        identity: `(${SCHEMA}.int_span AS pg_catalog.text)`,
      },
      {
        type: "policy",
        name: "range_policy",
        identity: `range_policy on ${SCHEMA}.accounts`,
        ownerSchema: SCHEMA,
        ownerRelation: "accounts",
        ownerRelationKind: "r",
      },
    ]);
    expect(composite?.catalogDependents).toEqual([
      {
        type: "cast",
        identity: `(${SCHEMA}.payload AS pg_catalog.text)`,
      },
      {
        type: "policy",
        name: "composite_policy",
        identity: `composite_policy on ${SCHEMA}.accounts`,
        ownerSchema: SCHEMA,
        ownerRelation: "accounts",
        ownerRelationKind: "r",
      },
    ]);
  });

  test("rejects retained managed policies during planning", async function () {
    const service = createTestSchemaService();
    await service.apply(managedCatalogSchema, [SCHEMA], true);
    const desired = managedCatalogSchema
      .replace(
        `CREATE DOMAIN "${SCHEMA}"."positive_id" AS integer CHECK (VALUE > 0);`,
        ""
      )
      .replace(
        `CREATE TYPE "${SCHEMA}"."int_span" AS RANGE (subtype = integer);`,
        ""
      )
      .replace(
        `CREATE TYPE "${SCHEMA}"."payload" AS (value integer);`,
        ""
      );

    await expect(
      service.apply(desired, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/policy .*_policy on type_catalog_safety\.accounts/i);
  });

  test("rejects unmanaged constraint dependents during planning", async function () {
    const service = createTestSchemaService();
    await service.apply(
      `
        CREATE SCHEMA "${SCHEMA}";
        CREATE DOMAIN "${SCHEMA}"."positive_id" AS integer;
        CREATE TYPE "${SCHEMA}"."int_span" AS RANGE (subtype = integer);
        CREATE TYPE "${SCHEMA}"."payload" AS (value integer);
      `,
      [SCHEMA],
      true
    );
    await client.query(`CREATE SCHEMA "${OTHER_SCHEMA}"`);
    await client.query(`
      CREATE TABLE "${OTHER_SCHEMA}"."external_values" (
        value integer,
        CONSTRAINT "domain_guard"
          CHECK (value::"${SCHEMA}"."positive_id" IS NOT NULL),
        CONSTRAINT "range_guard"
          CHECK (value <@ '[1,2)'::"${SCHEMA}"."int_span"),
        CONSTRAINT "composite_guard"
          CHECK (ROW(value)::"${SCHEMA}"."payload" IS NOT NULL)
      )
    `);

    await expect(
      service.apply(`CREATE SCHEMA "${SCHEMA}";`, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(
      /table constraint .*_guard on type_catalog_safety_other\.external_values/i
    );
  });

  test("protects composite routine signatures before mutation", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."payload" AS (value integer);
      CREATE FUNCTION "${SCHEMA}"."echo_payload"("${SCHEMA}"."payload")
      RETURNS "${SCHEMA}"."payload"
      LANGUAGE sql
      IMMUTABLE
      AS 'SELECT $1';
    `;
    const desired = initial.replace(
      `CREATE TYPE "${SCHEMA}"."payload" AS (value integer);`,
      ""
    );
    await service.apply(initial, [SCHEMA], true);

    await expect(
      service.apply(desired, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/function type_catalog_safety\.echo_payload/i);
  });

  test("rejects retained managed triggers during planning", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."positive_id" AS integer;
      CREATE TABLE "${SCHEMA}"."accounts" (value integer);
      CREATE FUNCTION "${SCHEMA}"."keep_new_row"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS 'BEGIN RETURN NEW; END';
      CREATE TRIGGER "domain_trigger"
      BEFORE INSERT ON "${SCHEMA}"."accounts"
      FOR EACH ROW
      WHEN ((NEW.value::"${SCHEMA}"."positive_id") > 0)
      EXECUTE FUNCTION "${SCHEMA}"."keep_new_row"();
    `;
    const desired = initial.replace(
      `CREATE DOMAIN "${SCHEMA}"."positive_id" AS integer;`,
      ""
    );
    await service.apply(initial, [SCHEMA], true);

    await expect(
      service.apply(desired, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(
      /trigger domain_trigger on type_catalog_safety\.accounts/i
    );
  });

  test("rejects unowned catalog dependents during type replacement", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."positive_id" AS integer;
    `;
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."positive_id" AS bigint;
    `;
    await service.apply(initial, [SCHEMA], true);
    await client.query(
      `CREATE CAST ("${SCHEMA}"."positive_id" AS text) WITH INOUT AS ASSIGNMENT`
    );

    await expect(
      service.apply(desired, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(
      /cast \(type_catalog_safety\.positive_id AS pg_catalog\.text\)/i
    );
  });

  test("coordinates policy removal before dropping all custom type families", async function () {
    const service = createTestSchemaService();
    await service.apply(managedCatalogSchema, [SCHEMA], true);
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TABLE "${SCHEMA}"."accounts" (state text);
    `;

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const sql = [...plan.transactional, ...plan.concurrent].join("\n");
    expect(sql).toMatch(/DROP POLICY/i);
    expect(sql).toMatch(/DROP TRIGGER/i);
    expect(sql).toMatch(/DROP (?:DOMAIN|TYPE)/i);

    await service.apply(desired, [SCHEMA], true);

    const remaining = await client.query(
      `SELECT to_regtype(type_name) AS type
       FROM unnest($1::text[]) type_name`,
      [[`${SCHEMA}.positive_id`, `${SCHEMA}.int_span`, `${SCHEMA}.payload`]]
    );
    expect(remaining.rows).toEqual([{ type: null }, { type: null }, { type: null }]);
  });
});
