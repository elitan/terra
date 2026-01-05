import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteProvider } from "../../providers/sqlite";
import { SchemaService } from "../../core/schema/service";
import type { SQLiteConnectionConfig } from "../../providers/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("SQLite Table Recreation", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-recreation-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {}
  });

  test("should recreate table when column type changes", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age INTEGER
      );
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age TEXT
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const ageCol = tables[0].columns.find(c => c.name === "age");
    expect(ageCol?.type).toBe("TEXT");
  });

  test("should recreate table when column is dropped", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT,
        email TEXT
      );
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].columns).toHaveLength(2);
    expect(tables[0].columns.find(c => c.name === "email")).toBeUndefined();
  });

  test("should preserve data during table recreation", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    await client.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`);
    await client.query(`INSERT INTO users (id, name) VALUES (2, 'Bob')`);
    await client.end();

    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      );
    `, ['public'], true);

    const client2 = await provider.createClient(config);
    const result = await client2.query<{id: number, name: string}>(`SELECT id, name FROM users ORDER BY id`);
    await client2.end();

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].name).toBe("Alice");
    expect(result.rows[1].name).toBe("Bob");
  });

  test("should recreate table when primary key changes", async () => {
    await schemaService.apply(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        code TEXT
      );
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE items (
        id INTEGER,
        code TEXT PRIMARY KEY
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].primaryKey?.columns).toEqual(["code"]);
  });

  test("should recreate table when foreign key is added", async () => {
    await schemaService.apply(`
      CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        name TEXT,
        category_id INTEGER,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const products = tables.find(t => t.name === "products");
    expect(products?.foreignKeys).toHaveLength(1);
    expect(products?.foreignKeys?.[0].referencedTable).toBe("categories");
  });
});
