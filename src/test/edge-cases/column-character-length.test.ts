import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
  getTableColumnDetails,
} from "../utils";

describe("Edge case: character and bit length modifiers", function () {
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

  test("preserves documented boundaries and internal char identity", async function () {
    const schema = `
      CREATE TYPE length_boundary_pair AS (
        character_min VARCHAR(1),
        character_max CHAR(10485760),
        bit_min BIT(1),
        bit_max VARBIT(83886080),
        internal_value "char"
      );
      CREATE DOMAIN max_character_domain AS VARCHAR(10485760);
      CREATE DOMAIN internal_char_domain AS "char";
      CREATE TYPE internal_char_range AS RANGE (subtype = "char");
      CREATE TABLE length_boundary_partitions (
        key VARCHAR(1),
        payload BIT(83886080)
      ) PARTITION BY RANGE (key);
      CREATE TABLE length_boundary_records (
        id INTEGER PRIMARY KEY,
        varchar_min VARCHAR(1),
        varchar_max VARCHAR(10485760),
        char_min CHAR(1),
        char_max CHAR(10485760),
        bit_min BIT(1),
        bit_max BIT(83886080),
        varbit_min VARBIT(1),
        varbit_max VARBIT(83886080),
        unbounded_bpchar BPCHAR,
        unbounded_varchar VARCHAR,
        unbounded_varbit VARBIT,
        bounded_char_array VARCHAR(10485760)[2][3],
        bounded_bit_array VARBIT(83886080)[4],
        internal_value "char",
        internal_values "char"[],
        pair_value length_boundary_pair,
        character_domain_value max_character_domain,
        internal_domain_value internal_char_domain,
        internal_range_value internal_char_range
      );
      CREATE FUNCTION echo_internal_char(value "char")
      RETURNS "char"
      LANGUAGE SQL
      IMMUTABLE
      AS $$ SELECT value $$;
      CREATE PROCEDURE consume_internal_char(value "char")
      LANGUAGE plpgsql
      AS $$ BEGIN PERFORM value; END $$;
    `;

    await schemaService.apply(schema, ["public"], true);
    await client.query(`
      INSERT INTO length_boundary_records (
        id,
        varchar_min,
        bit_min,
        varbit_min,
        unbounded_bpchar,
        unbounded_varchar,
        unbounded_varbit,
        internal_value,
        internal_values
      ) VALUES (
        1,
        'å',
        B'1',
        B'0',
        'blank padded  ',
        'variable text',
        B'10101',
        'a'::"char",
        ARRAY['b'::"char", 'c'::"char"]
      )
    `);
    await client.query("CALL consume_internal_char('x'::\"char\")");

    const columns = await client.query(`
      SELECT attribute.attname AS name,
             format_type(attribute.atttypid, attribute.atttypmod) AS type
      FROM pg_attribute attribute
      WHERE attribute.attrelid = 'public.length_boundary_records'::regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    `);
    expect(columns.rows).toEqual([
      { name: "id", type: "integer" },
      { name: "varchar_min", type: "character varying(1)" },
      { name: "varchar_max", type: "character varying(10485760)" },
      { name: "char_min", type: "character(1)" },
      { name: "char_max", type: "character(10485760)" },
      { name: "bit_min", type: "bit(1)" },
      { name: "bit_max", type: "bit(83886080)" },
      { name: "varbit_min", type: "bit varying(1)" },
      { name: "varbit_max", type: "bit varying(83886080)" },
      { name: "unbounded_bpchar", type: "bpchar" },
      { name: "unbounded_varchar", type: "character varying" },
      { name: "unbounded_varbit", type: "bit varying" },
      { name: "bounded_char_array", type: "character varying(10485760)[]" },
      { name: "bounded_bit_array", type: "bit varying(83886080)[]" },
      { name: "internal_value", type: '"char"' },
      { name: "internal_values", type: '"char"[]' },
      { name: "pair_value", type: "length_boundary_pair" },
      { name: "character_domain_value", type: "max_character_domain" },
      { name: "internal_domain_value", type: "internal_char_domain" },
      { name: "internal_range_value", type: "internal_char_range" },
    ]);

    const dependentTypes = await client.query(`
      SELECT 'composite' AS kind,
             attribute.attname AS name,
             format_type(attribute.atttypid, attribute.atttypmod) AS type
      FROM pg_attribute attribute
      WHERE attribute.attrelid = 'public.length_boundary_pair'::regclass
        AND attribute.attnum > 0
      UNION ALL
      SELECT 'domain', type.typname,
             format_type(type.typbasetype, type.typtypmod)
      FROM pg_type type
      WHERE type.typnamespace = 'public'::regnamespace
        AND type.typname IN ('max_character_domain', 'internal_char_domain')
      UNION ALL
      SELECT 'range', type.typname, format_type(range.rngsubtype, NULL)
      FROM pg_range range
      JOIN pg_type type ON type.oid = range.rngtypid
      WHERE type.typnamespace = 'public'::regnamespace
        AND type.typname = 'internal_char_range'
      ORDER BY kind, name
    `);
    expect(dependentTypes.rows).toEqual([
      { kind: "composite", name: "bit_max", type: "bit varying(83886080)" },
      { kind: "composite", name: "bit_min", type: "bit(1)" },
      { kind: "composite", name: "character_max", type: "character(10485760)" },
      { kind: "composite", name: "character_min", type: "character varying(1)" },
      { kind: "composite", name: "internal_value", type: '"char"' },
      { kind: "domain", name: "internal_char_domain", type: '"char"' },
      { kind: "domain", name: "max_character_domain", type: "character varying(10485760)" },
      { kind: "range", name: "internal_char_range", type: '"char"' },
    ]);

    const identitiesBefore = await client.query(`
      SELECT 'public.length_boundary_records'::regclass::oid::text AS table_oid,
             'public.length_boundary_pair'::regtype::oid::text AS composite_oid,
             'public.internal_char_domain'::regtype::oid::text AS domain_oid,
             'public.internal_char_range'::regtype::oid::text AS range_oid,
             'public.echo_internal_char("char")'::regprocedure::oid::text AS function_oid,
             'public.consume_internal_char("char")'::regprocedure::oid::text AS procedure_oid
    `);
    expect(
      (await client.query("SELECT echo_internal_char('z'::\"char\")::text AS value"))
        .rows
    ).toEqual([{ value: "z" }]);

    expect((await schemaService.plan(schema, ["public"])).hasChanges).toBe(false);
    await schemaService.apply(schema, ["public"], true);

    const identitiesAfter = await client.query(`
      SELECT 'public.length_boundary_records'::regclass::oid::text AS table_oid,
             'public.length_boundary_pair'::regtype::oid::text AS composite_oid,
             'public.internal_char_domain'::regtype::oid::text AS domain_oid,
             'public.internal_char_range'::regtype::oid::text AS range_oid,
             'public.echo_internal_char("char")'::regprocedure::oid::text AS function_oid,
             'public.consume_internal_char("char")'::regprocedure::oid::text AS procedure_oid
    `);
    expect(identitiesAfter.rows).toEqual(identitiesBefore.rows);
    expect((await client.query(`
      SELECT id,
             varchar_min,
             bit_min::text,
             varbit_min::text,
             unbounded_bpchar::text,
             unbounded_varchar,
             unbounded_varbit::text,
             internal_value::text,
             internal_values::text
      FROM length_boundary_records
    `)).rows).toEqual([{
      id: 1,
      varchar_min: "å",
      bit_min: "1",
      varbit_min: "0",
      unbounded_bpchar: "blank padded",
      unbounded_varchar: "variable text",
      unbounded_varbit: "10101",
      internal_value: "a",
      internal_values: "{b,c}",
    }]);
  });

  test("rejects invalid lengths before mutation", async function () {
    const baseline = `CREATE TABLE length_guard (id INTEGER);`;
    await schemaService.apply(baseline, ["public"], true);

    for (const definition of [
      "VARCHAR(0)",
      "VARCHAR(10485761)",
      "CHAR(0)",
      "CHAR(10485761)",
      "BIT(0)",
      "BIT(83886081)",
      "VARBIT(0)",
      "VARBIT(83886081)",
      "BIT(foo)",
      "VARBIT(+1)",
      "BIT(1,2)",
    ]) {
      await expect(schemaService.plan(`
        CREATE TABLE length_guard (id INTEGER, pending TEXT);
        CREATE TABLE invalid_length (value ${definition});
      `, ["public"])).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(/(invalid length modifier|length.*between 1 and)/i),
      });
    }

    const guardColumns = await getTableColumnDetails(client, "length_guard");
    expect(guardColumns.map(function getColumnName(column) {
      return column.name;
    })).toEqual(["id"]);
  });

  test("rejects range subtype lengths that PostgreSQL does not retain", async function () {
    for (const definition of [
      "VARCHAR(5)",
      "CHAR(5)",
      "CHAR",
      "BIT(5)",
      "BIT",
      "VARBIT(5)",
    ]) {
      await expect(schemaService.plan(`
        CREATE TYPE constrained_length_range AS RANGE (
          subtype = ${definition}
        );
      `, ["public"])).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(/range subtype.*length modifier.*not retain/i),
      });
    }
  });
});
