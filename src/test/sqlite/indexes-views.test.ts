import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteProvider } from "../../providers/sqlite";
import { SchemaService } from "../../core/schema/service";
import type { SQLiteConnectionConfig } from "../../providers/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("SQLite Indexes", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-idx-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {}
  });

  test("should create index on table", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL
      );
      CREATE INDEX idx_users_email ON users(email);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const nonConstraintIndexes = tables[0].indexes?.filter(i => !i.constraint) || [];
    expect(nonConstraintIndexes).toHaveLength(1);
    expect(nonConstraintIndexes[0].name).toBe("idx_users_email");
  });

  test("should create unique index", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_users_email_unique ON users(email);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const idx = tables[0].indexes?.find(i => i.name === "idx_users_email_unique");
    expect(idx?.unique).toBe(true);
  });

  test("should create composite index", async () => {
    await schemaService.apply(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        status TEXT
      );
      CREATE INDEX idx_orders_user_status ON orders(user_id, status);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const idx = tables[0].indexes?.find(i => i.name === "idx_orders_user_status");
    expect(idx?.columns).toEqual(["user_id", "status"]);
  });

  test("should drop and recreate index", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE INDEX idx_users_email ON users(email);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE INDEX idx_users_email ON users(email);
      CREATE INDEX idx_users_id ON users(id);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const nonConstraintIndexes = tables[0].indexes?.filter(i => !i.constraint) || [];
    expect(nonConstraintIndexes).toHaveLength(2);
  });

  test("should be idempotent with indexes", async () => {
    const schema = `
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE INDEX idx_users_email ON users(email);
    `;

    await schemaService.apply(schema, ['public'], true);
    await schemaService.apply(schema, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables).toHaveLength(1);
    const nonConstraintIndexes = tables[0].indexes?.filter(i => !i.constraint) || [];
    expect(nonConstraintIndexes).toHaveLength(1);
  });
});

describe("SQLite Views", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-views-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {}
  });

  test("should parse view", async () => {
    const schema = await provider.parseSchema(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER);
      CREATE VIEW active_users AS SELECT id, name FROM users WHERE active = 1;
    `);

    expect(schema.views).toHaveLength(1);
    expect(schema.views[0].name).toBe("active_users");
  });

  test("should inspect existing views", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER);
    `, ['public'], true);

    const client = await provider.createClient(config);
    await client.query(`CREATE VIEW active_users AS SELECT id, name FROM users WHERE active = 1`);

    const views = await provider.getCurrentViews(client);
    await client.end();

    expect(views).toHaveLength(1);
    expect(views[0].name).toBe("active_users");
  });
});

describe("SQLite Foreign Keys", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-fk-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {}
  });

  test("should create tables with foreign keys", async () => {
    await schemaService.apply(`
      CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        author_id INTEGER NOT NULL,
        FOREIGN KEY (author_id) REFERENCES authors(id)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const books = tables.find(t => t.name === "books");
    expect(books?.foreignKeys).toHaveLength(1);
    expect(books?.foreignKeys?.[0].columns).toEqual(["author_id"]);
    expect(books?.foreignKeys?.[0].referencedTable).toBe("authors");
  });

  test("should handle ON DELETE CASCADE", async () => {
    await schemaService.apply(`
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const children = tables.find(t => t.name === "children");
    expect(children?.foreignKeys?.[0].onDelete).toBe("CASCADE");
  });

  test("should handle composite foreign keys", async () => {
    await schemaService.apply(`
      CREATE TABLE orders (
        order_id INTEGER,
        line_num INTEGER,
        product TEXT,
        PRIMARY KEY (order_id, line_num)
      );
      CREATE TABLE order_notes (
        id INTEGER PRIMARY KEY,
        order_id INTEGER,
        line_num INTEGER,
        note TEXT,
        FOREIGN KEY (order_id, line_num) REFERENCES orders(order_id, line_num)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const notes = tables.find(t => t.name === "order_notes");
    expect(notes?.foreignKeys?.[0].columns).toEqual(["order_id", "line_num"]);
    expect(notes?.foreignKeys?.[0].referencedColumns).toEqual(["order_id", "line_num"]);
  });
});
