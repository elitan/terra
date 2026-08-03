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
    await client?.end();

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
    await client?.end();

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
    await client?.end();

    expect(tables[0].primaryKey?.columns).toEqual(["year", "month", "day"]);
  });

  test("should handle TEXT primary key", async () => {
    await schemaService.apply(`
      CREATE TABLE t (code TEXT PRIMARY KEY, name TEXT);
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

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
    await client?.end();

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
    await client?.end();

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
    await client?.end();

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
    await client?.end();

    const uniqueIndexes = tables[0].indexes?.filter(i => i.unique) || [];
    expect(uniqueIndexes.length).toBeGreaterThanOrEqual(2);
  });

  test("preserves inline UNIQUE constraints across the full lifecycle", async function () {
    const initialSql = `
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY,
        email TEXT UNIQUE,
        tenant TEXT NOT NULL,
        username TEXT NOT NULL,
        CONSTRAINT accounts_tenant_username_unique UNIQUE (tenant, username)
      );
    `;

    const parsed = await provider.parseSchema(initialSql);
    expect(parsed.tables[0].uniqueConstraints).toEqual([
      { columns: ["email"] },
      { columns: ["tenant", "username"] },
    ]);

    await schemaService.apply(initialSql, ["public"], true);
    expect((await schemaService.plan(initialSql, ["public"])).hasChanges).toBe(false);

    const seedClient = await provider.createClient(config);
    try {
      await seedClient.query(
        "INSERT INTO accounts (id, email, tenant, username) VALUES (1, 'one@example.com', 'acme', 'one')"
      );
      await expect(
        seedClient.query(
          "INSERT INTO accounts (id, email, tenant, username) VALUES (2, 'one@example.com', 'other', 'two')"
        )
      ).rejects.toThrow();
      await expect(
        seedClient.query(
          "INSERT INTO accounts (id, email, tenant, username) VALUES (3, 'three@example.com', 'acme', 'one')"
        )
      ).rejects.toThrow();
    } finally {
      await seedClient.end();
    }

    const recreationSql = initialSql.replace(
      "CONSTRAINT accounts_tenant_username_unique UNIQUE (tenant, username)",
      "CHECK (length(email) > 0),\n        CONSTRAINT accounts_tenant_username_unique UNIQUE (tenant, username)"
    );
    await schemaService.apply(recreationSql, ["public"], true);
    expect((await schemaService.plan(recreationSql, ["public"])).hasChanges).toBe(false);

    const recreatedClient = await provider.createClient(config);
    try {
      const rows = await recreatedClient.query<{ id: number; email: string }>(
        "SELECT id, email FROM accounts ORDER BY id"
      );
      expect(rows.rows).toEqual([{ id: 1, email: "one@example.com" }]);
      await expect(
        recreatedClient.query(
          "INSERT INTO accounts (id, email, tenant, username) VALUES (4, 'one@example.com', 'other', 'four')"
        )
      ).rejects.toThrow();
    } finally {
      await recreatedClient.end();
    }

    const removalSql = recreationSql.replace("email TEXT UNIQUE", "email TEXT");
    await schemaService.apply(removalSql, ["public"], true);
    expect((await schemaService.plan(removalSql, ["public"])).hasChanges).toBe(false);

    const removalClient = await provider.createClient(config);
    try {
      await removalClient.query(
        "INSERT INTO accounts (id, email, tenant, username) VALUES (5, 'one@example.com', 'other', 'five')"
      );
      const tables = await provider.getCurrentSchema(removalClient);
      expect(tables[0].uniqueConstraints).toEqual([
        { columns: ["tenant", "username"] },
      ]);
    } finally {
      await removalClient.end();
    }

    await expect(
      schemaService.apply(recreationSql, ["public"], true)
    ).rejects.toThrow();

    const rollbackClient = await provider.createClient(config);
    try {
      const duplicateRows = await rollbackClient.query<{ id: number }>(
        "SELECT id FROM accounts WHERE email = 'one@example.com' ORDER BY id"
      );
      expect(duplicateRows.rows).toEqual([{ id: 1 }, { id: 5 }]);

      const tempTables = await rollbackClient.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_accounts_new'"
      );
      expect(tempTables.rows).toEqual([]);
    } finally {
      await rollbackClient.end();
    }
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
    await client?.end();

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
    await client?.end();

    expect(tables[0].checkConstraints?.length).toBeGreaterThanOrEqual(3);
  });

  test("preserves nested CHECK expressions through apply and reapply", async function () {
    const desiredSql = `
      CREATE TABLE measurements (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        value INTEGER,
        CHECK (length(trim(label)) > 0 AND instr(label, ')') = 0),
        CHECK ((value IS NULL) OR (abs(value) <= 100))
      );
    `;

    const parsed = await provider.parseSchema(desiredSql);
    expect(parsed.tables[0].checkConstraints).toEqual([
      { expression: "length(trim(label)) > 0 AND instr(label, ')') = 0" },
      { expression: "(value IS NULL) OR (abs(value) <= 100)" },
    ]);

    const firstPlan = await schemaService.apply(desiredSql, ["public"], true);
    expect(firstPlan.hasChanges).toBe(true);

    const secondPlan = await schemaService.plan(desiredSql, ["public"]);
    expect(secondPlan.hasChanges).toBe(false);

    const client = await provider.createClient(config);
    try {
      const tables = await provider.getCurrentSchema(client);
      expect(tables[0].checkConstraints).toEqual(parsed.tables[0].checkConstraints);

      await client.query(
        "INSERT INTO measurements (id, label, value) VALUES (1, 'valid', 100)"
      );
      await expect(
        client.query(
          "INSERT INTO measurements (id, label, value) VALUES (2, 'invalid)', 101)"
        )
      ).rejects.toThrow();
    } finally {
      await client.end();
    }

    const expandedSql = desiredSql.replace("abs(value) <= 100", "abs(value) <= 200");
    const alterationPlan = await schemaService.apply(expandedSql, ["public"], true);
    expect(alterationPlan.hasChanges).toBe(true);

    const alteredClient = await provider.createClient(config);
    try {
      const rows = await alteredClient.query<{ id: number; label: string; value: number }>(
        "SELECT id, label, value FROM measurements ORDER BY id"
      );
      expect(rows.rows).toEqual([{ id: 1, label: "valid", value: 100 }]);

      await alteredClient.query(
        "INSERT INTO measurements (id, label, value) VALUES (3, 'expanded', 200)"
      );
      await expect(
        alteredClient.query(
          "INSERT INTO measurements (id, label, value) VALUES (4, 'too-large', 201)"
        )
      ).rejects.toThrow();
    } finally {
      await alteredClient.end();
    }

    const finalPlan = await schemaService.plan(expandedSql, ["public"]);
    expect(finalPlan.hasChanges).toBe(false);
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
    await client?.end();

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
    await client?.end();

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
    await client?.end();

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
    await client?.end();

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
    await client?.end();

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
    await client?.end();

    const employees = tables.find(t => t.name === "employees");
    expect(employees?.foreignKeys?.[0].referencedTable).toBe("employees");
  });
});
