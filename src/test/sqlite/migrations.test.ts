import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteProvider } from "../../providers/sqlite";
import { SchemaService } from "../../core/schema/service";
import type { SQLiteConnectionConfig } from "../../providers/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("SQLite Schema Evolution", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-evolve-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should evolve schema through multiple versions", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].columns).toHaveLength(3);
    expect(tables[0].columns.find(c => c.name === "name")?.nullable).toBe(false);
    expect(tables[0].columns.find(c => c.name === "email")?.nullable).toBe(false);
  });

  test("should add and remove tables", async () => {
    await schemaService.apply(`
      CREATE TABLE a (id INTEGER PRIMARY KEY);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE a (id INTEGER PRIMARY KEY);
      CREATE TABLE b (id INTEGER PRIMARY KEY);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE a (id INTEGER PRIMARY KEY);
      CREATE TABLE b (id INTEGER PRIMARY KEY);
      CREATE TABLE c (id INTEGER PRIMARY KEY);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE b (id INTEGER PRIMARY KEY);
      CREATE TABLE c (id INTEGER PRIMARY KEY);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables).toHaveLength(2);
    expect(tables.find(t => t.name === "a")).toBeUndefined();
    expect(tables.find(t => t.name === "b")).toBeDefined();
    expect(tables.find(t => t.name === "c")).toBeDefined();
  });

  test("should rename column by recreation", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, fname TEXT);
    `, ['public'], true);

    const client = await provider.createClient(config);
    await client.query(`INSERT INTO users VALUES (1, 'Alice')`);
    await client.end();

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, first_name TEXT);
    `, ['public'], true);

    const client2 = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client2);
    const result = await client2.query(`SELECT * FROM users`);
    await client2.end();

    expect(tables[0].columns.find(c => c.name === "first_name")).toBeDefined();
    expect(tables[0].columns.find(c => c.name === "fname")).toBeUndefined();
  });

  test("should handle reordered columns in schema definition", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, c TEXT, b TEXT, a TEXT);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].columns.find(c => c.name === "a")).toBeDefined();
    expect(tables[0].columns.find(c => c.name === "b")).toBeDefined();
    expect(tables[0].columns.find(c => c.name === "c")).toBeDefined();
  });
});

describe("SQLite Index Evolution", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-idx-evolve-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should add index to existing table", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE INDEX idx_email ON users(email);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].indexes?.find(i => i.name === "idx_email")).toBeDefined();
  });

  test("should remove index", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE INDEX idx_email ON users(email);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].indexes?.find(i => i.name === "idx_email")).toBeUndefined();
  });

  test("should change index definition", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT);
      CREATE INDEX idx_search ON users(email);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT);
      CREATE INDEX idx_search ON users(email, name);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const idx = tables[0].indexes?.find(i => i.name === "idx_search");
    expect(idx?.columns).toEqual(["email", "name"]);
  });

  test("should convert regular index to unique", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE INDEX idx_email ON users(email);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE UNIQUE INDEX idx_email ON users(email);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const idx = tables[0].indexes?.find(i => i.name === "idx_email");
    expect(idx?.unique).toBe(true);
  });
});

describe("SQLite Foreign Key Evolution", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-fk-evolve-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should add foreign key to existing table", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const posts = tables.find(t => t.name === "posts");
    expect(posts?.foreignKeys).toHaveLength(1);
  });

  test("should remove foreign key", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const posts = tables.find(t => t.name === "posts");
    expect(posts?.foreignKeys || []).toHaveLength(0);
  });

  test("should change ON DELETE action", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const posts = tables.find(t => t.name === "posts");
    expect(posts?.foreignKeys?.[0].onDelete).toBe("CASCADE");
  });
});

describe("SQLite Complex Migrations", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-complex-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should handle multiple changes in one migration", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        author_id INTEGER,
        FOREIGN KEY (author_id) REFERENCES users(id)
      );
      CREATE TABLE comments (
        id INTEGER PRIMARY KEY,
        post_id INTEGER NOT NULL,
        body TEXT NOT NULL,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_posts_author ON posts(author_id);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables).toHaveLength(3);

    const users = tables.find(t => t.name === "users");
    expect(users?.columns).toHaveLength(4);
    expect(users?.columns.find(c => c.name === "name")?.nullable).toBe(false);

    const posts = tables.find(t => t.name === "posts");
    expect(posts?.foreignKeys).toHaveLength(1);
    expect(posts?.indexes?.find(i => i.name === "idx_posts_author")).toBeDefined();

    const comments = tables.find(t => t.name === "comments");
    expect(comments?.foreignKeys?.[0].onDelete).toBe("CASCADE");
  });

  test("should handle complete schema replacement", async () => {
    await schemaService.apply(`
      CREATE TABLE old_users (id INTEGER PRIMARY KEY, legacy_name TEXT);
      CREATE TABLE old_posts (id INTEGER PRIMARY KEY, old_title TEXT);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE articles (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables).toHaveLength(2);
    expect(tables.find(t => t.name === "users")).toBeDefined();
    expect(tables.find(t => t.name === "articles")).toBeDefined();
    expect(tables.find(t => t.name === "old_users")).toBeUndefined();
    expect(tables.find(t => t.name === "old_posts")).toBeUndefined();
  });
});
