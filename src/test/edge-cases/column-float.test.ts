import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  createTestSchemaService,
  getTableColumnDetails,
} from "../utils";

describe("Edge case: float/real/double precision types", function () {
  let client: Client;
  let schemaService: ReturnType<typeof createTestSchemaService>;

  beforeEach(async function prepareDatabase() {
    client = await createTestClient();
    await cleanDatabase(client);
    schemaService = createTestSchemaService();
  });

  afterEach(async function cleanUpDatabase() {
    await cleanDatabase(client);
    await client?.end();
  });

  const schemaV1 = `
    CREATE TABLE users (
      c1 REAL,
      c2 DOUBLE PRECISION,
      c3 FLOAT(10),
      c4 FLOAT(30)
    );
  `;

  const schemaV2 = `
    CREATE TABLE users (
      c1 DOUBLE PRECISION,
      c2 REAL,
      c3 FLOAT(30),
      c4 FLOAT(10)
    );
  `;

  async function expectFloatColumnTypes(expectedTypes: string[]) {
    const columns = await getTableColumnDetails(client, "users");
    expect(columns.map(function (column) {
      return column.type;
    })).toEqual(expectedTypes);
  }

  async function getFloatObjectIdentities() {
    const result = await client.query(`
      SELECT 'public.float_precision_aliases'::regclass::oid::text AS table_oid,
             json_object_agg(type.typname, type.oid::text ORDER BY type.typname)
               AS type_oids
      FROM pg_type type
      WHERE type.typnamespace = 'public'::regnamespace
        AND type.typname IN (
          'float_precision_pair',
          'float_precision_real',
          'float_precision_double',
          'float_precision_range'
        )
    `);
    return result.rows;
  }

  test("v1: create and verify idempotency", async function () {
    await schemaService.apply(schemaV1, ["public"], true);

    await expectFloatColumnTypes([
      "real",
      "double precision",
      "real",
      "double precision",
    ]);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("v1->v2: apply changes and verify idempotency", async function () {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV2, ["public"]);
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV2, ["public"], true);

    await expectFloatColumnTypes([
      "double precision",
      "real",
      "double precision",
      "real",
    ]);

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });

  test("normalizes every documented float precision boundary", async function () {
    const schema = `
      CREATE TYPE float_precision_pair AS (
        low FLOAT(1),
        real_boundary FLOAT(24),
        double_boundary FLOAT(25),
        high FLOAT(53)
      );

      CREATE DOMAIN float_precision_real AS FLOAT(24);
      CREATE DOMAIN float_precision_double AS FLOAT(25);
      CREATE TYPE float_precision_range AS RANGE (subtype = FLOAT(25));

      CREATE TABLE float_precision_aliases (
        id INTEGER PRIMARY KEY,
        implicit_double FLOAT,
        low FLOAT(1),
        real_boundary FLOAT(24),
        double_boundary FLOAT(25),
        high FLOAT(53),
        bounded_real_array FLOAT(24)[2][3],
        bounded_double_array FLOAT(25)[4],
        pair_value float_precision_pair,
        real_domain_value float_precision_real,
        double_domain_value float_precision_double,
        range_value float_precision_range
      );
    `;

    await client.query(schema);
    await client.query("INSERT INTO float_precision_aliases (id) VALUES (1)");

    const tableTypes = await client.query(`
      SELECT attribute.attname AS name,
             format_type(attribute.atttypid, attribute.atttypmod) AS type
      FROM pg_attribute attribute
      WHERE attribute.attrelid = 'public.float_precision_aliases'::regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    `);
    expect(tableTypes.rows).toEqual([
      { name: "id", type: "integer" },
      { name: "implicit_double", type: "double precision" },
      { name: "low", type: "real" },
      { name: "real_boundary", type: "real" },
      { name: "double_boundary", type: "double precision" },
      { name: "high", type: "double precision" },
      { name: "bounded_real_array", type: "real[]" },
      { name: "bounded_double_array", type: "double precision[]" },
      { name: "pair_value", type: "float_precision_pair" },
      { name: "real_domain_value", type: "float_precision_real" },
      { name: "double_domain_value", type: "float_precision_double" },
      { name: "range_value", type: "float_precision_range" },
    ]);

    const compositeTypes = await client.query(`
      SELECT attribute.attname AS name,
             format_type(attribute.atttypid, attribute.atttypmod) AS type
      FROM pg_attribute attribute
      WHERE attribute.attrelid = 'public.float_precision_pair'::regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    `);
    expect(compositeTypes.rows).toEqual([
      { name: "low", type: "real" },
      { name: "real_boundary", type: "real" },
      { name: "double_boundary", type: "double precision" },
      { name: "high", type: "double precision" },
    ]);

    const dependentTypes = await client.query(`
      SELECT type.typname AS name,
             format_type(type.typbasetype, type.typtypmod) AS base_type
      FROM pg_type type
      WHERE type.typnamespace = 'public'::regnamespace
        AND type.typname IN ('float_precision_real', 'float_precision_double')
      UNION ALL
      SELECT type.typname AS name,
             format_type(range.rngsubtype, NULL) AS base_type
      FROM pg_range range
      JOIN pg_type type ON type.oid = range.rngtypid
      WHERE type.typnamespace = 'public'::regnamespace
        AND type.typname = 'float_precision_range'
      ORDER BY name
    `);
    expect(dependentTypes.rows).toEqual([
      { name: "float_precision_double", base_type: "double precision" },
      { name: "float_precision_range", base_type: "double precision" },
      { name: "float_precision_real", base_type: "real" },
    ]);

    const before = await getFloatObjectIdentities();

    expect((await schemaService.plan(schema, ["public"])).hasChanges).toBe(false);
    await schemaService.apply(schema, ["public"], true);

    const after = await getFloatObjectIdentities();
    expect(after).toEqual(before);
    expect(
      (await client.query("SELECT id FROM float_precision_aliases")).rows
    ).toEqual([{ id: 1 }]);
  });

  test("rejects float precision outside the documented range before mutation", async function () {
    const baseline = `
      CREATE TABLE float_precision_guard (
        id INTEGER
      );
    `;
    await schemaService.apply(baseline, ["public"], true);

    for (const precision of [0, 54]) {
      const invalid = `
        CREATE TABLE float_precision_guard (
          id INTEGER,
          pending TEXT
        );
        CREATE TABLE invalid_float_precision (
          value FLOAT(${precision})
        );
      `;

      await expect(
        schemaService.apply(invalid, ["public"], true)
      ).rejects.toThrow();

      const columns = await getTableColumnDetails(client, "float_precision_guard");
      expect(columns.map(function getColumnName(column) {
        return column.name;
      })).toEqual(["id"]);
      const invalidTable = await client.query(
        "SELECT to_regclass('public.invalid_float_precision') AS relation"
      );
      expect(invalidTable.rows).toEqual([{ relation: null }]);
    }
  });
});
