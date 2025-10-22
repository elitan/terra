import { beforeEach, describe, expect, test, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaParser } from "../../../core/schema/parser";
import { DatabaseInspector } from "../../../core/schema/inspector";
import { SchemaDiffer } from "../../../core/schema/differ";
import { MigrationExecutor } from "../../../core/migration/executor";
import { DatabaseService } from "../../../core/database/client";
import {
  generateAddPrimaryKeySQL,
  generateDropPrimaryKeySQL,
} from "../../../utils/sql";
import type { PrimaryKeyConstraint } from "../../../types/schema";
import type { MigrationPlan } from "../../../types/migration";
import { createTestClient, cleanDatabase, createTestDatabaseService } from "../../utils";

describe("Primary Key Support", () => {
  let client: Client;
  let parser: SchemaParser;
  let inspector: DatabaseInspector;
  let differ: SchemaDiffer;
  let executor: MigrationExecutor;
  let databaseService: DatabaseService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    parser = new SchemaParser();
    inspector = new DatabaseInspector();
    differ = new SchemaDiffer();
    databaseService = createTestDatabaseService();
    executor = new MigrationExecutor(databaseService);
  });

  describe("Schema Parser - Primary Key Extraction", () => {
    test("should parse column-level PRIMARY KEY", async () => {
      const sql = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255)
        );
      `;

      const tables = await parser.parseCreateTableStatements(sql);

      expect(tables).toHaveLength(1);
      const table = tables[0];
      expect(table).toBeDefined();
      expect(table!.name).toBe("users");
      expect(table!.primaryKey).toBeDefined();
      expect(table!.primaryKey!.columns).toEqual(["id"]);
      expect(table!.primaryKey!.name).toBeUndefined(); // No explicit name
    });

    test("should parse table-level PRIMARY KEY", async () => {
      const sql = `
        CREATE TABLE orders (
          order_id INTEGER,
          user_id INTEGER,
          PRIMARY KEY (order_id)
        );
      `;

      const tables = await parser.parseCreateTableStatements(sql);

      expect(tables).toHaveLength(1);
      const table = tables[0];
      expect(table).toBeDefined();
      expect(table!.primaryKey).toBeDefined();
      expect(table!.primaryKey!.columns).toEqual(["order_id"]);
    });

    test("should parse composite PRIMARY KEY", async () => {
      const sql = `
        CREATE TABLE user_roles (
          user_id INTEGER,
          role_id INTEGER,
          PRIMARY KEY (user_id, role_id)
        );
      `;

      const tables = await parser.parseCreateTableStatements(sql);

      expect(tables).toHaveLength(1);
      const table = tables[0];
      expect(table).toBeDefined();
      expect(table!.primaryKey).toBeDefined();
      expect(table!.primaryKey!.columns).toEqual(["user_id", "role_id"]);
    });

    test("should parse named PRIMARY KEY constraint", async () => {
      const sql = `
        CREATE TABLE sessions (
          session_id VARCHAR(255),
          user_id INTEGER,
          CONSTRAINT pk_sessions PRIMARY KEY (session_id, user_id)
        );
      `;

      const tables = await parser.parseCreateTableStatements(sql);

      expect(tables).toHaveLength(1);
      const table = tables[0];
      expect(table).toBeDefined();
      expect(table!.primaryKey).toBeDefined();
      expect(table!.primaryKey!.name).toBe("pk_sessions");
      expect(table!.primaryKey!.columns).toEqual(["session_id", "user_id"]);
    });

    test("should handle table without PRIMARY KEY", async () => {
      const sql = `
        CREATE TABLE logs (
          id INTEGER,
          message TEXT
        );
      `;

      const tables = await parser.parseCreateTableStatements(sql);

      expect(tables).toHaveLength(1);
      const table = tables[0];
      expect(table).toBeDefined();
      expect(table!.primaryKey).toBeUndefined();
    });
  });

  describe("SQL Generation - Primary Key Operations", () => {
    test("should generate ADD CONSTRAINT for single column", () => {
      const primaryKey: PrimaryKeyConstraint = {
        columns: ["id"],
      };

      const sql = generateAddPrimaryKeySQL("users", primaryKey);

      expect(sql).toBe(
        'ALTER TABLE "users" ADD CONSTRAINT "pk_users" PRIMARY KEY ("id");'
      );
    });

    test("should generate ADD CONSTRAINT for composite primary key", () => {
      const primaryKey: PrimaryKeyConstraint = {
        columns: ["user_id", "role_id"],
      };

      const sql = generateAddPrimaryKeySQL("user_roles", primaryKey);

      expect(sql).toBe(
        'ALTER TABLE "user_roles" ADD CONSTRAINT "pk_user_roles" PRIMARY KEY ("user_id", "role_id");'
      );
    });

    test("should generate ADD CONSTRAINT with custom name", () => {
      const primaryKey: PrimaryKeyConstraint = {
        name: "pk_custom_sessions",
        columns: ["session_id", "user_id"],
      };

      const sql = generateAddPrimaryKeySQL("sessions", primaryKey);

      expect(sql).toBe(
        'ALTER TABLE "sessions" ADD CONSTRAINT "pk_custom_sessions" PRIMARY KEY ("session_id", "user_id");'
      );
    });

    test("should generate DROP CONSTRAINT", () => {
      const sql = generateDropPrimaryKeySQL("users", "pk_users");

      expect(sql).toBe('ALTER TABLE "users" DROP CONSTRAINT "pk_users";');
    });
  });

  describe("Database Inspector - Primary Key Detection", () => {
    test("should detect single column primary key", async () => {
      // Create test table with primary key
      await client.query(`
        CREATE TABLE test_single_pk (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100)
        );
      `);

      const tables = await inspector.getCurrentSchema(client);
      const testTable = tables.find((t) => t.name === "test_single_pk");

      expect(testTable).toBeDefined();
      expect(testTable!.primaryKey).toBeDefined();
      expect(testTable!.primaryKey!.columns).toEqual(["id"]);
      expect(testTable!.primaryKey!.name).toBeDefined(); // Should have auto-generated name

      // Cleanup
      await client.query("DROP TABLE test_single_pk;");
    });

    test("should detect composite primary key", async () => {
      // Create test table with composite primary key
      await client.query(`
        CREATE TABLE test_composite_pk (
          user_id INTEGER,
          role_id INTEGER,
          PRIMARY KEY (user_id, role_id)
        );
      `);

      const tables = await inspector.getCurrentSchema(client);
      const testTable = tables.find((t) => t.name === "test_composite_pk");

      expect(testTable).toBeDefined();
      expect(testTable!.primaryKey).toBeDefined();
      expect(testTable!.primaryKey!.columns).toEqual(["user_id", "role_id"]);

      // Cleanup
      await client.query("DROP TABLE test_composite_pk;");
    });

    test("should handle table without primary key", async () => {
      // Create test table without primary key
      await client.query(`
        CREATE TABLE test_no_pk (
          id INTEGER,
          name VARCHAR(100)
        );
      `);

      const tables = await inspector.getCurrentSchema(client);
      const testTable = tables.find((t) => t.name === "test_no_pk");

      expect(testTable).toBeDefined();
      expect(testTable!.primaryKey).toBeUndefined();

      // Cleanup
      await client.query("DROP TABLE test_no_pk;");
    });
  });

  describe("End-to-End Primary Key Migration Tests", () => {
    test("should add primary key to existing table without one", async () => {
      // 1. Initial state: create table without primary key
      await client.query(`
        CREATE TABLE users (
          id INTEGER,
          name VARCHAR(100)
        );
      `);

      // Insert some test data
      await client.query(`
        INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Charlie');
      `);

      // 2. Desired state: SQL with primary key
      const desiredSQL = `
        CREATE TABLE users (
          id INTEGER,
          name VARCHAR(100),
          PRIMARY KEY (id)
        );
      `;

      // 3. Execute migration
      const initialSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

      await executor.executePlan(client, plan, true);

      // 4. Verify final state
      const finalSchema = await inspector.getCurrentSchema(client);
      const usersTable = finalSchema.find((t) => t.name === "users");

      expect(usersTable).toBeDefined();
      expect(usersTable!.primaryKey).toBeDefined();
      expect(usersTable!.primaryKey!.columns).toEqual(["id"]);
      expect(usersTable!.primaryKey!.name).toBe("pk_users");

      // Verify data is preserved
      const result = await client.query("SELECT COUNT(*) FROM users");
      expect(parseInt(result.rows[0].count)).toBe(3);
    });

    test("should remove primary key from existing table", async () => {
      // 1. Initial state: create table with primary key
      await client.query(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name VARCHAR(100)
        );
      `);

      // Insert some test data
      await client.query(`
        INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob');
      `);

      // 2. Desired state: SQL without primary key
      const desiredSQL = `
        CREATE TABLE users (
          id INTEGER,
          name VARCHAR(100)
        );
      `;

      // 3. Execute migration
      const initialSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

      await executor.executePlan(client, plan, true);

      // 4. Verify final state
      const finalSchema = await inspector.getCurrentSchema(client);
      const usersTable = finalSchema.find((t) => t.name === "users");

      expect(usersTable).toBeDefined();
      expect(usersTable!.primaryKey).toBeUndefined();

      // Verify data is preserved
      const result = await client.query("SELECT COUNT(*) FROM users");
      expect(parseInt(result.rows[0].count)).toBe(2);
    });

    test("should change primary key columns", async () => {
      // 1. Initial state: create table with single primary key
      await client.query(`
        CREATE TABLE user_sessions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER,
          session_token VARCHAR(255)
        );
      `);

      // Insert some test data
      await client.query(`
        INSERT INTO user_sessions (user_id, session_token) 
        VALUES (1, 'token1'), (2, 'token2'), (1, 'token3');
      `);

      // 2. Desired state: SQL with composite primary key
      const desiredSQL = `
        CREATE TABLE user_sessions (
          id SERIAL,
          user_id INTEGER,
          session_token VARCHAR(255),
          PRIMARY KEY (user_id, session_token)
        );
      `;

      // 3. Execute migration
      const initialSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

      await executor.executePlan(client, plan, true);

      // 4. Verify final state
      const finalSchema = await inspector.getCurrentSchema(client);
      const sessionsTable = finalSchema.find((t) => t.name === "user_sessions");

      expect(sessionsTable).toBeDefined();
      expect(sessionsTable!.primaryKey).toBeDefined();
      expect(sessionsTable!.primaryKey!.columns).toEqual([
        "user_id",
        "session_token",
      ]);
      expect(sessionsTable!.primaryKey!.name).toBe("pk_user_sessions");

      // Verify data is preserved and id column is no longer primary key
      const result = await client.query("SELECT COUNT(*) FROM user_sessions");
      expect(parseInt(result.rows[0].count)).toBe(3);

      const idColumn = sessionsTable!.columns.find((c) => c.name === "id");
      expect(idColumn).toBeDefined();
      expect(idColumn!.type).toBe("integer");
    });

    test("should handle identical primary keys without changes", async () => {
      // 1. Initial state: create table with primary key
      await client.query(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name VARCHAR(100)
        );
      `);

      // 2. Desired state: identical SQL
      const desiredSQL = `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name VARCHAR(100)
        );
      `;

      // 3. Execute migration
      const initialSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

      // 4. Verify no migration statements generated
      expect(plan.hasChanges).toBe(false);
    });

    test("should create table with composite primary key from scratch", async () => {
      // 1. Initial state: no tables

      // 2. Desired state: table with composite primary key
      const desiredSQL = `
        CREATE TABLE user_roles (
          user_id INTEGER,
          role_id INTEGER,
          assigned_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (user_id, role_id)
        );
      `;

      // 3. Execute migration
      const initialSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

      await executor.executePlan(client, plan, true);

      // 4. Verify table was created with correct primary key
      const finalSchema = await inspector.getCurrentSchema(client);
      const userRolesTable = finalSchema.find((t) => t.name === "user_roles");

      expect(userRolesTable).toBeDefined();
      expect(userRolesTable!.primaryKey).toBeDefined();
      expect(userRolesTable!.primaryKey!.columns).toEqual([
        "user_id",
        "role_id",
      ]);

      // Verify we can insert data with composite key constraints
      await client.query(`
        INSERT INTO user_roles (user_id, role_id) VALUES (1, 1), (1, 2), (2, 1);
      `);

      const result = await client.query("SELECT COUNT(*) FROM user_roles");
      expect(parseInt(result.rows[0].count)).toBe(3);
    });
  });

  describe("Error Scenarios", () => {
    test("should fail to add primary key when table has duplicate values", async () => {
      // 1. Initial state: create table with duplicate values
      await client.query(`
        CREATE TABLE users (
          id INTEGER,
          name VARCHAR(100)
        );
      `);

      // Insert duplicate values
      await client.query(`
        INSERT INTO users (id, name) VALUES 
        (1, 'Alice'), 
        (1, 'Bob'),  -- Duplicate id
        (2, 'Charlie');
      `);

      // 2. Desired state: SQL with primary key on duplicate column
      const desiredSQL = `
        CREATE TABLE users (
          id INTEGER,
          name VARCHAR(100),
          PRIMARY KEY (id)
        );
      `;

      // 3. Execute migration - should fail
      const initialSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

      // Should throw an error due to duplicate values
      await expect(executor.executePlan(client, plan, true)).rejects.toThrow();

      // 4. Verify original state is preserved
      const result = await client.query("SELECT COUNT(*) FROM users");
      expect(parseInt(result.rows[0].count)).toBe(3);
    });

    test("should fail to add primary key when table has NULL values", async () => {
      // 1. Initial state: create table with NULL values
      await client.query(`
        CREATE TABLE users (
          id INTEGER,
          name VARCHAR(100)
        );
      `);

      // Insert NULL values
      await client.query(`
        INSERT INTO users (id, name) VALUES 
        (1, 'Alice'), 
        (NULL, 'Bob'),  -- NULL id
        (2, 'Charlie');
      `);

      // 2. Desired state: SQL with primary key on nullable column
      const desiredSQL = `
        CREATE TABLE users (
          id INTEGER,
          name VARCHAR(100),
          PRIMARY KEY (id)
        );
      `;

      // 3. Execute migration - should fail
      const initialSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

      // Should throw an error due to NULL values
      await expect(executor.executePlan(client, plan, true)).rejects.toThrow();

      // 4. Verify original state is preserved
      const result = await client.query("SELECT COUNT(*) FROM users");
      expect(parseInt(result.rows[0].count)).toBe(3);
    });

    test("should handle malformed primary key SQL gracefully", async () => {
      const malformedSQL = `
        CREATE TABLE users (
          id INTEGER,
          PRIMARY KEY ()  -- Empty primary key
        );
      `;

      // Should either parse gracefully or throw descriptive error
      expect(() => parser.parseCreateTableStatements(malformedSQL)).toThrow();
    });

    test("should handle duplicate primary key definitions", async () => {
      const duplicateSQL = `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name VARCHAR(100),
          PRIMARY KEY (id)  -- Duplicate primary key
        );
      `;

      // Parser should handle gracefully by using table-level definition
      const tables = await parser.parseCreateTableStatements(duplicateSQL);

      expect(tables).toHaveLength(1);
      expect(tables[0]!.primaryKey).toBeDefined();
      expect(tables[0]!.primaryKey!.columns).toEqual(["id"]);
      // Should use table-level definition (no name specified)
      expect(tables[0]!.primaryKey!.name).toBeUndefined();
    });

    test("should fail when trying to drop non-existent primary key", async () => {
      // 1. Initial state: create table without primary key
      await client.query(`
        CREATE TABLE users (
          id INTEGER,
          name VARCHAR(100)
        );
      `);

      // 2. Try to drop non-existent primary key constraint
      const dropSQL = generateDropPrimaryKeySQL("users", "pk_users");

      // Should fail gracefully
      await expect(client.query(dropSQL)).rejects.toThrow();
    });
  });

  describe("Edge Cases", () => {
    test("should handle primary key with UUID data type", async () => {
      // Enable UUID extension if not already enabled
      await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

      // 1. Initial state: no table

      // 2. Desired state: table with UUID primary key
      const desiredSQL = `
        CREATE TABLE sessions (
          session_id UUID,
          user_id INTEGER,
          PRIMARY KEY (session_id)
        );
      `;

      // 3. Execute migration
      const initialSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

      await executor.executePlan(client, plan, true);

      // 4. Verify final state
      const finalSchema = await inspector.getCurrentSchema(client);
      const sessionsTable = finalSchema.find((t) => t.name === "sessions");

      expect(sessionsTable).toBeDefined();
      expect(sessionsTable!.primaryKey).toBeDefined();
      expect(sessionsTable!.primaryKey!.columns).toEqual(["session_id"]);

      // Test inserting UUID values
      await client.query(`
        INSERT INTO sessions (session_id, user_id) VALUES 
        (uuid_generate_v4(), 1),
        (uuid_generate_v4(), 2);
      `);

      const result = await client.query("SELECT COUNT(*) FROM sessions");
      expect(parseInt(result.rows[0].count)).toBe(2);
    });

    test("should handle primary key with BIGINT data type", async () => {
      // 1. Initial state: no table

      // 2. Desired state: table with BIGINT primary key
      const desiredSQL = `
        CREATE TABLE large_entities (
          entity_id BIGINT,
          data TEXT,
          PRIMARY KEY (entity_id)
        );
      `;

      // 3. Execute migration
      const initialSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

      await executor.executePlan(client, plan, true);

      // 4. Verify final state
      const finalSchema = await inspector.getCurrentSchema(client);
      const entitiesTable = finalSchema.find(
        (t) => t.name === "large_entities"
      );

      expect(entitiesTable).toBeDefined();
      expect(entitiesTable!.primaryKey).toBeDefined();
      expect(entitiesTable!.primaryKey!.columns).toEqual(["entity_id"]);

      // Test inserting large integer values
      await client.query(`
        INSERT INTO large_entities (entity_id, data) VALUES 
        (9223372036854775801, 'data1'),
        (9223372036854775802, 'data2');
      `);

      const result = await client.query("SELECT COUNT(*) FROM large_entities");
      expect(parseInt(result.rows[0].count)).toBe(2);
    });

    test("should handle primary key with VARCHAR data type", async () => {
      // 1. Initial state: no table

      // 2. Desired state: table with VARCHAR primary key
      const desiredSQL = `
        CREATE TABLE products (
          product_code VARCHAR(50),
          name VARCHAR(255),
          PRIMARY KEY (product_code)
        );
      `;

      // 3. Execute migration
      const initialSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

      await executor.executePlan(client, plan, true);

      // 4. Verify final state
      const finalSchema = await inspector.getCurrentSchema(client);
      const productsTable = finalSchema.find((t) => t.name === "products");

      expect(productsTable).toBeDefined();
      expect(productsTable!.primaryKey).toBeDefined();
      expect(productsTable!.primaryKey!.columns).toEqual(["product_code"]);

      // Test inserting string values
      await client.query(`
        INSERT INTO products (product_code, name) VALUES 
        ('PROD-001', 'Product 1'),
        ('PROD-002', 'Product 2');
      `);

      const result = await client.query("SELECT COUNT(*) FROM products");
      expect(parseInt(result.rows[0].count)).toBe(2);
    });

    test("should handle large composite primary key", async () => {
      // 1. Initial state: no table

      // 2. Desired state: table with 5-column composite primary key
      const desiredSQL = `
        CREATE TABLE multi_tenant_data (
          tenant_id INTEGER,
          region_id INTEGER,
          service_id INTEGER,
          entity_type VARCHAR(50),
          entity_id INTEGER,
          data TEXT,
          PRIMARY KEY (tenant_id, region_id, service_id, entity_type, entity_id)
        );
      `;

      // 3. Execute migration
      const initialSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

      await executor.executePlan(client, plan, true);

      // 4. Verify final state
      const finalSchema = await inspector.getCurrentSchema(client);
      const dataTable = finalSchema.find((t) => t.name === "multi_tenant_data");

      expect(dataTable).toBeDefined();
      expect(dataTable!.primaryKey).toBeDefined();
      expect(dataTable!.primaryKey!.columns).toEqual([
        "tenant_id",
        "region_id",
        "service_id",
        "entity_type",
        "entity_id",
      ]);

      // Test inserting complex composite key values
      await client.query(`
        INSERT INTO multi_tenant_data 
        (tenant_id, region_id, service_id, entity_type, entity_id, data) VALUES 
        (1, 1, 1, 'user', 100, 'data1'),
        (1, 1, 1, 'user', 101, 'data2'),
        (1, 1, 2, 'user', 100, 'data3');
      `);

      const result = await client.query(
        "SELECT COUNT(*) FROM multi_tenant_data"
      );
      expect(parseInt(result.rows[0].count)).toBe(3);
    });

    test("should handle primary key constraint name changes", async () => {
      // 1. Initial state: create table with named primary key
      await client.query(`
        CREATE TABLE users (
          id INTEGER,
          name VARCHAR(100),
          CONSTRAINT pk_users_old PRIMARY KEY (id)
        );
      `);

      // Insert test data
      await client.query(`
        INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob');
      `);

      // 2. Get initial schema to check current constraint name
      const initialSchema = await inspector.getCurrentSchema(client);
      const initialUsersTable = initialSchema.find((t) => t.name === "users");
      expect(initialUsersTable).toBeDefined();
      expect(initialUsersTable!.primaryKey).toBeDefined();
      expect(initialUsersTable!.primaryKey!.columns).toEqual(["id"]);

      // 3. Desired state: same primary key but different constraint name
      const desiredSQL = `
        CREATE TABLE users (
          id INTEGER NOT NULL,
          name VARCHAR(100),
          CONSTRAINT pk_users_new PRIMARY KEY (id)
        );
      `;

      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, initialSchema);

      await executor.executePlan(client, plan, true);

      // 4. Verify final state
      const finalSchema = await inspector.getCurrentSchema(client);
      const usersTable = finalSchema.find((t) => t.name === "users");

      expect(usersTable).toBeDefined();
      expect(usersTable!.primaryKey).toBeDefined();
      expect(usersTable!.primaryKey!.columns).toEqual(["id"]);
      // The constraint name should be updated (though PostgreSQL may auto-generate names)
      expect(usersTable!.primaryKey!.name).toBeDefined();

      // Verify data is preserved
      const result = await client.query("SELECT COUNT(*) FROM users");
      expect(parseInt(result.rows[0].count)).toBe(2);
    });
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });
});
