import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteProvider } from "../../providers/sqlite";
import { SchemaService } from "../../core/schema/service";
import type { SQLiteConnectionConfig } from "../../providers/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("SQLite Column Types", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-cols-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should handle INTEGER type", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, val INTEGER);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "val")?.type).toBe("INTEGER");
  });

  test("should distinguish declared INT and INTEGER types", async function () {
    const schema = await provider.parseSchema(`
      CREATE TABLE declared_types (
        int_value int,
        integer_value INTEGER,
        text_value VARCHAR(255),
        tricky_integer_value FLOATING POINT,
        numeric_value STRING,
        untyped_value,
        any_value ANY
      );
      CREATE TABLE strict_types (
        int_value INT,
        integer_value INTEGER,
        any_value ANY
      ) STRICT;
    `);

    const declaredTypes = schema.tables.find(function (table) {
      return table.name === "declared_types";
    });
    const strictTypes = schema.tables.find(function (table) {
      return table.name === "strict_types";
    });
    expect(declaredTypes?.columns.map(function (column) {
      return column.type;
    })).toEqual([
      "INT",
      "INTEGER",
      "VARCHAR(255)",
      "FLOATING POINT",
      "STRING",
      "",
      "ANY",
    ]);
    expect(strictTypes?.columns.map(function (column) {
      return column.type;
    })).toEqual(["INT", "INTEGER", "ANY"]);
    expect(strictTypes?.strict).toBe(true);
  });

  test("should preserve STRICT and ordinary ANY behavior through recreation", async function () {
    const initialSchema = `
      CREATE TABLE flexible_values (
        id INTEGER PRIMARY KEY,
        value ANY,
        tricky_value FLOATING POINT,
        marker INTEGER
      );
      CREATE TABLE strict_values (
        id INTEGER PRIMARY KEY,
        value ANY,
        coerced_value INT,
        marker INTEGER
      ) STRICT;
    `;
    const recreatedSchema = initialSchema.replaceAll(
      "marker INTEGER",
      "marker TEXT"
    );

    await schemaService.apply(initialSchema, ["public"], true);
    const seedClient = await provider.createClient(config);
    await seedClient.query(`
      INSERT INTO flexible_values(value, tricky_value, marker)
      VALUES ('000123', '500.0', 1)
    `);
    await seedClient.query(`
      INSERT INTO strict_values(value, coerced_value, marker)
      VALUES ('000123', '500', 1)
    `);
    await expect(seedClient.query(`
      INSERT INTO strict_values(value, coerced_value, marker)
      VALUES ('kept', 'not-an-integer', 2)
    `)).rejects.toThrow();
    await seedClient.end();

    await schemaService.apply(recreatedSchema, ["public"], true);
    const client = await provider.createClient(config);
    const flexibleRows = await client.query(`
      SELECT
        typeof(value) AS value_type,
        quote(value) AS value_sql,
        typeof(tricky_value) AS tricky_type,
        quote(tricky_value) AS tricky_sql,
        typeof(marker) AS marker_type
      FROM flexible_values
    `);
    const strictRows = await client.query(`
      SELECT
        typeof(value) AS value_type,
        quote(value) AS value_sql,
        typeof(coerced_value) AS coerced_type,
        quote(coerced_value) AS coerced_sql,
        typeof(marker) AS marker_type
      FROM strict_values
    `);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(flexibleRows.rows).toEqual([{
      value_type: "integer",
      value_sql: "123",
      tricky_type: "integer",
      tricky_sql: "500",
      marker_type: "text",
    }]);
    expect(strictRows.rows).toEqual([{
      value_type: "text",
      value_sql: "'000123'",
      coerced_type: "integer",
      coerced_sql: "500",
      marker_type: "text",
    }]);
    expect(tables.find(function (table) {
      return table.name === "flexible_values";
    })?.columns.map(function (column) {
      return column.type;
    })).toEqual(["INTEGER", "ANY", "FLOATING POINT", "TEXT"]);
    expect(tables.find(function (table) {
      return table.name === "strict_values";
    })?.columns.map(function (column) {
      return column.type;
    })).toEqual(["INTEGER", "ANY", "INT", "TEXT"]);
    expect((await schemaService.plan(recreatedSchema)).hasChanges).toBe(false);
  });

  test("should handle TEXT type", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "val")?.type).toBe("TEXT");
  });

  test("should handle REAL type", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, val REAL);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "val")?.type).toBe("REAL");
  });

  test("should handle BLOB type", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, val BLOB);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "val")?.type).toBe("BLOB");
  });

  test("should handle NUMERIC type", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, val NUMERIC);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "val")?.type).toBe("NUMERIC");
  });

  test("should handle VARCHAR type", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, val VARCHAR(255));
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "val")?.type).toContain("VARCHAR");
  });

  test("should handle BOOLEAN as INTEGER", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, active BOOLEAN);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    const col = tables[0].columns.find(c => c.name === "active");
    expect(col).toBeDefined();
  });

  test("should handle multiple columns", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        age INTEGER,
        balance REAL,
        data BLOB
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns).toHaveLength(6);
  });
});

describe("SQLite Column Defaults", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-defaults-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should handle string default", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT DEFAULT 'pending');
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "status")?.default).toBe("'pending'");
  });

  test("should handle integer default", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, count INTEGER DEFAULT 0);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "count")?.default).toBe("0");
  });

  test("should handle real default", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, price REAL DEFAULT 9.99);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "price")?.default).toBe("9.99");
  });

  test("should handle NULL default", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, optional TEXT DEFAULT NULL);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "optional")?.default).toBe("NULL");
  });

  test("should handle CURRENT_TIMESTAMP default", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "created_at")?.default).toBe("CURRENT_TIMESTAMP");
  });

  test("should handle boolean default (0/1)", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, active INTEGER DEFAULT 1);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "active")?.default).toBe("1");
  });
});

describe("SQLite Column Nullability", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-null-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should handle NOT NULL column", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "name")?.nullable).toBe(false);
  });

  test("should handle nullable column", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "name")?.nullable).toBe(true);
  });

  test("should change nullable to NOT NULL via recreation", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "name")?.nullable).toBe(false);
  });

  test("should change NOT NULL to nullable via recreation", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "name")?.nullable).toBe(true);
  });

  test("should handle mix of nullable and NOT NULL", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        bio TEXT
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns.find(c => c.name === "name")?.nullable).toBe(false);
    expect(tables[0].columns.find(c => c.name === "email")?.nullable).toBe(false);
    expect(tables[0].columns.find(c => c.name === "phone")?.nullable).toBe(true);
    expect(tables[0].columns.find(c => c.name === "bio")?.nullable).toBe(true);
  });
});
