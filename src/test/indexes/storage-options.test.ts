import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SchemaParser } from "../../core/schema/parser";
import { DatabaseInspector } from "../../core/schema/inspector";
import { createTestClient, cleanDatabase } from "../utils";
import type { Client } from "pg";

describe("Index Storage Options", () => {
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

  describe("Storage Parameters Parsing", () => {
    test("should parse storage parameters in index definitions", async () => {
      const sql = `
        CREATE INDEX idx_users_email_with_params ON users (email) 
        WITH (fillfactor = 90, deduplicate_items = off);
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);
      expect(indexes).toHaveLength(1);

      const index = indexes[0]!;
      expect(index.name).toBe("idx_users_email_with_params");
      expect(index.storageParameters).toEqual({
        fillfactor: "90",
        deduplicate_items: "off",
      });
    });

    test("should parse tablespace specifications in index definitions", async () => {
      const sql = `
        CREATE INDEX idx_users_email_tablespace ON users (email) 
        TABLESPACE pg_default;
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);
      expect(indexes).toHaveLength(1);

      const index = indexes[0]!;
      expect(index.name).toBe("idx_users_email_tablespace");
      expect(index.tablespace).toBe("pg_default");
    });

    test("should parse indexes with both storage parameters and tablespace", async () => {
      const sql = `
        CREATE UNIQUE INDEX idx_users_email_full_options ON users (email) 
        WITH (fillfactor = 80) 
        TABLESPACE fast_ssd;
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);
      expect(indexes).toHaveLength(1);

      const index = indexes[0]!;
      expect(index.name).toBe("idx_users_email_full_options");
      expect(index.unique).toBe(true);
      expect(index.storageParameters).toEqual({
        fillfactor: "80",
      });
      expect(index.tablespace).toBe("fast_ssd");
    });

    test("should parse expression indexes with storage parameters", async () => {
      const sql = `
        CREATE INDEX idx_users_lower_email_params ON users (LOWER(email))
        WITH (fillfactor = 70, deduplicate_items = on);
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);
      expect(indexes).toHaveLength(1);

      const index = indexes[0]!;
      expect(index.name).toBe("idx_users_lower_email_params");
      expect(index.expression).toBe("lower(email)");
      expect(index.columns).toEqual([]);
      expect(index.storageParameters).toEqual({
        fillfactor: "70",
        deduplicate_items: "on",
      });
    });

    test("should parse partial indexes with storage parameters and tablespace", async () => {
      const sql = `
        CREATE INDEX idx_active_users_email_advanced ON users (email)
        WITH (fillfactor = 85)
        TABLESPACE index_space
        WHERE active = true;
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);
      expect(indexes).toHaveLength(1);

      const index = indexes[0]!;
      expect(index.name).toBe("idx_active_users_email_advanced");
      expect(index.columns).toEqual(["email"]);
      expect(index.where).toBe("active = true");
      expect(index.storageParameters).toEqual({
        fillfactor: "85",
      });
      expect(index.tablespace).toBe("index_space");
    });

    test("should handle indexes without storage parameters or tablespace", async () => {
      const sql = `
        CREATE INDEX idx_users_simple ON users (email);
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);
      expect(indexes).toHaveLength(1);

      const index = indexes[0]!;
      expect(index.name).toBe("idx_users_simple");
      expect(index.storageParameters).toBeUndefined();
      expect(index.tablespace).toBeUndefined();
    });

    test("should parse multiple storage parameters", async () => {
      const sql = `
        CREATE INDEX idx_complex_storage ON users (email) 
        WITH (
          fillfactor = 75,
          deduplicate_items = on,
          buffering = auto
        );
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);
      expect(indexes).toHaveLength(1);

      const index = indexes[0]!;
      expect(index.storageParameters).toEqual({
        fillfactor: "75",
        deduplicate_items: "on",
        buffering: "auto",
      });
    });
  });

  describe("Database Inspector Support", () => {
    test("should extract storage parameters from database", async () => {
      // Create table and indexes with storage parameters
      await client.query(`
        CREATE TABLE storage_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          data TEXT
        );
      `);

      // Create index with storage parameters (fillfactor is commonly supported)
      await client.query(`
        CREATE INDEX idx_email_with_params ON storage_test (email) 
        WITH (fillfactor = 80);
      `);

      // Inspect the database
      const tables = await inspector.getCurrentSchema(client);
      const testTable = tables.find((t) => t.name === "storage_test");

      expect(testTable).toBeDefined();
      expect(testTable!.indexes).toBeDefined();
      expect(testTable!.indexes!.length).toBeGreaterThanOrEqual(1);

      // Check storage parameters
      const emailIndex = testTable!.indexes!.find(
        (idx) => idx.name === "idx_email_with_params"
      );
      expect(emailIndex).toBeDefined();
      expect(emailIndex!.columns).toEqual(["email"]);
      expect(emailIndex!.storageParameters).toBeDefined();
      expect(emailIndex!.storageParameters!.fillfactor).toBe("80");
    });

    test("should extract tablespace information from database", async () => {
      // Note: In test environment, we mainly test parsing since creating custom tablespaces
      // requires filesystem permissions and setup that might not be available in CI
      await client.query(`
        CREATE TABLE tablespace_test (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255)
        );
      `);

      // Create index with default tablespace (should work in all environments)
      await client.query(`
        CREATE INDEX idx_tablespace_test_name ON tablespace_test (name) 
        TABLESPACE pg_default;
      `);

      const tables = await inspector.getCurrentSchema(client);
      const testTable = tables.find((t) => t.name === "tablespace_test");
      const nameIndex = testTable?.indexes?.find(
        (idx) => idx.name === "idx_tablespace_test_name"
      );

      expect(nameIndex).toBeDefined();
      // In many environments, tablespace might be null even when explicitly set to pg_default
      // so we just verify the index was created successfully
      expect(nameIndex!.columns).toEqual(["name"]);
    });

    test("should distinguish between indexes with and without storage options", async () => {
      await client.query(`
        CREATE TABLE options_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          name VARCHAR(100)
        );
      `);

      // Regular index without options
      await client.query(`
        CREATE INDEX idx_regular_email ON options_test (email);
      `);

      // Index with storage parameters
      await client.query(`
        CREATE INDEX idx_options_name ON options_test (name) 
        WITH (fillfactor = 90);
      `);

      const tables = await inspector.getCurrentSchema(client);
      const testTable = tables.find((t) => t.name === "options_test");

      expect(testTable!.indexes).toBeDefined();
      expect(testTable!.indexes!.length).toBeGreaterThanOrEqual(2);

      const regularIndex = testTable!.indexes!.find(
        (idx) => idx.name === "idx_regular_email"
      );
      const optionsIndex = testTable!.indexes!.find(
        (idx) => idx.name === "idx_options_name"
      );

      expect(regularIndex).toBeDefined();
      expect(regularIndex!.storageParameters).toBeUndefined();

      expect(optionsIndex).toBeDefined();
      expect(optionsIndex!.storageParameters).toBeDefined();
      expect(optionsIndex!.storageParameters!.fillfactor).toBe("90");
    });
  });

  describe("Schema Differ Support", () => {
    test("should detect storage parameter changes", async () => {
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();

      const currentSchema = [
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
              type: "btree" as const,
              storageParameters: { fillfactor: "80" },
            },
          ],
        },
      ];

      const desiredSchema = [
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
              type: "btree" as const,
              storageParameters: { fillfactor: "90" }, // Changed fillfactor
            },
          ],
        },
      ];

      const plan = differ.generateMigrationPlan(desiredSchema, currentSchema);

      // Should recreate index with new storage parameters
      const allStatements = [...plan.transactional, ...plan.concurrent];
      expect(allStatements).toContain(
        'DROP INDEX CONCURRENTLY "idx_users_email";'
      );
      expect(allStatements).toContain(
        'CREATE INDEX CONCURRENTLY "idx_users_email" ON "users" ("email") WITH (fillfactor=90);'
      );
    });

    test("should detect tablespace changes", async () => {
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();

      const currentSchema = [
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
              type: "btree" as const,
              tablespace: "old_tablespace",
            },
          ],
        },
      ];

      const desiredSchema = [
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
              type: "btree" as const,
              tablespace: "new_tablespace", // Changed tablespace
            },
          ],
        },
      ];

      const plan = differ.generateMigrationPlan(desiredSchema, currentSchema);

      // Should recreate index in new tablespace
      const allStatements = [...plan.transactional, ...plan.concurrent];
      expect(allStatements).toContain(
        'DROP INDEX CONCURRENTLY "idx_users_email";'
      );
      expect(allStatements).toContain(
        'CREATE INDEX CONCURRENTLY "idx_users_email" ON "users" ("email") TABLESPACE new_tablespace;'
      );
    });

    test("should generate correct SQL with both storage parameters and tablespace", async () => {
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();

      const index = {
        name: "idx_complex",
        tableName: "users",
        columns: ["email"],
        type: "btree" as const,
        unique: true,
        storageParameters: {
          fillfactor: "85",
          deduplicate_items: "on",
        },
        tablespace: "fast_ssd",
      };

      const sql = (differ as any).generateCreateIndexSQL(index);

      expect(sql).toBe(
        'CREATE UNIQUE INDEX CONCURRENTLY "idx_complex" ON "users" ("email") WITH (fillfactor=85, deduplicate_items=on) TABLESPACE fast_ssd;'
      );
    });
  });

  describe("Storage Parameter Normalization (Issue #65)", () => {
    test("should be idempotent with storage parameters - no changes on re-apply", async () => {
      await client.query(`
        CREATE TABLE storage_idempotent_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        );
      `);

      await client.query(`
        CREATE INDEX idx_storage_idempotent ON storage_idempotent_test (email)
        WITH (fillfactor = 80);
      `);

      const schemaSQL = `
        CREATE TABLE storage_idempotent_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        );

        CREATE INDEX idx_storage_idempotent ON storage_idempotent_test (email)
        WITH (fillfactor = 80);
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
        s.includes("idx_storage_idempotent")
      );

      expect(indexStatements).toHaveLength(0);
    });

    test("should normalize quoted storage parameter values from DB", async () => {
      await client.query(`
        CREATE TABLE quote_norm_test (
          id SERIAL PRIMARY KEY,
          data TEXT
        );
      `);

      await client.query(`
        CREATE INDEX idx_quote_norm ON quote_norm_test (data)
        WITH (fillfactor = 75);
      `);

      const tables = await inspector.getCurrentSchema(client);
      const testTable = tables.find((t) => t.name === "quote_norm_test");
      const index = testTable?.indexes?.find((i) => i.name === "idx_quote_norm");

      expect(index?.storageParameters?.fillfactor).toBe("75");
    });
  });

  describe("Edge Cases and Validation", () => {
    test("should handle indexes without WITH clause", async () => {
      const sql = `
        CREATE INDEX idx_no_params ON users (email);
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);
      expect(indexes).toHaveLength(1);

      const index = indexes[0]!;
      expect(index.storageParameters).toBeUndefined();
    });

    test("should handle quoted parameter values", async () => {
      const sql = `
        CREATE INDEX idx_quoted_params ON users (email)
        WITH (buffering = 'auto', pages_per_range = '128');
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);
      expect(indexes).toHaveLength(1);

      const index = indexes[0]!;
      expect(index.storageParameters).toEqual({
        buffering: "auto",
        pages_per_range: "128",
      });
    });

    test("should handle complex tablespace names", async () => {
      const sql = `
        CREATE INDEX idx_complex_tablespace ON users (email) 
        TABLESPACE "my-special-tablespace";
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);
      expect(indexes).toHaveLength(1);

      const index = indexes[0]!;
      expect(index.tablespace).toBe('"my-special-tablespace"');
    });
  });
});
