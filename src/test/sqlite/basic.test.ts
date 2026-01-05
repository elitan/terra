import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteProvider } from "../../providers/sqlite";
import { SchemaService } from "../../core/schema/service";
import type { SQLiteConnectionConfig } from "../../providers/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("SQLite Basic Operations", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
  });

  afterEach(() => {
    try {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    } catch {}
  });

  describe("Parser", () => {
    test("should parse simple table", async () => {
      const schema = await provider.parseSchema(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT
        );
      `);

      expect(schema.tables).toHaveLength(1);
      expect(schema.tables[0].name).toBe("users");
      expect(schema.tables[0].columns).toHaveLength(3);
      expect(schema.tables[0].columns[0].name).toBe("id");
      expect(schema.tables[0].columns[1].name).toBe("name");
      expect(schema.tables[0].columns[1].nullable).toBe(false);
      expect(schema.tables[0].columns[2].name).toBe("email");
      expect(schema.tables[0].columns[2].nullable).toBe(true);
    });

    test("should parse table with foreign key", async () => {
      const schema = await provider.parseSchema(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        );
        CREATE TABLE posts (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `);

      expect(schema.tables).toHaveLength(2);
      const posts = schema.tables.find(t => t.name === "posts");
      expect(posts?.foreignKeys).toHaveLength(1);
      expect(posts?.foreignKeys?.[0].referencedTable).toBe("users");
      expect(posts?.foreignKeys?.[0].onDelete).toBe("CASCADE");
    });

    test("should parse table with index", async () => {
      const schema = await provider.parseSchema(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        CREATE INDEX idx_users_email ON users(email);
      `);

      expect(schema.tables).toHaveLength(1);
      expect(schema.tables[0].indexes).toHaveLength(1);
      expect(schema.tables[0].indexes?.[0].name).toBe("idx_users_email");
    });
  });

  describe("Differ", () => {
    test("should generate CREATE TABLE for new table", () => {
      const desired = [{
        name: "users",
        columns: [
          { name: "id", type: "INTEGER", nullable: false },
          { name: "name", type: "TEXT", nullable: false },
        ],
        primaryKey: { columns: ["id"] },
      }];

      const plan = provider.generateMigrationPlan(desired, []);

      expect(plan.hasChanges).toBe(true);
      expect(plan.transactional).toHaveLength(1);
      expect(plan.transactional[0]).toContain("CREATE TABLE");
      expect(plan.transactional[0]).toContain('"users"');
    });

    test("should generate DROP TABLE for removed table", () => {
      const current = [{
        name: "old_table",
        columns: [{ name: "id", type: "INTEGER", nullable: false }],
      }];

      const plan = provider.generateMigrationPlan([], current);

      expect(plan.hasChanges).toBe(true);
      expect(plan.transactional[0]).toContain("DROP TABLE");
    });

    test("should generate ADD COLUMN for new column", () => {
      const desired = [{
        name: "users",
        columns: [
          { name: "id", type: "INTEGER", nullable: false },
          { name: "name", type: "TEXT", nullable: true },
        ],
      }];

      const current = [{
        name: "users",
        columns: [
          { name: "id", type: "INTEGER", nullable: false },
        ],
      }];

      const plan = provider.generateMigrationPlan(desired, current);

      expect(plan.hasChanges).toBe(true);
      expect(plan.transactional[0]).toContain("ADD COLUMN");
      expect(plan.transactional[0]).toContain('"name"');
    });
  });

  describe("Schema Validation", () => {
    test("should reject ENUM types", async () => {
      const schema = {
        tables: [],
        enums: [{ name: "status", values: ["active", "inactive"] }],
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
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe("SQLITE_NO_ENUMS");
    });

    test("should reject sequences", async () => {
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
      expect(result.errors[0].code).toBe("SQLITE_NO_SEQUENCES");
    });
  });

  describe("End-to-End", () => {
    test("should apply schema to empty database", async () => {
      const schemaService = new SchemaService(provider, config);

      await schemaService.apply(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        );
      `, ['public'], true);

      const client = await provider.createClient(config);
      const tables = await provider.getCurrentSchema(client);
      await client.end();

      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe("users");
    });

    test("should be idempotent", async () => {
      const schemaService = new SchemaService(provider, config);
      const schema = `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        );
      `;

      await schemaService.apply(schema, ['public'], true);
      await schemaService.apply(schema, ['public'], true);

      const client = await provider.createClient(config);
      const tables = await provider.getCurrentSchema(client);
      await client.end();

      expect(tables).toHaveLength(1);
    });

    test("should add new column", async () => {
      const schemaService = new SchemaService(provider, config);

      await schemaService.apply(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        );
      `, ['public'], true);

      await schemaService.apply(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT
        );
      `, ['public'], true);

      const client = await provider.createClient(config);
      const tables = await provider.getCurrentSchema(client);
      await client.end();

      expect(tables[0].columns).toHaveLength(3);
      expect(tables[0].columns.find(c => c.name === "email")).toBeDefined();
    });
  });
});
