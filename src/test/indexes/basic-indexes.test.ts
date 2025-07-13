import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SchemaParser } from "../../core/schema/parser";
import { DatabaseInspector } from "../../core/schema/inspector";
import { createTestClient, cleanDatabase, TEST_DB_CONFIG } from "../utils";
import type { Client } from "pg";
import type { Table } from "../../types/schema";

describe("PostgreSQL Basic Index Support", () => {
  let client: Client;
  let parser: SchemaParser;
  let inspector: DatabaseInspector;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    parser = new SchemaParser();
    inspector = new DatabaseInspector();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("Phase 1.1 & 1.2: Parser - CREATE INDEX Support", () => {
    test("should parse basic CREATE INDEX statement", () => {
      const sql = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        );
        
        CREATE INDEX idx_users_email ON users (email);
      `;

      const indexes = parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(1);

      if (indexes.length > 0) {
        expect(indexes[0]!.name).toBe("idx_users_email");
        expect(indexes[0]!.tableName).toBe("users");
        expect(indexes[0]!.columns).toEqual(["email"]);
        expect(indexes[0]!.type).toBe("btree");
        expect(indexes[0]!.unique).toBe(false);
        expect(indexes[0]!.concurrent).toBe(false);
      }
    });

    test("should parse UNIQUE INDEX statement", () => {
      const sql = `CREATE UNIQUE INDEX idx_users_username ON users (username);`;

      const indexes = parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(1);
      if (indexes.length > 0) {
        expect(indexes[0].name).toBe("idx_users_username");
        expect(indexes[0].tableName).toBe("users");
        expect(indexes[0].columns).toEqual(["username"]);
        expect(indexes[0].unique).toBe(true);
      }
    });

    test("should parse multi-column index", () => {
      const sql = `CREATE INDEX idx_users_name ON users (first_name, last_name);`;

      const indexes = parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(1);
      if (indexes.length > 0) {
        expect(indexes[0].columns).toEqual(["first_name", "last_name"]);
      }
    });

    test("should parse all PostgreSQL index types", () => {
      const indexTypes = [
        { type: "BTREE", expected: "btree" },
        { type: "HASH", expected: "hash" },
        { type: "GIN", expected: "gin" },
        { type: "GIST", expected: "gist" },
        { type: "SPGIST", expected: "spgist" },
        { type: "BRIN", expected: "brin" },
      ];

      indexTypes.forEach(({ type, expected }) => {
        const sql = `CREATE INDEX idx_test_${type.toLowerCase()} ON test_table USING ${type} (test_column);`;

        const indexes = parser.parseCreateIndexStatements(sql);

        expect(indexes).toHaveLength(1);
        if (indexes.length > 0) {
          expect(indexes[0].type).toBe(expected);
        }
      });
    });

    test("should parse CONCURRENT index", () => {
      const sql = `CREATE INDEX CONCURRENTLY idx_users_created_at ON users (created_at);`;

      const indexes = parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(1);
      if (indexes.length > 0) {
        expect(indexes[0].concurrent).toBe(true);
      }
    });

    test("should handle mixed CREATE TABLE and CREATE INDEX statements", () => {
      const sql = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        );
        
        CREATE INDEX idx_users_email ON users (email);
        
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255)
        );
        
        CREATE INDEX idx_products_name ON products (name);
      `;

      const tables = parser.parseCreateTableStatements(sql);
      const indexes = parser.parseCreateIndexStatements(sql);

      expect(tables).toHaveLength(2);
      expect(indexes).toHaveLength(2);

      if (tables.length >= 2) {
        expect(tables[0].name).toBe("users");
        expect(tables[1].name).toBe("products");
      }

      if (indexes.length >= 2) {
        expect(indexes[0].name).toBe("idx_users_email");
        expect(indexes[0].tableName).toBe("users");
        expect(indexes[1].name).toBe("idx_products_name");
        expect(indexes[1].tableName).toBe("products");
      }
    });
  });

  describe("Phase 1.3: Database Inspector - Index Detection", () => {
    test("should detect basic indexes in database", async () => {
      // Create a table and index
      await client.query(`
        CREATE TABLE test_users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        );
      `);

      await client.query(`
        CREATE INDEX idx_test_users_email ON test_users (email);
      `);

      // Test the getTableIndexes method
      const indexes = await inspector.getTableIndexes(client, "test_users");
      expect(indexes).toHaveLength(1);

      if (indexes.length > 0) {
        expect(indexes[0].name).toBe("idx_test_users_email");
        expect(indexes[0].tableName).toBe("test_users");
        expect(indexes[0].columns).toEqual(["email"]);
        expect(indexes[0].type).toBe("btree");
        expect(indexes[0].unique).toBe(false);
      }
    });

    test("should detect UNIQUE indexes", async () => {
      await client.query(`
        CREATE TABLE test_users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(255)
        );
      `);

      await client.query(`
        CREATE UNIQUE INDEX idx_test_users_username ON test_users (username);
      `);

      const indexes = await inspector.getTableIndexes(client, "test_users");
      expect(indexes).toHaveLength(1);

      if (indexes.length > 0) {
        expect(indexes[0].unique).toBe(true);
      }
    });

    test("should detect different index types", async () => {
      await client.query(`
        CREATE TABLE test_docs (
          id SERIAL PRIMARY KEY,
          content TEXT,
          metadata JSONB
        );
      `);

      await client.query(`
        CREATE INDEX idx_test_docs_metadata ON test_docs USING GIN (metadata);
      `);

      const indexes = await inspector.getTableIndexes(client, "test_docs");
      expect(indexes).toHaveLength(1);

      if (indexes.length > 0) {
        expect(indexes[0].type).toBe("gin");
      }
    });

    test("should filter out primary key constraint indexes", async () => {
      await client.query(`
        CREATE TABLE test_users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        );
      `);

      await client.query(`
        CREATE INDEX idx_test_users_email ON test_users (email);
      `);

      const indexes = await inspector.getTableIndexes(client, "test_users");
      expect(indexes).toHaveLength(1);

      if (indexes.length > 0) {
        expect(indexes[0].name).toBe("idx_test_users_email");
      }
    });
  });

  describe("Phase 1.4: Schema Differ - Index Comparison", () => {
    test("should identify new indexes to create", () => {
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();

      const currentSchema: Table[] = [
        {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "email", type: "VARCHAR(255)", nullable: true },
          ],
          indexes: [], // No indexes initially
        },
      ];

      const desiredSchema: Table[] = [
        {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "email", type: "VARCHAR(255)", nullable: true },
          ],
          indexes: [
            {
              name: "idx_users_email",
              tableName: "users",
              columns: ["email"],
              type: "btree",
              unique: false,
              concurrent: false,
            },
          ],
        },
      ];

      const plan = differ.generateMigrationPlan(desiredSchema, currentSchema);

      const allStatements = [...plan.transactional, ...plan.concurrent];
      expect(allStatements).toContain(
        "CREATE INDEX idx_users_email ON users (email);"
      );
    });

    test("should identify indexes to drop", () => {
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();

      const currentSchema: Table[] = [
        {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "email", type: "VARCHAR(255)", nullable: true },
          ],
          indexes: [
            {
              name: "idx_users_email",
              tableName: "users",
              columns: ["email"],
              type: "btree",
              unique: false,
              concurrent: false,
            },
          ],
        },
      ];

      const desiredSchema: Table[] = [
        {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "email", type: "VARCHAR(255)", nullable: true },
          ],
          indexes: [], // Remove all indexes
        },
      ];

      const plan = differ.generateMigrationPlan(desiredSchema, currentSchema);

      const allStatements = [...plan.transactional, ...plan.concurrent];
      expect(allStatements).toContain(
        "DROP INDEX CONCURRENTLY idx_users_email;"
      );
    });

    test("should treat modified indexes as drop + create", () => {
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();

      const currentSchema: Table[] = [
        {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "email", type: "VARCHAR(255)", nullable: true },
            { name: "name", type: "VARCHAR(100)", nullable: true },
          ],
          indexes: [
            {
              name: "idx_users_email",
              tableName: "users",
              columns: ["email"], // Single column initially
              type: "btree",
              unique: false,
              concurrent: false,
            },
          ],
        },
      ];

      const desiredSchema: Table[] = [
        {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "email", type: "VARCHAR(255)", nullable: true },
            { name: "name", type: "VARCHAR(100)", nullable: true },
          ],
          indexes: [
            {
              name: "idx_users_email",
              tableName: "users",
              columns: ["email", "name"], // Changed to multi-column
              type: "btree",
              unique: false,
              concurrent: false,
            },
          ],
        },
      ];

      const plan = differ.generateMigrationPlan(desiredSchema, currentSchema);

      // Should drop old index and create new one
      const allStatements = [...plan.transactional, ...plan.concurrent];
      expect(allStatements).toContain(
        "DROP INDEX CONCURRENTLY idx_users_email;"
      );
      expect(allStatements).toContain(
        "CREATE INDEX idx_users_email ON users (email, name);"
      );
    });
  });
});
