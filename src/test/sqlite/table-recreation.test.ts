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
    await client?.end();

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
    await client?.end();

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
    await client?.end();

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

  test("should recreate referenced table with existing child rows", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age INTEGER
      );

      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `, ['public'], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(`INSERT INTO users (id, age) VALUES (1, 10)`);
    await seedClient.query(`INSERT INTO posts (id, user_id) VALUES (1, 1)`);
    await seedClient.end();

    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age TEXT
      );

      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const users = await client.query<{ id: number; age: string }>(`SELECT id, age FROM users ORDER BY id`);
    const posts = await client.query<{ id: number; user_id: number }>(`SELECT id, user_id FROM posts ORDER BY id`);
    const fkCheck = await client.query<{ table: string; rowid: number; parent: string; fkid: number }>(
      `PRAGMA foreign_key_check`
    );
    await client.end();

    expect(users.rows).toEqual([{ id: 1, age: "10" }]);
    expect(posts.rows).toEqual([{ id: 1, user_id: 1 }]);
    expect(fkCheck.rows).toEqual([]);
  });

  test("should enforce foreign keys after recreation migration", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age INTEGER
      );

      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `, ['public'], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(`INSERT INTO users (id, age) VALUES (1, 10)`);
    await seedClient.end();

    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age TEXT
      );

      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    await expect(
      client.query(`INSERT INTO posts (id, user_id) VALUES (2, 999)`)
    ).rejects.toThrow("FOREIGN KEY constraint failed");
    await client.end();
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
    await client?.end();

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
    await client?.end();

    const products = tables.find(t => t.name === "products");
    expect(products?.foreignKeys).toHaveLength(1);
    expect(products?.foreignKeys?.[0].referencedTable).toBe("categories");
  });

  test("should rollback failed recreation without leaking temp table", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT
      );
    `, ['public'], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(`INSERT INTO users (id, email) VALUES (1, NULL)`);
    await seedClient.end();

    await expect(
      schemaService.apply(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
      `, ['public'], true)
    ).rejects.toThrow("NOT NULL");

    const client = await provider.createClient(config);
    const tables = await client.query<{ name: string }>(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('users', '_users_new')
      ORDER BY name
    `);
    const rows = await client.query<{ id: number; email: string | null }>(
      `SELECT id, email FROM users ORDER BY id`
    );
    await client.end();

    expect(tables.rows).toEqual([{ name: "users" }]);
    expect(rows.rows).toEqual([{ id: 1, email: null }]);
  });
});
