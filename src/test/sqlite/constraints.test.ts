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
      { columns: ["email"], collations: ["BINARY"] },
      {
        columns: ["tenant", "username"],
        collations: ["BINARY", "BINARY"],
      },
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
        {
          columns: ["tenant", "username"],
          collations: ["BINARY", "BINARY"],
        },
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

  test("should normalize equivalent immediate foreign key declarations", async function () {
    const immediateSchema = `
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        FOREIGN KEY (parent_id) REFERENCES parents(id)
      );
    `;
    await schemaService.apply(immediateSchema, ["public"], true);

    const immediateClauses = [
      "NOT DEFERRABLE INITIALLY DEFERRED",
      "NOT DEFERRABLE INITIALLY IMMEDIATE",
      "NOT DEFERRABLE",
      "DEFERRABLE INITIALLY IMMEDIATE",
      "DEFERRABLE",
    ];
    for (const clause of immediateClauses) {
      const explicitImmediateSchema = immediateSchema.replace(
        "REFERENCES parents(id)",
        `REFERENCES parents(id) ${clause}`
      );
      const plan = await schemaService.plan(
        explicitImmediateSchema,
        ["public"]
      );
      expect(plan.hasChanges).toBe(false);
    }

    const externalClient = await provider.createClient(config);
    await externalClient.query("DROP TABLE children");
    await externalClient.query(`
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        FOREIGN KEY (parent_id) REFERENCES parents(id)
          NOT DEFERRABLE INITIALLY DEFERRED
      )
    `);
    await externalClient.end();
    expect((await schemaService.plan(immediateSchema, ["public"])).hasChanges)
      .toBe(false);
  });

  test("should inspect alter enforce and reapply deferred foreign keys", async function () {
    const immediateSchema = `
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        FOREIGN KEY (parent_id) REFERENCES parents(id)
      );
    `;
    const deferredSchema = immediateSchema.replace(
      "REFERENCES parents(id)",
      "REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED"
    );

    const parsed = await provider.parseSchema(deferredSchema);
    const parsedChildren = parsed.tables.find(function (table) {
      return table.name === "children";
    });
    expect(parsedChildren?.foreignKeys?.[0]).toEqual(
      expect.objectContaining({
        deferrable: true,
        initiallyDeferred: true,
      })
    );

    await schemaService.apply(immediateSchema, ["public"], true);
    expect((await schemaService.plan(deferredSchema, ["public"])).hasChanges)
      .toBe(true);
    await schemaService.apply(deferredSchema, ["public"], true);

    const deferredClient = await provider.createClient(config);
    const deferredTables = await provider.getCurrentSchema(deferredClient);
    const inspectedChildren = deferredTables.find(function (table) {
      return table.name === "children";
    });
    expect(inspectedChildren?.foreignKeys?.[0]).toEqual(
      expect.objectContaining({
        deferrable: true,
        initiallyDeferred: true,
      })
    );

    await deferredClient.query("BEGIN");
    await deferredClient.query(
      "INSERT INTO children(id, parent_id) VALUES (1, 10)"
    );
    await deferredClient.query("INSERT INTO parents(id) VALUES (10)");
    await deferredClient.query("COMMIT");
    await deferredClient.end();

    expect((await schemaService.plan(deferredSchema, ["public"])).hasChanges)
      .toBe(false);
    await schemaService.apply(immediateSchema, ["public"], true);

    const immediateClient = await provider.createClient(config);
    const preservedRows = await immediateClient.query(
      "SELECT id, parent_id FROM children ORDER BY id"
    );
    expect(preservedRows.rows).toEqual([{ id: 1, parent_id: 10 }]);
    await immediateClient.query("BEGIN");
    await expect(
      immediateClient.query(
        "INSERT INTO children(id, parent_id) VALUES (3, 30)"
      )
    ).rejects.toThrow("FOREIGN KEY constraint failed");
    await immediateClient.query("ROLLBACK");
    await immediateClient.end();

    expect((await schemaService.plan(immediateSchema, ["public"])).hasChanges)
      .toBe(false);
  });

  test("should match mixed foreign key timing without pragma ordering assumptions", async function () {
    const schema = `
      CREATE TABLE parents (
        id INTEGER PRIMARY KEY,
        external_id TEXT UNIQUE
      );
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES parents(id)
          DEFERRABLE INITIALLY DEFERRED,
        parent_external_id TEXT,
        FOREIGN KEY (parent_external_id)
          REFERENCES parents(external_id) ON DELETE CASCADE
      );
    `;

    const parsed = await provider.parseSchema(schema);
    const children = parsed.tables.find(function (table) {
      return table.name === "children";
    });
    const deferred = children?.foreignKeys?.find(function (foreignKey) {
      return foreignKey.columns[0] === "parent_id";
    });
    const immediate = children?.foreignKeys?.find(function (foreignKey) {
      return foreignKey.columns[0] === "parent_external_id";
    });

    expect(deferred).toEqual(expect.objectContaining({
      deferrable: true,
      initiallyDeferred: true,
    }));
    expect(immediate?.initiallyDeferred).toBeUndefined();
    expect(immediate?.onDelete).toBe("CASCADE");
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

  test("should resolve omitted parent primary-key columns through recreation", async function () {
    const shorthandSchema = `
      CREATE TABLE parents (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE regions (
        country TEXT NOT NULL,
        code TEXT NOT NULL,
        PRIMARY KEY (country, code)
      );
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        region_country TEXT,
        region_code TEXT,
        FOREIGN KEY (parent_id) REFERENCES parents,
        FOREIGN KEY (region_country, region_code) REFERENCES regions
      );
    `;
    const explicitSchema = shorthandSchema
      .replace("REFERENCES parents", "REFERENCES parents(id)")
      .replace(
        "REFERENCES regions",
        "REFERENCES regions(country, code)"
      );
    const parsed = await provider.parseSchema(shorthandSchema);
    const parsedChildren = parsed.tables.find(function (table) {
      return table.name === "children";
    });
    expect(parsedChildren?.foreignKeys).toEqual([
      expect.objectContaining({
        columns: ["region_country", "region_code"],
        referencedColumns: ["country", "code"],
      }),
      expect.objectContaining({
        columns: ["parent_id"],
        referencedColumns: ["id"],
      }),
    ]);

    await schemaService.apply(shorthandSchema, ["public"], true);
    expect((await schemaService.plan(explicitSchema, ["public"])).hasChanges)
      .toBe(false);

    const seedClient = await provider.createClient(config);
    await seedClient.query("INSERT INTO parents(id, name) VALUES (1, 'one')");
    await seedClient.query(
      "INSERT INTO regions(country, code) VALUES ('SE', 'AB')"
    );
    await seedClient.query(`
      INSERT INTO children(
        id,
        parent_id,
        region_country,
        region_code
      ) VALUES (1, 1, 'SE', 'AB')
    `);
    await seedClient.end();

    const recreatedSchema = explicitSchema.replace(
      "parent_id INTEGER",
      "parent_id TEXT"
    );
    await schemaService.apply(recreatedSchema, ["public"], true);

    const client = await provider.createClient(config);
    const rows = await client.query(`
      SELECT id, parent_id, region_country, region_code
      FROM children
      ORDER BY id
    `);
    const foreignKeyCheck = await client.query("PRAGMA foreign_key_check");
    await expect(
      client.query(`
        INSERT INTO children(
          id,
          parent_id,
          region_country,
          region_code
        ) VALUES (2, 999, 'SE', 'AB')
      `)
    ).rejects.toThrow("FOREIGN KEY constraint failed");
    await client.end();

    expect(rows.rows).toEqual([
      {
        id: 1,
        parent_id: "1",
        region_country: "SE",
        region_code: "AB",
      },
    ]);
    expect(foreignKeyCheck.rows).toEqual([]);
    expect((await schemaService.plan(recreatedSchema, ["public"])).hasChanges)
      .toBe(false);
  });

  test("should reject omitted parent keys with mismatched cardinality", async function () {
    const parsed = await provider.parseSchema(`
      CREATE TABLE parents (
        tenant TEXT NOT NULL,
        id INTEGER NOT NULL,
        PRIMARY KEY (tenant, id)
      );
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        FOREIGN KEY (parent_id) REFERENCES parents
      );
    `);
    expect(provider.validateSchema(parsed).errors).toContainEqual(
      expect.objectContaining({
        code: "SQLITE_FOREIGN_KEY_TARGET_KEY_MISMATCH",
        object: "children.parent_id",
      })
    );
  });

  test("should preserve valid unique foreign key parents through recreation", async function () {
    const initialSchema = `
      CREATE TABLE parents (
        id INTEGER PRIMARY KEY,
        external_id TEXT COLLATE NOCASE NOT NULL,
        tenant TEXT NOT NULL,
        code TEXT NOT NULL,
        payload INTEGER,
        UNIQUE (tenant, code)
      );
      CREATE UNIQUE INDEX parents_external_id
      ON parents(external_id);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_external_id TEXT REFERENCES parents(external_id),
        tenant TEXT,
        code TEXT,
        FOREIGN KEY (code, tenant) REFERENCES parents(code, tenant)
      );
    `;
    await schemaService.apply(initialSchema, ["public"], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(`
      INSERT INTO parents(id, external_id, tenant, code, payload)
      VALUES (1, 'Parent-A', 'acme', 'one', 42)
    `);
    await seedClient.query(`
      INSERT INTO children(id, parent_external_id, tenant, code)
      VALUES (1, 'parent-a', 'acme', 'one')
    `);
    await seedClient.end();

    const recreatedSchema = initialSchema.replace(
      "payload INTEGER",
      "payload TEXT"
    );
    await schemaService.apply(recreatedSchema, ["public"], true);

    const client = await provider.createClient(config);
    const parentRows = await client.query(`
      SELECT id, external_id, tenant, code, payload
      FROM parents
      ORDER BY id
    `);
    const foreignKeyCheck = await client.query("PRAGMA foreign_key_check");
    await expect(
      client.query(`
        INSERT INTO children(id, parent_external_id, tenant, code)
        VALUES (2, 'missing', 'acme', 'one')
      `)
    ).rejects.toThrow("FOREIGN KEY constraint failed");
    await client.end();

    expect(parentRows.rows).toEqual([
      {
        id: 1,
        external_id: "Parent-A",
        tenant: "acme",
        code: "one",
        payload: "42",
      },
    ]);
    expect(foreignKeyCheck.rows).toEqual([]);
    expect((await schemaService.plan(recreatedSchema, ["public"])).hasChanges)
      .toBe(false);
  });

  test("should reject invalid foreign key parents before database mutation", async function () {
    const invalidSchema = `
      CREATE TABLE surrounding_table (id INTEGER PRIMARY KEY);
      CREATE TABLE parents (external_id TEXT);
      CREATE TABLE children (
        parent_external_id TEXT REFERENCES parents(external_id)
      );
    `;

    await expect(
      schemaService.apply(invalidSchema, ["public"], true)
    ).rejects.toThrow("Schema validation failed");

    const client = await provider.createClient(config);
    const tables = await client.query<{ name: string }>(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);
    await client.end();
    expect(tables.rows).toEqual([]);
  });

  test("should treat explicit MATCH SIMPLE as the SQLite default", async function () {
    const defaultSchema = `
      CREATE TABLE parents (
        tenant TEXT NOT NULL,
        id INTEGER NOT NULL,
        PRIMARY KEY (tenant, id)
      );
      CREATE TABLE children (
        tenant TEXT,
        parent_id INTEGER,
        FOREIGN KEY (tenant, parent_id)
          REFERENCES parents(tenant, id)
      );
    `;
    const explicitSimpleSchema = defaultSchema.replace(
      "REFERENCES parents(tenant, id)",
      "REFERENCES parents(tenant, id) MATCH SIMPLE"
    );
    const client = await provider.createClient(config);
    for (const statement of defaultSchema.split(";")) {
      if (statement.trim()) {
        await client.query(statement);
      }
    }
    await client.end();

    expect(
      (await schemaService.plan(explicitSimpleSchema, ["public"])).hasChanges
    ).toBe(false);
    expect((await schemaService.plan(defaultSchema, ["public"])).hasChanges)
      .toBe(false);
  });

  test("should reject unsupported MATCH modes before database mutation", async function () {
    const matchFullSchema = `
      CREATE TABLE surrounding_table (id INTEGER PRIMARY KEY);
      CREATE TABLE parents (
        tenant TEXT NOT NULL,
        id INTEGER NOT NULL,
        PRIMARY KEY (tenant, id)
      );
      CREATE TABLE children (
        tenant TEXT,
        parent_id INTEGER,
        FOREIGN KEY (tenant, parent_id)
          REFERENCES parents(tenant, id) MATCH FULL
      );
    `;

    await expect(
      schemaService.apply(matchFullSchema, ["public"], true)
    ).rejects.toThrow("Schema validation failed");

    const client = await provider.createClient(config);
    const tables = await client.query<{ name: string }>(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);
    await client.end();
    expect(tables.rows).toEqual([]);
  });
});
