import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteProvider } from "../../providers/sqlite";
import { SchemaService } from "../../core/schema/service";
import type { SQLiteConnectionConfig } from "../../providers/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("SQLite Edge Cases - Empty and Special", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-edge-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should handle empty schema", async () => {
    const schema = await provider.parseSchema("");
    expect(schema.tables).toHaveLength(0);
  });

  test("should handle table with single column", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].columns).toHaveLength(1);
  });

  test("should handle table with many columns", async () => {
    await schemaService.apply(`
      CREATE TABLE wide_table (
        id INTEGER PRIMARY KEY,
        col1 TEXT, col2 TEXT, col3 TEXT, col4 TEXT, col5 TEXT,
        col6 TEXT, col7 TEXT, col8 TEXT, col9 TEXT, col10 TEXT,
        col11 INTEGER, col12 INTEGER, col13 INTEGER, col14 REAL, col15 BLOB
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].columns).toHaveLength(16);
  });

  test("should handle quoted identifiers", async () => {
    await schemaService.apply(`
      CREATE TABLE "my table" (
        "my column" INTEGER PRIMARY KEY,
        "another column" TEXT
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].name).toBe("my table");
    expect(tables[0].columns[0].name).toBe("my column");
  });

  test("should handle underscores in names", async () => {
    await schemaService.apply(`
      CREATE TABLE user_accounts (
        user_id INTEGER PRIMARY KEY,
        first_name TEXT,
        last_name TEXT,
        email_address TEXT
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].name).toBe("user_accounts");
    expect(tables[0].columns.find(c => c.name === "first_name")).toBeDefined();
  });

  test("should handle numbers in names", async () => {
    await schemaService.apply(`
      CREATE TABLE table1 (
        id1 INTEGER PRIMARY KEY,
        value2 TEXT
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].name).toBe("table1");
  });

  test("should handle case insensitivity", async () => {
    await schemaService.apply(`
      CREATE TABLE MyTable (
        ID INTEGER PRIMARY KEY,
        Name TEXT
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables).toHaveLength(1);
  });
});

describe("SQLite Idempotency", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-idem-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should be idempotent with simple table", async () => {
    const schema = `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);`;

    await schemaService.apply(schema, ['public'], true);
    await schemaService.apply(schema, ['public'], true);
    await schemaService.apply(schema, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables).toHaveLength(1);
  });

  test("should be idempotent with foreign keys", async () => {
    const schema = `
      CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        FOREIGN KEY (parent_id) REFERENCES parents(id)
      );
    `;

    await schemaService.apply(schema, ['public'], true);
    await schemaService.apply(schema, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables).toHaveLength(2);
  });

  test("should be idempotent with indexes", async () => {
    const schema = `
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE INDEX idx_email ON users(email);
    `;

    await schemaService.apply(schema, ['public'], true);
    await schemaService.apply(schema, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].indexes?.filter(i => !i.constraint)).toHaveLength(1);
  });

  test("should be idempotent with NOT NULL columns", async () => {
    const schema = `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL
      );
    `;

    await schemaService.apply(schema, ['public'], true);
    await schemaService.apply(schema, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].columns.find(c => c.name === "email")?.nullable).toBe(false);
  });

  test("should be idempotent with defaults", async () => {
    const schema = `
      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
      );
    `;

    await schemaService.apply(schema, ['public'], true);
    await schemaService.apply(schema, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].columns.find(c => c.name === "count")?.default).toBe("0");
  });
});

describe("SQLite Multiple Tables", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-multi-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should handle multiple independent tables", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE products (id INTEGER PRIMARY KEY, title TEXT);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables).toHaveLength(3);
  });

  test("should handle adding a new table", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE posts (id INTEGER PRIMARY KEY);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables).toHaveLength(2);
  });

  test("should handle removing a table", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE posts (id INTEGER PRIMARY KEY);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("users");
  });

  test("should handle complex schema with relationships", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        author_id INTEGER NOT NULL,
        category_id INTEGER,
        FOREIGN KEY (author_id) REFERENCES users(id),
        FOREIGN KEY (category_id) REFERENCES categories(id)
      );
      CREATE TABLE comments (
        id INTEGER PRIMARY KEY,
        content TEXT NOT NULL,
        post_id INTEGER NOT NULL,
        author_id INTEGER NOT NULL,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
        FOREIGN KEY (author_id) REFERENCES users(id)
      );
      CREATE INDEX idx_posts_author ON posts(author_id);
      CREATE INDEX idx_comments_post ON comments(post_id);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables).toHaveLength(4);

    const posts = tables.find(t => t.name === "posts");
    expect(posts?.foreignKeys).toHaveLength(2);

    const comments = tables.find(t => t.name === "comments");
    expect(comments?.foreignKeys?.find(fk => fk.onDelete === "CASCADE")).toBeDefined();
  });
});

describe("SQLite Data Preservation", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-data-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should preserve data when adding column", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    `, ['public'], true);

    const client = await provider.createClient(config);
    await client.query(`INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob')`);
    await client.end();

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    `, ['public'], true);

    const client2 = await provider.createClient(config);
    const result = await client2.query<{id: number, name: string}>(`SELECT * FROM users ORDER BY id`);
    await client2.end();

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].name).toBe("Alice");
  });

  test("should preserve data during table recreation", async () => {
    await schemaService.apply(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price INTEGER);
    `, ['public'], true);

    const client = await provider.createClient(config);
    await client.query(`INSERT INTO items VALUES (1, 'Widget', 100), (2, 'Gadget', 200)`);
    await client.end();

    await schemaService.apply(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price REAL);
    `, ['public'], true);

    const client2 = await provider.createClient(config);
    const result = await client2.query<{id: number, name: string, price: number}>(`SELECT * FROM items ORDER BY id`);
    await client2.end();

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].name).toBe("Widget");
    expect(result.rows[0].price).toBe(100);
  });

  test("should preserve data when dropping column", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, temp TEXT, email TEXT);
    `, ['public'], true);

    const client = await provider.createClient(config);
    await client.query(`INSERT INTO users VALUES (1, 'Alice', 'x', 'alice@test.com')`);
    await client.end();

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);
    `, ['public'], true);

    const client2 = await provider.createClient(config);
    const result = await client2.query<{id: number, name: string, email: string}>(`SELECT * FROM users`);
    await client2.end();

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe("Alice");
    expect(result.rows[0].email).toBe("alice@test.com");
  });
});
