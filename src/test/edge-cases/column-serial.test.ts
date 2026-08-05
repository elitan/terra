import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  createTestSchemaService,
  getTableColumnDetails,
} from "../utils";

describe("Edge case: serial/bigserial columns", function () {
  let client: Client;
  let schemaService: ReturnType<typeof createTestSchemaService>;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    schemaService = createTestSchemaService();
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client?.end();
  });

  const schemaV1 = `
    CREATE TABLE t (
      x SMALLSERIAL,
      y SERIAL,
      z BIGSERIAL
    );
  `;

  const schemaV2 = `
    CREATE TABLE t (
      x SMALLINT,
      y BIGINT,
      z INTEGER
    );
  `;

  const schemaV3 = `
    CREATE TABLE t (
      x SMALLSERIAL,
      y SERIAL
    );
  `;

  async function getSerialColumns() {
    return getTableColumnDetails(client, "t");
  }

  test("v1: create and verify idempotency", async function () {
    await schemaService.apply(schemaV1, ["public"], true);

    const columns = await getSerialColumns();
    expect(columns.map(function (column) {
      return column.type;
    })).toEqual(["smallint", "integer", "bigint"]);
    expect(columns.map(function (column) {
      return column.default;
    })).toEqual([
      expect.stringMatching(/^nextval/),
      expect.stringMatching(/^nextval/),
      expect.stringMatching(/^nextval/),
    ]);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("rejects converting existing serial columns to plain integers before mutation", async function () {
    await schemaService.apply(schemaV1, ["public"], true);
    const before = await getSerialColumns();

    await expect(
      schemaService.apply(schemaV2, ["public"], true)
    ).rejects.toThrow(/serial pseudo-type transition.*not supported/i);

    expect(await getSerialColumns()).toEqual(before);
    for (const column of ["x", "y", "z"]) {
      const result = await client.query(
        "SELECT pg_get_serial_sequence('public.t', $1) AS sequence_name",
        [column]
      );
      expect(result.rows[0]?.sequence_name).not.toBeNull();
    }
  });

  test("rejects converting existing plain integers to serial before mutation", async function () {
    await schemaService.apply(schemaV2, ["public"], true);
    await client.query("INSERT INTO t (x, y, z) VALUES (1, 2, 3)");
    const before = await getSerialColumns();

    await expect(
      schemaService.apply(schemaV3, ["public"], true)
    ).rejects.toThrow(/serial pseudo-type transition.*not supported/i);

    expect(await getSerialColumns()).toEqual(before);
    expect((await client.query("SELECT x, y, z FROM t")).rows).toEqual([
      { x: 1, y: "2", z: 3 },
    ]);
  });

  test("rejects changing the size of an existing serial column", async function () {
    await schemaService.apply(schemaV1, ["public"], true);
    const before = await getSerialColumns();
    const desired = `
      CREATE TABLE t (
        x SERIAL,
        y SERIAL,
        z BIGSERIAL
      );
    `;

    await expect(
      schemaService.apply(desired, ["public"], true)
    ).rejects.toThrow(/serial pseudo-type transition.*not supported/i);

    expect(await getSerialColumns()).toEqual(before);
    const result = await client.query(
      "SELECT pg_get_serial_sequence('public.t', 'x') AS sequence_name"
    );
    expect(result.rows).toEqual([{ sequence_name: "public.t_x_seq" }]);
  });

  test("recognizes externally created serial columns idempotently", async function () {
    await client.query(`
      CREATE TABLE external_serial (
        x SMALLSERIAL,
        y SERIAL,
        z BIGSERIAL
      )
    `);

    const plan = await schemaService.plan(
      schemaV1.replaceAll("CREATE TABLE t", "CREATE TABLE external_serial"),
      ["public"]
    );
    expect(plan.hasChanges).toBe(false);
  });

  test("normalizes documented serial2 serial4 and serial8 aliases", async function () {
    const aliases = `
      CREATE TABLE serial_aliases (
        x SERIAL2,
        y SERIAL4,
        z SERIAL8
      );
    `;
    const canonical = `
      CREATE TABLE serial_aliases (
        x SMALLSERIAL,
        y SERIAL,
        z BIGSERIAL
      );
    `;

    await schemaService.apply(aliases, ["public"], true);

    const columns = await getTableColumnDetails(client, "serial_aliases");
    expect(columns.map(function getType(column) {
      return column.type;
    })).toEqual(["smallint", "integer", "bigint"]);
    expect(columns.map(function getNullable(column) {
      return column.nullable;
    })).toEqual([false, false, false]);
    expect(columns.map(function getDefault(column) {
      return column.default;
    })).toEqual([
      expect.stringMatching(/^nextval/),
      expect.stringMatching(/^nextval/),
      expect.stringMatching(/^nextval/),
    ]);

    expect((await schemaService.plan(aliases, ["public"])).hasChanges).toBe(false);
    expect((await schemaService.plan(canonical, ["public"])).hasChanges).toBe(false);
  });

  test("does not mistake a default containing nextval text for serial", async function () {
    await client.query(`
      CREATE TABLE misleading (
        id INTEGER NOT NULL DEFAULT length('nextval')
      )
    `);
    const desired = `CREATE TABLE misleading (id SERIAL);`;

    await expect(
      schemaService.apply(desired, ["public"], true)
    ).rejects.toThrow(/serial pseudo-type transition.*not supported/i);

    const result = await client.query(`
      SELECT
        pg_get_expr(defaults.adbin, defaults.adrelid) AS default_value,
        pg_get_serial_sequence('public.misleading', 'id') AS sequence_name
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_attrdef defaults
        ON defaults.adrelid = attribute.attrelid
        AND defaults.adnum = attribute.attnum
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'misleading'
        AND attribute.attname = 'id'
    `);
    expect(result.rows).toEqual([
      {
        default_value: "length('nextval'::text)",
        sequence_name: null,
      },
    ]);
  });

  test("does not mistake an unowned nextval default for serial", async function () {
    await client.query(`
      CREATE SEQUENCE detached_id_seq AS INTEGER;
      CREATE TABLE detached (
        id INTEGER NOT NULL DEFAULT nextval('detached_id_seq'::regclass)
      );
    `);

    await expect(
      schemaService.apply(
        "CREATE TABLE detached (id SERIAL);",
        ["public"],
        true
      )
    ).rejects.toThrow(/serial pseudo-type transition.*not supported/i);

    const result = await client.query(`
      SELECT
        pg_get_serial_sequence('public.detached', 'id') AS owned_sequence,
        nextval('detached_id_seq'::regclass) AS next_value
    `);
    expect(result.rows).toEqual([{ owned_sequence: null, next_value: "1" }]);
  });

  test("requires an owned sequence to match the serial integer type", async function () {
    await client.query(`
      CREATE TABLE mismatched_serial (id INTEGER NOT NULL);
      CREATE SEQUENCE mismatched_serial_id_seq AS BIGINT
        OWNED BY mismatched_serial.id;
      ALTER TABLE mismatched_serial
        ALTER COLUMN id SET DEFAULT nextval('mismatched_serial_id_seq'::regclass);
    `);

    await expect(
      schemaService.apply(
        "CREATE TABLE mismatched_serial (id SERIAL);",
        ["public"],
        true
      )
    ).rejects.toThrow(/serial pseudo-type transition.*not supported/i);

    const result = await client.query(`
      SELECT
        pg_get_serial_sequence('public.mismatched_serial', 'id') AS sequence_name,
        data_type
      FROM pg_sequences
      WHERE schemaname = 'public'
        AND sequencename = 'mismatched_serial_id_seq'
    `);
    expect(result.rows).toEqual([
      {
        sequence_name: "public.mismatched_serial_id_seq",
        data_type: "bigint",
      },
    ]);
  });

  test("requires the owned sequence to be the entire default expression", async function () {
    await client.query(`
      CREATE TABLE expression_serial (id SERIAL);
      ALTER TABLE expression_serial
        ALTER COLUMN id SET DEFAULT
          nextval('expression_serial_id_seq'::regclass) + 10;
    `);

    await expect(
      schemaService.apply(
        "CREATE TABLE expression_serial (id SERIAL);",
        ["public"],
        true
      )
    ).rejects.toThrow(/serial pseudo-type transition.*not supported/i);

    const result = await client.query(`
      SELECT
        pg_get_expr(defaults.adbin, defaults.adrelid) AS default_value,
        pg_get_serial_sequence('public.expression_serial', 'id') AS sequence_name
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_attrdef defaults
        ON defaults.adrelid = attribute.attrelid
        AND defaults.adnum = attribute.attnum
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'expression_serial'
        AND attribute.attname = 'id'
    `);
    expect(result.rows).toEqual([
      {
        default_value:
          "(nextval('expression_serial_id_seq'::regclass) + 10)",
        sequence_name: "public.expression_serial_id_seq",
      },
    ]);
  });

  test("adds a serial column to an existing table and reapplies idempotently", async function () {
    const initial = `CREATE TABLE add_serial (label TEXT NOT NULL);`;
    const desired = `
      CREATE TABLE add_serial (
        label TEXT NOT NULL,
        id SERIAL
      );
    `;
    await schemaService.apply(initial, ["public"], true);
    await schemaService.apply(desired, ["public"], true);
    await client.query("INSERT INTO add_serial (label) VALUES ('a'), ('b')");

    const result = await client.query(`
      SELECT
        array_agg(id ORDER BY id) AS ids,
        pg_get_serial_sequence('public.add_serial', 'id') AS sequence_name
      FROM add_serial
    `);
    expect(result.rows[0]?.ids).toEqual([1, 2]);
    expect(result.rows[0]?.sequence_name).toBe("public.add_serial_id_seq");

    const plan = await schemaService.plan(desired, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("removes a serial column and its owned sequence", async function () {
    await schemaService.apply(schemaV1, ["public"], true);
    await schemaService.apply(schemaV3, ["public"], true);

    expect((await getSerialColumns()).map(function (column) {
      return column.name;
    })).toEqual(["x", "y"]);
    const result = await client.query(
      "SELECT to_regclass('public.t_z_seq') AS sequence_name"
    );
    expect(result.rows).toEqual([{ sequence_name: null }]);
    expect((await schemaService.plan(schemaV3, ["public"])).hasChanges).toBe(false);
  });
});
