import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { DatabaseInspector } from "../../core/schema/inspector";
import { getStatementRisk } from "../../utils/statement-classifier";
import { createTestClient, createTestSchemaService } from "../utils";

const SCHEMA = "domain_range_lifecycle";
const EXTERNAL_SCHEMA = "domain_range_external";

describe("PostgreSQL domain and range type lifecycle", function () {
  let client: Client;

  beforeEach(async function prepareSchema() {
    client = await createTestClient();
    await client.query(`DROP SCHEMA IF EXISTS "${EXTERNAL_SCHEMA}" CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  });

  afterEach(async function removeSchema() {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS "${EXTERNAL_SCHEMA}" CASCADE`);
    await client.end();
  });

  test("converges an externally created domain with complete metadata", async function () {
    const service = createTestSchemaService();
    await client.query(`
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."Localized Code"
        AS text COLLATE "C"
        DEFAULT 'unknown'
        CONSTRAINT "non_empty" CHECK (VALUE <> '')
        CHECK (length(VALUE) <= 20)
        NOT NULL
    `);
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."Localized Code"
        AS text COLLATE "C"
        DEFAULT 'unknown'
        CONSTRAINT "non_empty" CHECK (VALUE <> '')
        CHECK (length(VALUE) <= 20)
        NOT NULL;
    `;

    const inspected = await new DatabaseInspector().getCurrentSqlObjects(
      client,
      [SCHEMA]
    );
    const domain = inspected.find(function findDomain(object) {
      return object.key === `domain-type:${SCHEMA}.Localized Code`;
    });
    expect(domain?.createStatement).toContain('COLLATE "pg_catalog"."C"');

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(plan.hasChanges).toBe(false);
  });

  test("alters domain defaults, nullability, and constraints without losing rows", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."positive_code" AS integer DEFAULT 1
        CONSTRAINT "positive" CHECK (VALUE > 0);
      CREATE TABLE "${SCHEMA}"."records" (
        id integer PRIMARY KEY,
        code "${SCHEMA}"."positive_code"
      );
    `;
    const desired = initial
      .replace("DEFAULT 1", "DEFAULT 2")
      .replace(
        'CONSTRAINT "positive" CHECK (VALUE > 0)',
        'CONSTRAINT "non_negative" CHECK (VALUE >= 0) NOT NULL'
      );

    await service.apply(initial, [SCHEMA], true);
    await client.query(
      `INSERT INTO "${SCHEMA}"."records" (id, code) VALUES (1, 7)`
    );

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(plan.transactional).toContain(
      `ALTER DOMAIN "${SCHEMA}"."positive_code" SET DEFAULT 2;`
    );
    expect(plan.transactional).toContain(
      `ALTER DOMAIN "${SCHEMA}"."positive_code" SET NOT NULL;`
    );
    expect(plan.transactional).toContain(
      `ALTER DOMAIN "${SCHEMA}"."positive_code" DROP CONSTRAINT "positive" RESTRICT;`
    );
    expect(plan.transactional).toContain(
      `ALTER DOMAIN "${SCHEMA}"."positive_code" ADD CONSTRAINT "non_negative" CHECK (value >= 0);`
    );

    await service.apply(desired, [SCHEMA], true);
    const rows = await client.query(
      `SELECT id, code::integer FROM "${SCHEMA}"."records"`
    );
    expect(rows.rows).toEqual([{ id: 1, code: 7 }]);
    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("renames and validates an equivalent external domain constraint", async function () {
    const service = createTestSchemaService();
    await client.query(`
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."score" AS integer;
      ALTER DOMAIN "${SCHEMA}"."score"
        ADD CONSTRAINT "old_name" CHECK (VALUE >= 0) NOT VALID
    `);
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."score" AS integer
        CONSTRAINT "non_negative" CHECK (VALUE >= 0);
    `;

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(plan.transactional).toEqual([
      `ALTER DOMAIN "${SCHEMA}"."score" RENAME CONSTRAINT "old_name" TO "non_negative";`,
      `ALTER DOMAIN "${SCHEMA}"."score" VALIDATE CONSTRAINT "non_negative";`,
    ]);

    await service.apply(desired, [SCHEMA], true);
    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("matches duplicate domain checks without stealing desired names", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."score" AS integer
        CONSTRAINT "named_positive" CHECK (VALUE > 0)
        CHECK (VALUE > 0);
    `;
    const reordered = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."score" AS integer
        CHECK (VALUE > 0)
        CONSTRAINT "named_positive" CHECK (VALUE > 0);
    `;
    await service.apply(initial, [SCHEMA], true);

    const plan = await service.apply(
      reordered,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(plan.hasChanges).toBe(false);
  });

  test("rolls back earlier domain alterations when validation fails", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."score" AS integer DEFAULT 1
        CONSTRAINT "minimum" CHECK (VALUE >= 0);
      CREATE TABLE "${SCHEMA}"."records" (
        id integer PRIMARY KEY,
        score "${SCHEMA}"."score"
      );
    `;
    const invalid = initial
      .replace("DEFAULT 1", "DEFAULT 2")
      .replace("VALUE >= 0", "VALUE >= 10");
    await service.apply(initial, [SCHEMA], true);
    await client.query(
      `INSERT INTO "${SCHEMA}"."records" VALUES (1, 1)`
    );

    await expect(service.apply(invalid, [SCHEMA], true)).rejects.toThrow();

    const state = await client.query(`
      SELECT t.typdefault, pg_get_expr(c.conbin, 0) AS expression
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_constraint c ON c.contypid = t.oid
      WHERE n.nspname = $1 AND t.typname = 'score'
    `, [SCHEMA]);
    expect(state.rows).toEqual([
      { typdefault: "1", expression: "(VALUE >= 0)" },
    ]);
    const originalPlan = await service.apply(
      initial,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(originalPlan.hasChanges).toBe(false);
  });

  test("converges range defaults and preserves an explicit multirange name", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."price_window" AS RANGE (
        subtype = numeric,
        multirange_type_name = "Price Windows"
      );
    `;

    await service.apply(desired, [SCHEMA], true);
    const inspected = await new DatabaseInspector().getCurrentSqlObjects(
      client,
      [SCHEMA]
    );
    const range = inspected.find(function findRange(object) {
      return object.key === `range-type:${SCHEMA}.price_window`;
    });
    expect(range?.createStatement).toContain(
      'multirange_type_name = "public"."Price Windows"'
    );

    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);

    const explicitDefaultOpclass = desired.replace(
      "subtype = numeric,",
      "subtype = numeric,\n        subtype_opclass = pg_catalog.numeric_ops,"
    );
    const equivalentPlan = await service.apply(
      explicitDefaultOpclass,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(equivalentPlan.hasChanges).toBe(false);
  });

  test("converges range collation and subtype difference metadata", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."localized_window" AS RANGE (
        subtype = text,
        collation = "C"
      );
      CREATE TYPE "${SCHEMA}"."float_window" AS RANGE (
        subtype = double precision,
        subtype_diff = pg_catalog.float8mi
      );
    `;

    await service.apply(desired, [SCHEMA], true);
    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("replaces a range when its explicit multirange name changes", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."price_window" AS RANGE (
        subtype = numeric,
        multirange_type_name = "${SCHEMA}"."Old Windows"
      );
    `;
    const desired = initial.replace("Old Windows", "New Windows");
    await service.apply(initial, [SCHEMA], true);

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(plan.transactional).toContain(
      `DROP TYPE IF EXISTS "${SCHEMA}"."price_window" RESTRICT;`
    );
    expect(plan.transactional.join("\n")).toContain('"New Windows"');
    await service.apply(desired, [SCHEMA], true);
    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("replaces an unused type across domain and range families", async function () {
    const service = createTestSchemaService();
    const domain = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."number_window" AS int;
    `;
    const range = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."number_window" AS RANGE (subtype = int);
    `;

    await service.apply(domain, [SCHEMA], true);
    const rangePlan = await service.apply(
      range,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(rangePlan.transactional.slice(0, 2)).toEqual([
      `DROP DOMAIN IF EXISTS "${SCHEMA}"."number_window" RESTRICT;`,
      expect.stringContaining(
        `CREATE TYPE ${SCHEMA}.number_window AS RANGE`
      ),
    ]);
    await service.apply(range, [SCHEMA], true);

    const domainPlan = await service.apply(
      domain,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(domainPlan.transactional.slice(0, 2)).toEqual([
      `DROP TYPE IF EXISTS "${SCHEMA}"."number_window" RESTRICT;`,
      `CREATE DOMAIN ${SCHEMA}.number_window AS int;`,
    ]);
    await service.apply(domain, [SCHEMA], true);
    const secondPlan = await service.apply(
      domain,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("replaces an unused range in drop-before-create order without cascade", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."number_window" AS RANGE (subtype = integer);
    `;
    const desired = initial.replace("integer", "bigint");
    await service.apply(initial, [SCHEMA], true);

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const dropIndex = plan.transactional.findIndex(function findDrop(statement) {
      return statement === `DROP TYPE IF EXISTS "${SCHEMA}"."number_window" RESTRICT;`;
    });
    const createIndex = plan.transactional.findIndex(function findCreate(statement) {
      return statement.includes(".number_window AS RANGE");
    });
    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(dropIndex);
    expect(plan.transactional.join("\n")).not.toContain("CASCADE");
    expect(
      getStatementRisk(
        plan.transactional[dropIndex] || "",
        "transactional"
      )
    ).toBe("destructive");

    await expect(
      service.apply(desired, [SCHEMA], true, undefined, true, true)
    ).rejects.toThrow(/strict mode blocked/i);

    await service.apply(desired, [SCHEMA], true);
    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("replaces an unused domain base type and protects stored dependents", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."code" AS integer;
    `;
    const desired = initial.replace("integer", "bigint");
    await service.apply(initial, [SCHEMA], true);

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const dropIndex = plan.transactional.indexOf(
      `DROP DOMAIN IF EXISTS "${SCHEMA}"."code" RESTRICT;`
    );
    const createIndex = plan.transactional.findIndex(function findCreate(
      statement
    ) {
      return statement.startsWith(`CREATE DOMAIN ${SCHEMA}.code`);
    });
    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(dropIndex);
    await service.apply(desired, [SCHEMA], true);

    const withTable = `${desired}
      CREATE TABLE "${SCHEMA}"."records" (
        id integer PRIMARY KEY,
        code "${SCHEMA}"."code"
      );
    `;
    await service.apply(withTable, [SCHEMA], true);
    const incompatible = withTable.replace("AS bigint", "AS text");
    await expect(
      service.apply(incompatible, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/domain.*cannot be replaced.*records\.code/i);
  });

  test("rejects range replacement while stored columns depend on the type", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."number_window" AS RANGE (subtype = integer);
      CREATE TABLE "${SCHEMA}"."records" (
        id integer PRIMARY KEY,
        active "${SCHEMA}"."number_window"
      );
    `;
    await service.apply(initial, [SCHEMA], true);
    await client.query(`
      INSERT INTO "${SCHEMA}"."records" VALUES (1, '[1,5)'::"${SCHEMA}"."number_window")
    `);

    const desired = initial.replace("subtype = integer", "subtype = bigint");
    await expect(
      service.apply(desired, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/cannot be replaced.*records\.active/i);

    const rows = await client.query(
      `SELECT id, active::text FROM "${SCHEMA}"."records"`
    );
    expect(rows.rows).toEqual([{ id: 1, active: "[1,5)" }]);
  });

  test("detects array and multirange column dependencies", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."code" AS integer;
      CREATE TYPE "${SCHEMA}"."number_range" AS RANGE (subtype = integer);
      CREATE TABLE "${SCHEMA}"."records" (
        id integer PRIMARY KEY,
        codes "${SCHEMA}"."code"[],
        ranges "${SCHEMA}"."number_range"[],
        combined "${SCHEMA}"."number_multirange"
      );
    `;
    await service.apply(desired, [SCHEMA], true);

    await expect(
      service.apply(
        desired.replace('"code" AS integer', '"code" AS bigint'),
        [SCHEMA],
        true,
        undefined,
        true
      )
    ).rejects.toThrow(/records\.codes/);
    await expect(
      service.apply(
        desired.replace("subtype = integer", "subtype = bigint"),
        [SCHEMA],
        true,
        undefined,
        true
      )
    ).rejects.toThrow(/records\.(combined|ranges)/);
  });

  test("rejects domain validation that PostgreSQL cannot perform in containers", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."code" AS integer;
      CREATE TABLE "${SCHEMA}"."records" (
        id integer PRIMARY KEY,
        codes "${SCHEMA}"."code"[]
      );
    `;
    const constrained = initial.replace(
      '"code" AS integer;',
      '"code" AS integer CONSTRAINT "positive" CHECK (VALUE > 0) NOT NULL;'
    );
    await service.apply(initial, [SCHEMA], true);

    await expect(
      service.apply(constrained, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/cannot add or validate.*array, composite, or range/i);
    const state = await client.query(`
      SELECT t.typnotnull, count(c.oid)::integer AS constraint_count
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_constraint c ON c.contypid = t.oid AND c.contype = 'c'
      WHERE n.nspname = $1 AND t.typname = 'code'
      GROUP BY t.typnotnull
    `, [SCHEMA]);
    expect(state.rows).toEqual([
      { typnotnull: false, constraint_count: 0 },
    ]);
  });

  test("detects domains derived from type arrays and multiranges", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."code" AS integer;
      CREATE DOMAIN "${SCHEMA}"."code_list" AS "${SCHEMA}"."code"[];
      CREATE TYPE "${SCHEMA}"."number_range" AS RANGE (subtype = integer);
      CREATE DOMAIN "${SCHEMA}"."range_list" AS "${SCHEMA}"."number_range"[];
      CREATE DOMAIN "${SCHEMA}"."range_groups" AS "${SCHEMA}"."number_multirange";
    `;
    await service.apply(desired, [SCHEMA], true);

    await expect(
      service.apply(
        desired.replace('"code" AS integer', '"code" AS bigint'),
        [SCHEMA],
        true,
        undefined,
        true
      )
    ).rejects.toThrow(/domain.*code_list/i);
    await expect(
      service.apply(
        desired.replace("subtype = integer", "subtype = bigint"),
        [SCHEMA],
        true,
        undefined,
        true
      )
    ).rejects.toThrow(/domain.*(range_groups|range_list)/i);
  });

  test("protects retained routine signatures and orders coordinated removal", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."code" AS integer;
      CREATE FUNCTION "${SCHEMA}"."echo_code"(
        value "${SCHEMA}"."code"
      ) RETURNS "${SCHEMA}"."code"
      LANGUAGE sql IMMUTABLE
      AS $$ SELECT value $$;
    `;
    await service.apply(desired, [SCHEMA], true);

    const retainedRoutine = desired.replace(
      `      CREATE DOMAIN "${SCHEMA}"."code" AS integer;\n`,
      ""
    );
    await expect(
      service.apply(retainedRoutine, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/function.*echo_code/i);

    const empty = `CREATE SCHEMA "${SCHEMA}";`;
    const plan = await service.apply(
      empty,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const functionDrop = plan.transactional.findIndex(function findFunctionDrop(
      statement
    ) {
      return statement.startsWith(
        `DROP FUNCTION IF EXISTS "${SCHEMA}"."echo_code"`
      );
    });
    const domainDrop = plan.transactional.indexOf(
      `DROP DOMAIN IF EXISTS "${SCHEMA}"."code" RESTRICT;`
    );
    expect(functionDrop).toBeGreaterThanOrEqual(0);
    expect(domainDrop).toBeGreaterThan(functionDrop);
    await service.apply(empty, [SCHEMA], true);
  });

  test("protects an unmanaged derived domain during removal", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."code" AS integer;
    `;
    await service.apply(initial, [SCHEMA], true);
    await client.query(`
      CREATE SCHEMA "${EXTERNAL_SCHEMA}";
      CREATE DOMAIN "${EXTERNAL_SCHEMA}"."derived_code"
        AS "${SCHEMA}"."code";
    `);

    await expect(
      service.apply(`CREATE SCHEMA "${SCHEMA}";`, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/domain domain_range_external\.derived_code/i);
  });

  test("protects an unmanaged routine signature during removal", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."code" AS integer;
    `;
    await service.apply(initial, [SCHEMA], true);
    await client.query(`
      CREATE SCHEMA "${EXTERNAL_SCHEMA}";
      CREATE FUNCTION "${EXTERNAL_SCHEMA}"."echo_code"(
        value "${SCHEMA}"."code"
      ) RETURNS integer
      LANGUAGE sql IMMUTABLE
      AS $$ SELECT value::integer $$;
    `);

    await expect(
      service.apply(`CREATE SCHEMA "${SCHEMA}";`, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/function domain_range_external\.echo_code/i);
  });

  test("drops coordinated type dependents with restrict and protects retained ones", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."code" AS integer;
      CREATE TYPE "${SCHEMA}"."code_window" AS RANGE (
        subtype = "${SCHEMA}"."code"
      );
      CREATE TABLE "${SCHEMA}"."records" (
        id integer PRIMARY KEY,
        code "${SCHEMA}"."code",
        active "${SCHEMA}"."code_window"
      );
    `;
    await service.apply(desired, [SCHEMA], true);

    const retainedDomain = desired.replace(
      `      CREATE DOMAIN "${SCHEMA}"."code" AS integer;\n`,
      ""
    );
    await expect(
      service.apply(retainedDomain, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/domain.*code.*still use/i);

    const empty = `CREATE SCHEMA "${SCHEMA}";`;
    const plan = await service.apply(
      empty,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const domainDrop = plan.transactional.findIndex(function findDomainDrop(
      statement
    ) {
      return statement === `DROP DOMAIN IF EXISTS "${SCHEMA}"."code" RESTRICT;`;
    });
    const rangeDrop = plan.transactional.findIndex(function findRangeDrop(
      statement
    ) {
      return statement === `DROP TYPE IF EXISTS "${SCHEMA}"."code_window" RESTRICT;`;
    });
    const tableDrop = plan.transactional.findIndex(function findTableDrop(statement) {
      return statement.startsWith(`DROP TABLE "${SCHEMA}"."records"`);
    });
    expect(tableDrop).toBeGreaterThanOrEqual(0);
    expect(rangeDrop).toBeGreaterThan(tableDrop);
    expect(domainDrop).toBeGreaterThan(rangeDrop);

    await service.apply(empty, [SCHEMA], true);
    const remaining = await client.query(`
      SELECT typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1
        AND typname IN ('code', 'code_window')
    `, [SCHEMA]);
    expect(remaining.rows).toEqual([]);
  });

  test("orders domain and range creation by type dependencies", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."a_window" AS RANGE (
        subtype = "${SCHEMA}"."z_code"
      );
      CREATE DOMAIN "${SCHEMA}"."z_code" AS integer;
    `;

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const domainCreate = plan.transactional.findIndex(function findDomain(
      statement
    ) {
      return statement.startsWith(`CREATE DOMAIN ${SCHEMA}.z_code`);
    });
    const rangeCreate = plan.transactional.findIndex(function findRange(
      statement
    ) {
      return statement.startsWith(`CREATE TYPE ${SCHEMA}.a_window`);
    });
    expect(domainCreate).toBeGreaterThanOrEqual(0);
    expect(rangeCreate).toBeGreaterThan(domainCreate);

    await service.apply(desired, [SCHEMA], true);
    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("rejects cyclic type dependencies before creating their schema", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."first" AS "${SCHEMA}"."second";
      CREATE DOMAIN "${SCHEMA}"."second" AS "${SCHEMA}"."first";
    `;

    await expect(
      service.apply(desired, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/dependency cycle/i);
    const schema = await client.query(
      "SELECT to_regnamespace($1)::text as schema_name",
      [SCHEMA]
    );
    expect(schema.rows[0].schema_name).toBeNull();
  });

  test("rejects invalid range options before creating their schema", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."integer_window" AS RANGE (
        subtype = integer,
        subtype = bigint
      );
    `;

    await expect(service.apply(desired, [SCHEMA], true)).rejects.toThrow(
      /option 'subtype' more than once/i
    );
    const schema = await client.query(
      "SELECT to_regnamespace($1)::text as schema_name",
      [SCHEMA]
    );
    expect(schema.rows[0].schema_name).toBeNull();
  });

  test("rejects same-apply range support functions before mutation", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE FUNCTION "${SCHEMA}"."integer_diff"(left_value integer, right_value integer)
      RETURNS double precision
      LANGUAGE sql IMMUTABLE STRICT
      AS $$ SELECT (left_value - right_value)::double precision $$;
      CREATE TYPE "${SCHEMA}"."integer_window" AS RANGE (
        subtype = integer,
        subtype_diff = "${SCHEMA}"."integer_diff"
      );
    `;

    await expect(
      service.apply(desired, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/requires function.*exist before CREATE TYPE/i);
    const schema = await client.query(
      "SELECT to_regnamespace($1)::text as schema_name",
      [SCHEMA]
    );
    expect(schema.rows[0].schema_name).toBeNull();
  });
});
