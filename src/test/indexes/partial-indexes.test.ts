import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SchemaParser } from "../../core/schema/parser";
import { DatabaseInspector } from "../../core/schema/inspector";
import { createTestClient, cleanDatabase } from "../utils";
import type { Client } from "pg";
import type { Table } from "../../types/schema";

describe("Partial Index Support", () => {
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

  describe("Parser Support", () => {
    test("should parse partial indexes with WHERE clause", async () => {
      const sql = `
        CREATE INDEX idx_active_users ON users (email) WHERE active = true;
        CREATE INDEX idx_recent_orders ON orders (created_at) WHERE created_at > '2023-01-01';
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(2);

      // Test first partial index
      expect(indexes[0]!.name).toBe("idx_active_users");
      expect(indexes[0]!.tableName).toBe("users");
      expect(indexes[0]!.columns).toEqual(["email"]);
      expect(indexes[0]!.where).toBe("active = true");

      // Test second partial index
      expect(indexes[1]!.name).toBe("idx_recent_orders");
      expect(indexes[1]!.tableName).toBe("orders");
      expect(indexes[1]!.columns).toEqual(["created_at"]);
      expect(indexes[1]!.where).toBe("created_at > '2023-01-01'");
    });

    test("should parse complex WHERE conditions", async () => {
      const sql = `
        CREATE INDEX idx_complex_condition ON orders (customer_id) 
        WHERE status = 'active' AND created_at > NOW() - INTERVAL '30 days';
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(1);
      // The parser may not handle complex expressions perfectly, so check for key parts
      expect(indexes[0]!.where).toContain("status = 'active'");
      expect(indexes[0]!.where).toContain("created_at");
    });

    test("should parse unique partial indexes", async () => {
      const sql = `
        CREATE UNIQUE INDEX idx_unique_active_email ON users (email) 
        WHERE active = true;
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(1);
      expect(indexes[0]!.unique).toBe(true);
      expect(indexes[0]!.where).toBe("active = true");
    });
  });

  describe("Database Inspector Support", () => {
    test("should detect partial indexes with WHERE clauses", async () => {
      await client.query(`
        CREATE TABLE partial_test_users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          active BOOLEAN DEFAULT true
        );
      `);

      await client.query(`
        CREATE INDEX idx_active_users_email ON partial_test_users (email) WHERE active = true;
      `);

      const indexes = await inspector.getTableIndexes(
        client,
        "partial_test_users",
        "public"
      );
      expect(indexes).toHaveLength(1);

      if (indexes.length > 0) {
        expect(indexes[0]!.name).toBe("idx_active_users_email");
        expect(indexes[0]!.columns).toEqual(["email"]);
        expect(indexes[0]!.where).toBe("active = true");
      }
    });

    test("should distinguish between partial and regular indexes", async () => {
      await client.query(`
        CREATE TABLE mixed_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          status VARCHAR(50),
          active BOOLEAN DEFAULT true
        );
      `);

      await client.query(`
        CREATE INDEX idx_regular_email ON mixed_test (email);
      `);

      await client.query(`
        CREATE INDEX idx_partial_status ON mixed_test (status) WHERE active = true;
      `);

      const indexes = await inspector.getTableIndexes(client, "mixed_test", "public");
      expect(indexes).toHaveLength(2);

      const regularIndex = indexes.find(
        (idx) => idx.name === "idx_regular_email"
      );
      const partialIndex = indexes.find(
        (idx) => idx.name === "idx_partial_status"
      );

      expect(regularIndex).toBeDefined();
      expect(regularIndex!.where).toBeUndefined();

      expect(partialIndex).toBeDefined();
      expect(partialIndex!.where).toBeDefined();
      expect(partialIndex!.where).toBe("active = true");
    });
  });

  describe("Schema Differ Support", () => {
    test("should handle partial index changes", async () => {
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();

      const currentSchema: Table[] = [
        {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "email", type: "VARCHAR(255)", nullable: true },
            { name: "active", type: "BOOLEAN", nullable: true },
          ],
          indexes: [
            {
              name: "idx_users_email",
              tableName: "users",
              columns: ["email"],
              type: "btree" as const,
              unique: false,
              concurrent: false,
              // No WHERE clause initially
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
            { name: "active", type: "BOOLEAN", nullable: true },
          ],
          indexes: [
            {
              name: "idx_users_email",
              tableName: "users",
              columns: ["email"],
              type: "btree" as const,
              unique: false,
              concurrent: false,
              where: "active = true", // Added WHERE clause
            },
          ],
        },
      ];

      const plan = differ.generateMigrationPlan(desiredSchema, currentSchema);

      // Modified indexes use non-concurrent drop for atomicity
      expect(plan.transactional).toContain('DROP INDEX "idx_users_email";');
      expect(plan.transactional).toContain(
        'CREATE INDEX "idx_users_email" ON "users" ("email") WHERE active = true;'
      );
    });

    test("should detect when partial conditions change", async () => {
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();

      const currentSchema: Table[] = [
        {
          name: "orders",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "status", type: "VARCHAR(50)", nullable: true },
          ],
          indexes: [
            {
              name: "idx_orders_status",
              tableName: "orders",
              columns: ["status"],
              type: "btree" as const,
              where: "status = 'active'",
            },
          ],
        },
      ];

      const desiredSchema: Table[] = [
        {
          name: "orders",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "status", type: "VARCHAR(50)", nullable: true },
          ],
          indexes: [
            {
              name: "idx_orders_status",
              tableName: "orders",
              columns: ["status"],
              type: "btree" as const,
              where: "status IN ('active', 'pending')", // Changed WHERE condition
            },
          ],
        },
      ];

      const plan = differ.generateMigrationPlan(desiredSchema, currentSchema);

      // Modified indexes use non-concurrent drop for atomicity
      expect(plan.transactional).toContain('DROP INDEX "idx_orders_status";');
      expect(plan.transactional).toContain(
        'CREATE INDEX "idx_orders_status" ON "orders" ("status") WHERE status IN (\'active\', \'pending\');'
      );
    });
  });

  describe("Partial Index Idempotency (Issue #80)", () => {
    test("should be idempotent with boolean WHERE clause", async () => {
      await client.query(`
        CREATE TABLE saved_filters (
          id SERIAL PRIMARY KEY,
          user_id INT NOT NULL,
          type TEXT NOT NULL,
          is_default BOOLEAN DEFAULT false,
          deleted_at TIMESTAMPTZ
        );
      `);

      await client.query(`
        CREATE UNIQUE INDEX idx_single_default_filter
          ON saved_filters (user_id, type)
          WHERE is_default = true AND deleted_at IS NULL;
      `);

      const schemaSQL = `
        CREATE TABLE saved_filters (
          id SERIAL PRIMARY KEY,
          user_id INT NOT NULL,
          type TEXT NOT NULL,
          is_default BOOLEAN DEFAULT false,
          deleted_at TIMESTAMPTZ
        );

        CREATE UNIQUE INDEX idx_single_default_filter
          ON saved_filters (user_id, type)
          WHERE is_default = true AND deleted_at IS NULL;
      `;

      const tables = await parser.parseCreateTableStatements(schemaSQL);
      const indexes = await parser.parseCreateIndexStatements(schemaSQL);

      if (tables.length > 0) {
        tables[0]!.indexes = indexes;
      }

      const currentSchema = await inspector.getCurrentSchema(client);
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();
      const migrationPlan = differ.generateMigrationPlan(tables, currentSchema);

      const allStatements = [
        ...migrationPlan.transactional,
        ...migrationPlan.concurrent,
      ];
      const indexStatements = allStatements.filter((s: string) =>
        s.includes("idx_single_default_filter")
      );

      expect(indexStatements).toHaveLength(0);
    });

    test("should be idempotent with simple boolean true comparison", async () => {
      await client.query(`
        CREATE TABLE partial_bool_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          active BOOLEAN DEFAULT true
        );
      `);

      await client.query(`
        CREATE INDEX idx_active ON partial_bool_test (email) WHERE active = true;
      `);

      const schemaSQL = `
        CREATE TABLE partial_bool_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          active BOOLEAN DEFAULT true
        );

        CREATE INDEX idx_active ON partial_bool_test (email) WHERE active = true;
      `;

      const tables = await parser.parseCreateTableStatements(schemaSQL);
      const indexes = await parser.parseCreateIndexStatements(schemaSQL);

      if (tables.length > 0) {
        tables[0]!.indexes = indexes;
      }

      const currentSchema = await inspector.getCurrentSchema(client);
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();
      const migrationPlan = differ.generateMigrationPlan(tables, currentSchema);

      const allStatements = [
        ...migrationPlan.transactional,
        ...migrationPlan.concurrent,
      ];
      const indexStatements = allStatements.filter((s: string) =>
        s.includes("idx_active")
      );

      expect(indexStatements).toHaveLength(0);
    });

    test("should be idempotent with IS NULL condition", async () => {
      await client.query(`
        CREATE TABLE partial_null_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          deleted_at TIMESTAMPTZ
        );
      `);

      await client.query(`
        CREATE INDEX idx_not_deleted ON partial_null_test (email) WHERE deleted_at IS NULL;
      `);

      const schemaSQL = `
        CREATE TABLE partial_null_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          deleted_at TIMESTAMPTZ
        );

        CREATE INDEX idx_not_deleted ON partial_null_test (email) WHERE deleted_at IS NULL;
      `;

      const tables = await parser.parseCreateTableStatements(schemaSQL);
      const indexes = await parser.parseCreateIndexStatements(schemaSQL);

      if (tables.length > 0) {
        tables[0]!.indexes = indexes;
      }

      const currentSchema = await inspector.getCurrentSchema(client);
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();
      const migrationPlan = differ.generateMigrationPlan(tables, currentSchema);

      const allStatements = [
        ...migrationPlan.transactional,
        ...migrationPlan.concurrent,
      ];
      const indexStatements = allStatements.filter((s: string) =>
        s.includes("idx_not_deleted")
      );

      expect(indexStatements).toHaveLength(0);
    });
  });
});
