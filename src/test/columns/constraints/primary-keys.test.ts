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
import { createTestClient, cleanDatabase, TEST_DB_CONFIG } from "../../utils";

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
    databaseService = new DatabaseService(TEST_DB_CONFIG);
    executor = new MigrationExecutor(databaseService);
  });

  describe("Schema Parser - Primary Key Extraction", () => {
    test("should parse column-level PRIMARY KEY", () => {
      const sql = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255)
        );
      `;

      const tables = parser.parseCreateTableStatements(sql);

      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe("users");
      expect(tables[0].primaryKey).toBeDefined();
      expect(tables[0].primaryKey!.columns).toEqual(["id"]);
      expect(tables[0].primaryKey!.name).toBeUndefined(); // No explicit name
    });

    test("should parse table-level PRIMARY KEY", () => {
      const sql = `
        CREATE TABLE orders (
          order_id INTEGER,
          user_id INTEGER,
          PRIMARY KEY (order_id)
        );
      `;

      const tables = parser.parseCreateTableStatements(sql);

      expect(tables).toHaveLength(1);
      expect(tables[0].primaryKey).toBeDefined();
      expect(tables[0].primaryKey!.columns).toEqual(["order_id"]);
    });

    test("should parse composite PRIMARY KEY", () => {
      const sql = `
        CREATE TABLE user_roles (
          user_id INTEGER,
          role_id INTEGER,
          PRIMARY KEY (user_id, role_id)
        );
      `;

      const tables = parser.parseCreateTableStatements(sql);

      expect(tables).toHaveLength(1);
      expect(tables[0].primaryKey).toBeDefined();
      expect(tables[0].primaryKey!.columns).toEqual(["user_id", "role_id"]);
    });

    test("should parse named PRIMARY KEY constraint", () => {
      const sql = `
        CREATE TABLE sessions (
          session_id VARCHAR(255),
          user_id INTEGER,
          CONSTRAINT pk_sessions PRIMARY KEY (session_id, user_id)
        );
      `;

      const tables = parser.parseCreateTableStatements(sql);

      expect(tables).toHaveLength(1);
      expect(tables[0].primaryKey).toBeDefined();
      expect(tables[0].primaryKey!.name).toBe("pk_sessions");
      expect(tables[0].primaryKey!.columns).toEqual(["session_id", "user_id"]);
    });

    test("should handle table without PRIMARY KEY", () => {
      const sql = `
        CREATE TABLE logs (
          id INTEGER,
          message TEXT
        );
      `;

      const tables = parser.parseCreateTableStatements(sql);

      expect(tables).toHaveLength(1);
      expect(tables[0].primaryKey).toBeUndefined();
    });
  });

  describe("SQL Generation - Primary Key Operations", () => {
    test("should generate ADD CONSTRAINT for single column", () => {
      const primaryKey: PrimaryKeyConstraint = {
        columns: ["id"],
      };

      const sql = generateAddPrimaryKeySQL("users", primaryKey);

      expect(sql).toBe(
        "ALTER TABLE users ADD CONSTRAINT pk_users PRIMARY KEY (id);"
      );
    });

    test("should generate ADD CONSTRAINT for composite primary key", () => {
      const primaryKey: PrimaryKeyConstraint = {
        columns: ["user_id", "role_id"],
      };

      const sql = generateAddPrimaryKeySQL("user_roles", primaryKey);

      expect(sql).toBe(
        "ALTER TABLE user_roles ADD CONSTRAINT pk_user_roles PRIMARY KEY (user_id, role_id);"
      );
    });

    test("should generate ADD CONSTRAINT with custom name", () => {
      const primaryKey: PrimaryKeyConstraint = {
        name: "pk_custom_sessions",
        columns: ["session_id", "user_id"],
      };

      const sql = generateAddPrimaryKeySQL("sessions", primaryKey);

      expect(sql).toBe(
        "ALTER TABLE sessions ADD CONSTRAINT pk_custom_sessions PRIMARY KEY (session_id, user_id);"
      );
    });

    test("should generate DROP CONSTRAINT", () => {
      const sql = generateDropPrimaryKeySQL("users", "pk_users");

      expect(sql).toBe("ALTER TABLE users DROP CONSTRAINT pk_users;");
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
      const desiredTables = parser.parseCreateTableStatements(desiredSQL);
      const migrationStatements = differ.generateMigrationPlan(
        desiredTables,
        initialSchema
      );

      const plan: MigrationPlan = {
        statements: migrationStatements,
        hasChanges: migrationStatements.length > 0,
      };

      await executor.executePlan(client, plan);

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
      const desiredTables = parser.parseCreateTableStatements(desiredSQL);
      const migrationStatements = differ.generateMigrationPlan(
        desiredTables,
        initialSchema
      );

      const plan: MigrationPlan = {
        statements: migrationStatements,
        hasChanges: migrationStatements.length > 0,
      };

      await executor.executePlan(client, plan);

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
      const desiredTables = parser.parseCreateTableStatements(desiredSQL);
      const migrationStatements = differ.generateMigrationPlan(
        desiredTables,
        initialSchema
      );

      const plan: MigrationPlan = {
        statements: migrationStatements,
        hasChanges: migrationStatements.length > 0,
      };

      await executor.executePlan(client, plan);

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
      const desiredTables = parser.parseCreateTableStatements(desiredSQL);
      const migrationStatements = differ.generateMigrationPlan(
        desiredTables,
        initialSchema
      );

      // 4. Verify no migration statements generated
      expect(migrationStatements).toHaveLength(0);
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
      const desiredTables = parser.parseCreateTableStatements(desiredSQL);
      const migrationStatements = differ.generateMigrationPlan(
        desiredTables,
        initialSchema
      );

      const plan: MigrationPlan = {
        statements: migrationStatements,
        hasChanges: migrationStatements.length > 0,
      };

      await executor.executePlan(client, plan);

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

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });
});
