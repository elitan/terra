import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteProvider } from "../../providers/sqlite";
import { SchemaService } from "../../core/schema/service";
import type { SQLiteConnectionConfig } from "../../providers/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("SQLite Unsupported Features Validation", () => {
  let provider: SQLiteProvider;

  beforeEach(() => {
    provider = new SQLiteProvider();
  });

  test("should reject ENUM types", () => {
    const schema = {
      tables: [],
      enums: [{ name: "status", values: ["active", "inactive"], schema: "public" }],
      views: [],
      functions: [],
      procedures: [],
      triggers: [],
      sequences: [],
      extensions: [],
      schemas: [],
      comments: [],
    };

    const result = provider.validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.find(e => e.code === "SQLITE_NO_ENUMS")).toBeDefined();
  });

  test("should reject sequences", () => {
    const schema = {
      tables: [],
      enums: [],
      views: [],
      functions: [],
      procedures: [],
      triggers: [],
      sequences: [{ name: "my_seq" }],
      extensions: [],
      schemas: [],
      comments: [],
    };

    const result = provider.validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.find(e => e.code === "SQLITE_NO_SEQUENCES")).toBeDefined();
  });

  test("should reject extensions", () => {
    const schema = {
      tables: [],
      enums: [],
      views: [],
      functions: [],
      procedures: [],
      triggers: [],
      sequences: [],
      extensions: [{ name: "postgis" }],
      schemas: [],
      comments: [],
    };

    const result = provider.validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.find(e => e.code === "SQLITE_NO_EXTENSIONS")).toBeDefined();
  });

  test("should reject stored functions", () => {
    const schema = {
      tables: [],
      enums: [],
      views: [],
      functions: [{
        name: "add_numbers",
        parameters: [],
        returnType: "INTEGER",
        language: "sql",
        body: "SELECT 1 + 2"
      }],
      procedures: [],
      triggers: [],
      sequences: [],
      extensions: [],
      schemas: [],
      comments: [],
    };

    const result = provider.validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.find(e => e.code === "SQLITE_NO_FUNCTIONS")).toBeDefined();
  });

  test("should reject stored procedures", () => {
    const schema = {
      tables: [],
      enums: [],
      views: [],
      functions: [],
      procedures: [{
        name: "do_something",
        parameters: [],
        language: "sql",
        body: "SELECT 1"
      }],
      triggers: [],
      sequences: [],
      extensions: [],
      schemas: [],
      comments: [],
    };

    const result = provider.validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.find(e => e.code === "SQLITE_NO_PROCEDURES")).toBeDefined();
  });

  test("should reject schemas", () => {
    const schema = {
      tables: [],
      enums: [],
      views: [],
      functions: [],
      procedures: [],
      triggers: [],
      sequences: [],
      extensions: [],
      schemas: [{ name: "myschema" }],
      comments: [],
    };

    const result = provider.validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.find(e => e.code === "SQLITE_NO_SCHEMAS")).toBeDefined();
  });

  test("should reject non-btree index types", () => {
    const schema = {
      tables: [{
        name: "t",
        columns: [{ name: "id", type: "INTEGER", nullable: false }],
        indexes: [{
          name: "idx",
          tableName: "t",
          columns: ["id"],
          type: "gin" as const,
        }],
      }],
      enums: [],
      views: [],
      functions: [],
      procedures: [],
      triggers: [],
      sequences: [],
      extensions: [],
      schemas: [],
      comments: [],
    };

    const result = provider.validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.find(e => e.code === "SQLITE_BTREE_ONLY")).toBeDefined();
  });

  test("should reject operator classes", () => {
    const schema = {
      tables: [{
        name: "t",
        columns: [{ name: "id", type: "INTEGER", nullable: false }],
        indexes: [{
          name: "idx",
          tableName: "t",
          columns: ["id"],
          opclasses: { id: "text_pattern_ops" },
        }],
      }],
      enums: [],
      views: [],
      functions: [],
      procedures: [],
      triggers: [],
      sequences: [],
      extensions: [],
      schemas: [],
      comments: [],
    };

    const result = provider.validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.find(e => e.code === "SQLITE_NO_OPCLASS")).toBeDefined();
  });

  test("should reject materialized views", () => {
    const schema = {
      tables: [],
      enums: [],
      views: [{
        name: "mv",
        definition: "SELECT 1",
        materialized: true,
      }],
      functions: [],
      procedures: [],
      triggers: [],
      sequences: [],
      extensions: [],
      schemas: [],
      comments: [],
    };

    const result = provider.validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.find(e => e.code === "SQLITE_NO_MATERIALIZED_VIEWS")).toBeDefined();
  });

  test("should accept valid schema", () => {
    const schema = {
      tables: [{
        name: "users",
        columns: [
          { name: "id", type: "INTEGER", nullable: false },
          { name: "name", type: "TEXT", nullable: false },
        ],
        primaryKey: { columns: ["id"] },
        indexes: [{
          name: "idx_name",
          tableName: "users",
          columns: ["name"],
          type: "btree" as const,
        }],
      }],
      enums: [],
      views: [{
        name: "active_users",
        definition: "SELECT * FROM users",
        materialized: false,
      }],
      functions: [],
      procedures: [],
      triggers: [],
      sequences: [],
      extensions: [],
      schemas: [],
      comments: [],
    };

    const result = provider.validateSchema(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("should collect multiple errors", () => {
    const schema = {
      tables: [],
      enums: [{ name: "e", values: ["a"] }],
      views: [],
      functions: [],
      procedures: [],
      triggers: [],
      sequences: [{ name: "s" }],
      extensions: [{ name: "ext" }],
      schemas: [],
      comments: [],
    };

    const result = provider.validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("SQLite Feature Support", () => {
  let provider: SQLiteProvider;

  beforeEach(() => {
    provider = new SQLiteProvider();
  });

  test("should not support schemas feature", () => {
    expect(provider.supportsFeature("schemas")).toBe(false);
  });

  test("should not support sequences feature", () => {
    expect(provider.supportsFeature("sequences")).toBe(false);
  });

  test("should not support enums feature", () => {
    expect(provider.supportsFeature("enums")).toBe(false);
  });

  test("should not support extensions feature", () => {
    expect(provider.supportsFeature("extensions")).toBe(false);
  });

  test("should not support concurrent indexes", () => {
    expect(provider.supportsFeature("concurrent_indexes")).toBe(false);
  });

  test("should not support advisory locks", () => {
    expect(provider.supportsFeature("advisory_locks")).toBe(false);
  });

  test("should not support stored functions", () => {
    expect(provider.supportsFeature("stored_functions")).toBe(false);
  });

  test("should not support stored procedures", () => {
    expect(provider.supportsFeature("stored_procedures")).toBe(false);
  });

  test("should not support materialized views", () => {
    expect(provider.supportsFeature("materialized_views")).toBe(false);
  });

  test("should support triggers", () => {
    expect(provider.supportsFeature("triggers")).toBe(true);
  });

  test("should support alter_drop_column", () => {
    expect(provider.supportsFeature("alter_drop_column")).toBe(true);
  });

  test("should support alter_column_type", () => {
    expect(provider.supportsFeature("alter_column_type")).toBe(true);
  });
});

describe("SQLite SQL Parsing Errors", () => {
  let provider: SQLiteProvider;

  beforeEach(() => {
    provider = new SQLiteProvider();
  });

  test("should throw on invalid SQL syntax", async () => {
    await expect(provider.parseSchema("CREATE TABL users (id INTEGER);")).rejects.toThrow();
  });

  test("should throw on missing closing paren", async () => {
    await expect(provider.parseSchema("CREATE TABLE users (id INTEGER")).rejects.toThrow();
  });

  test("should throw on duplicate column name", async () => {
    await expect(provider.parseSchema("CREATE TABLE users (id INTEGER, id TEXT);")).rejects.toThrow();
  });
});

describe("SQLite Connection", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-conn-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
  });

  afterEach(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  });

  test("should create database file on connect", async () => {
    expect(fs.existsSync(dbPath)).toBe(false);

    const client = await provider.createClient(config);
    await client.end();

    expect(fs.existsSync(dbPath)).toBe(true);
  });

  test("should execute queries", async () => {
    const client = await provider.createClient(config);
    await client.query("CREATE TABLE t (id INTEGER)");
    await client.query("INSERT INTO t VALUES (1), (2), (3)");
    const result = await client.query<{id: number}>("SELECT * FROM t ORDER BY id");
    await client.end();

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].id).toBe(1);
  });

  test("should support in-memory database", async () => {
    const memConfig: SQLiteConnectionConfig = { dialect: "sqlite", filename: ":memory:" };
    const client = await provider.createClient(memConfig);
    await client.query("CREATE TABLE t (id INTEGER)");
    const result = await client.query("SELECT * FROM t");
    await client.end();

    expect(result.rows).toHaveLength(0);
  });

  test("should reject non-sqlite config", async () => {
    const badConfig = { dialect: "postgres" as const, host: "localhost", port: 5432, database: "test", user: "test", password: "test" };
    await expect(provider.createClient(badConfig)).rejects.toThrow();
  });
});
