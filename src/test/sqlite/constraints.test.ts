import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteProvider } from "../../providers/sqlite";
import { SchemaService } from "../../core/schema/service";
import type { SQLiteConnectionConfig } from "../../providers/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("SQLite Primary Keys", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-pk-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should handle INTEGER PRIMARY KEY", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].primaryKey?.columns).toEqual(["id"]);
  });

  test("should handle composite primary key", async () => {
    await schemaService.apply(`
      CREATE TABLE t (
        a INTEGER,
        b INTEGER,
        c TEXT,
        PRIMARY KEY (a, b)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].primaryKey?.columns).toEqual(["a", "b"]);
  });

  test("should handle three-column primary key", async () => {
    await schemaService.apply(`
      CREATE TABLE t (
        year INTEGER,
        month INTEGER,
        day INTEGER,
        value REAL,
        PRIMARY KEY (year, month, day)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].primaryKey?.columns).toEqual(["year", "month", "day"]);
  });

  test("should handle TEXT primary key", async () => {
    await schemaService.apply(`
      CREATE TABLE t (code TEXT PRIMARY KEY, name TEXT);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].primaryKey?.columns).toEqual(["code"]);
  });
});

describe("SQLite Unique Constraints", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-unique-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should create unique index", async () => {
    await schemaService.apply(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT);
      CREATE UNIQUE INDEX idx_email ON t(email);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const uniqueIndexes = tables[0].indexes?.filter(i => i.unique) || [];
    expect(uniqueIndexes.length).toBeGreaterThanOrEqual(1);
  });

  test("should handle UNIQUE via index creation", async () => {
    await schemaService.apply(`
      CREATE TABLE t (
        id INTEGER PRIMARY KEY,
        email TEXT
      );
      CREATE UNIQUE INDEX idx_t_email ON t(email);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const idx = tables[0].indexes?.find(i => i.name === "idx_t_email");
    expect(idx?.unique).toBe(true);
  });

  test("should handle composite unique index", async () => {
    await schemaService.apply(`
      CREATE TABLE t (
        id INTEGER PRIMARY KEY,
        first_name TEXT,
        last_name TEXT
      );
      CREATE UNIQUE INDEX idx_name ON t(first_name, last_name);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const idx = tables[0].indexes?.find(i => i.name === "idx_name");
    expect(idx?.unique).toBe(true);
    expect(idx?.columns).toEqual(["first_name", "last_name"]);
  });

  test("should handle multiple unique indexes", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT,
        username TEXT
      );
      CREATE UNIQUE INDEX idx_email ON users(email);
      CREATE UNIQUE INDEX idx_username ON users(username);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const uniqueIndexes = tables[0].indexes?.filter(i => i.unique) || [];
    expect(uniqueIndexes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("SQLite Check Constraints", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-check-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should parse CHECK constraint", async () => {
    const schema = await provider.parseSchema(`
      CREATE TABLE t (
        id INTEGER PRIMARY KEY,
        age INTEGER CHECK (age >= 0)
      );
    `);

    expect(schema.tables[0].checkConstraints?.length).toBeGreaterThanOrEqual(1);
  });

  test("should handle range CHECK", async () => {
    await schemaService.apply(`
      CREATE TABLE t (
        id INTEGER PRIMARY KEY,
        score INTEGER CHECK (score >= 0 AND score <= 100)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].checkConstraints?.length).toBeGreaterThanOrEqual(1);
  });

  test("should handle string CHECK with IN", async () => {
    const schema = await provider.parseSchema(`
      CREATE TABLE t (
        id INTEGER PRIMARY KEY,
        status TEXT CHECK (status IN ('pending', 'active', 'closed'))
      );
    `);

    expect(schema.tables[0].checkConstraints?.length).toBeGreaterThanOrEqual(1);
  });

  test("should handle multiple CHECK constraints", async () => {
    await schemaService.apply(`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        price REAL CHECK (price > 0),
        quantity INTEGER CHECK (quantity >= 0),
        discount REAL CHECK (discount >= 0 AND discount <= 1)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    expect(tables[0].checkConstraints?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("SQLite Foreign Key Constraints", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-fk2-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should handle simple foreign key", async () => {
    await schemaService.apply(`
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES parents(id)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const children = tables.find(t => t.name === "children");
    expect(children?.foreignKeys).toHaveLength(1);
  });

  test("should handle ON DELETE SET NULL", async () => {
    await schemaService.apply(`
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE SET NULL
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const children = tables.find(t => t.name === "children");
    expect(children?.foreignKeys?.[0].onDelete).toBe("SET NULL");
  });

  test("should handle ON UPDATE CASCADE", async () => {
    await schemaService.apply(`
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        FOREIGN KEY (parent_id) REFERENCES parents(id) ON UPDATE CASCADE
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const children = tables.find(t => t.name === "children");
    expect(children?.foreignKeys?.[0].onUpdate).toBe("CASCADE");
  });

  test("should handle ON DELETE RESTRICT", async () => {
    await schemaService.apply(`
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE RESTRICT
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const children = tables.find(t => t.name === "children");
    expect(children?.foreignKeys?.[0].onDelete).toBe("RESTRICT");
  });

  test("should handle multiple foreign keys", async () => {
    await schemaService.apply(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE categories (id INTEGER PRIMARY KEY);
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        author_id INTEGER,
        category_id INTEGER,
        FOREIGN KEY (author_id) REFERENCES users(id),
        FOREIGN KEY (category_id) REFERENCES categories(id)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const posts = tables.find(t => t.name === "posts");
    expect(posts?.foreignKeys).toHaveLength(2);
  });

  test("should handle self-referential foreign key", async () => {
    await schemaService.apply(`
      CREATE TABLE employees (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        manager_id INTEGER,
        FOREIGN KEY (manager_id) REFERENCES employees(id)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client.end();

    const employees = tables.find(t => t.name === "employees");
    expect(employees?.foreignKeys?.[0].referencedTable).toBe("employees");
  });
});
