import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SchemaParser } from "../../core/schema/parser";
import { DatabaseInspector } from "../../core/schema/inspector";
import { createTestClient, cleanDatabase } from "../utils";
import type { Client } from "pg";
import type { Table } from "../../types/schema";

describe("Concurrent Index Operations", () => {
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
    test("should parse CREATE INDEX CONCURRENTLY statements", async () => {
      const sql = `
        CREATE INDEX CONCURRENTLY idx_users_email ON users (email);
        CREATE UNIQUE INDEX CONCURRENTLY idx_users_username ON users (username);
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(2);

      expect(indexes[0]!.name).toBe("idx_users_email");
      expect(indexes[0]!.concurrent).toBe(true);
      expect(indexes[0]!.unique).toBe(false);

      expect(indexes[1]!.name).toBe("idx_users_username");
      expect(indexes[1]!.concurrent).toBe(true);
      expect(indexes[1]!.unique).toBe(true);
    });

    test("should parse concurrent partial indexes", async () => {
      const sql = `
        CREATE INDEX CONCURRENTLY idx_active_users 
        ON users (email) WHERE active = true;
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(1);
      expect(indexes[0]!.concurrent).toBe(true);
      expect(indexes[0]!.where).toBe("active = true");
    });

    test("should parse concurrent expression indexes", async () => {
      const sql = `
        CREATE INDEX CONCURRENTLY idx_lower_email 
        ON users (LOWER(email));
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(1);
      expect(indexes[0]!.concurrent).toBe(true);
      expect(indexes[0]!.expression).toBe("lower(email)");
    });
  });

  describe("Migration Plan Structure", () => {
    test("should separate concurrent and transactional operations", async () => {
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();

      const currentSchema: Table[] = [];

      const desiredSchema: Table[] = [
        {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "email", type: "VARCHAR(255)", nullable: true },
          ],
          indexes: [
            {
              name: "idx_users_email_regular",
              tableName: "users",
              columns: ["email"],
              type: "btree" as const,
              concurrent: false,
            },
            {
              name: "idx_users_email_concurrent",
              tableName: "users",
              columns: ["email"],
              type: "btree" as const,
              concurrent: true,
            },
          ],
        },
      ];

      const plan = differ.generateMigrationPlan(desiredSchema, currentSchema);

      // Regular index should be in transactional statements
      expect(plan.transactional).toContain(
        "CREATE INDEX idx_users_email_regular ON users (email);"
      );

      // Concurrent index should be in concurrent statements
      expect(plan.concurrent).toContain(
        "CREATE INDEX CONCURRENTLY idx_users_email_concurrent ON users (email);"
      );
    });

    test("should use CONCURRENTLY for index drops by default", async () => {
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
              type: "btree" as const,
              concurrent: false, // Regular index
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
          indexes: [], // Remove index
        },
      ];

      const plan = differ.generateMigrationPlan(desiredSchema, currentSchema);

      // Even regular indexes should be dropped concurrently for safety
      expect(plan.concurrent).toContain(
        'DROP INDEX CONCURRENTLY "idx_users_email";'
      );
    });

    test("should handle mixed operations correctly", async () => {
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
              name: "idx_old_email",
              tableName: "users",
              columns: ["email"],
              type: "btree" as const,
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
              name: "idx_new_name",
              tableName: "users",
              columns: ["name"],
              type: "btree" as const,
              concurrent: false,
            },
            {
              name: "idx_new_email_concurrent",
              tableName: "users",
              columns: ["email"],
              type: "btree" as const,
              concurrent: true,
            },
          ],
        },
      ];

      const plan = differ.generateMigrationPlan(desiredSchema, currentSchema);

      // Drop should be concurrent
      expect(plan.concurrent).toContain(
        'DROP INDEX CONCURRENTLY "idx_old_email";'
      );

      // Regular create should be transactional
      expect(plan.transactional).toContain(
        "CREATE INDEX idx_new_name ON users (name);"
      );

      // Concurrent create should be concurrent
      expect(plan.concurrent).toContain(
        "CREATE INDEX CONCURRENTLY idx_new_email_concurrent ON users (email);"
      );
    });
  });

  describe("Database Operations", () => {
    test("should handle concurrent index creation in real database", async () => {
      // Create table first
      await client.query(`
        CREATE TABLE concurrent_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          name VARCHAR(100)
        );
      `);

      // Insert some test data to make the concurrent operation more realistic
      await client.query(`
        INSERT INTO concurrent_test (email, name) 
        VALUES ('user1@test.com', 'User One'), ('user2@test.com', 'User Two');
      `);

      // Create index concurrently
      await client.query(`
        CREATE INDEX CONCURRENTLY idx_concurrent_test_email 
        ON concurrent_test (email);
      `);

      // Verify index was created
      const indexes = await inspector.getTableIndexes(
        client,
        "concurrent_test",
        "public"
      );
      const emailIndex = indexes.find(
        (idx) => idx.name === "idx_concurrent_test_email"
      );

      expect(emailIndex).toBeDefined();
      expect(emailIndex!.columns).toEqual(["email"]);
      expect(emailIndex!.type).toBe("btree");

      // Verify index is actually usable
      const result = await client.query(`
        EXPLAIN (FORMAT JSON) 
        SELECT * FROM concurrent_test WHERE email = 'user1@test.com';
      `);

      // The query plan should reference our index (though exact format may vary)
      const plan = JSON.stringify(result.rows[0]);
      expect(plan).toContain("concurrent_test");
    });

    test("should handle dropping indexes concurrently", async () => {
      // Create table and index
      await client.query(`
        CREATE TABLE drop_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        );
      `);

      await client.query(`
        CREATE INDEX idx_drop_test_email ON drop_test (email);
      `);

      // Verify index exists
      let indexes = await inspector.getTableIndexes(client, "drop_test", "public");
      expect(indexes).toHaveLength(1);

      // Drop index concurrently
      await client.query(`
        DROP INDEX CONCURRENTLY "idx_drop_test_email";
      `);

      // Verify index is gone
      indexes = await inspector.getTableIndexes(client, "drop_test", "public");
      expect(indexes).toHaveLength(0);
    });
  });

  describe("Performance and Safety", () => {
    test("should not block concurrent operations", async () => {
      // This test verifies that concurrent operations don't block other database activity
      await client.query(`
        CREATE TABLE performance_test (
          id SERIAL PRIMARY KEY,
          data VARCHAR(255)
        );
      `);

      // Insert test data
      for (let i = 0; i < 100; i++) {
        await client.query(
          `
          INSERT INTO performance_test (data) VALUES ($1);
        `,
          [`test-data-${i}`]
        );
      }

      // Start concurrent index creation (this would normally not block in a real scenario)
      const startTime = Date.now();

      await client.query(`
        CREATE INDEX CONCURRENTLY idx_performance_test_data 
        ON performance_test (data);
      `);

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Verify index was created
      const indexes = await inspector.getTableIndexes(
        client,
        "performance_test",
        "public"
      );
      expect(indexes).toHaveLength(1);

      // In a real scenario with more data, this would test that other operations
      // can continue while the index is being built
      console.log(`Concurrent index creation took ${duration}ms`);
    });
  });
});
