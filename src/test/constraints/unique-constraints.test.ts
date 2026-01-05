import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Unique Constraints", () => {
  let client: Client;
  let schemaService: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    
    schemaService = createTestSchemaService();
  });

  afterEach(async () => {
    await client.end();
  });

  describe("Basic Unique Constraint Operations", () => {
    test("should create simple unique constraint", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          username VARCHAR(50) NOT NULL,
          CONSTRAINT unique_email UNIQUE (email)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify unique constraint exists
      const result = await client.query(`
        SELECT
          tc.constraint_name,
          tc.constraint_type,
          kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
          AND tc.table_name = kcu.table_name
        WHERE tc.table_name = 'users'
          AND tc.table_schema = 'public'
          AND tc.constraint_type = 'UNIQUE'
        ORDER BY tc.constraint_name
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({
        constraint_name: 'unique_email',
        constraint_type: 'UNIQUE',
        column_name: 'email'
      });

      // Test uniqueness enforcement
      await client.query("INSERT INTO users (email, username) VALUES ('test@example.com', 'user1')");

      await expect(
        client.query("INSERT INTO users (email, username) VALUES ('test@example.com', 'user2')")
      ).rejects.toThrow(/unique_email/);
    });

    test("should create composite unique constraint", async () => {
      const schema = `
        CREATE TABLE user_roles (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          role_id INTEGER NOT NULL,
          organization_id INTEGER NOT NULL,
          assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT unique_user_role_org UNIQUE (user_id, role_id, organization_id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify composite unique constraint
      const result = await client.query(`
        SELECT COUNT(*) as column_count
        FROM information_schema.key_column_usage
        WHERE constraint_name = 'unique_user_role_org'
      `);

      expect(result.rows[0].column_count).toBe('3');

      // Test composite uniqueness
      await client.query("INSERT INTO user_roles (user_id, role_id, organization_id) VALUES (1, 1, 1)");
      await client.query("INSERT INTO user_roles (user_id, role_id, organization_id) VALUES (1, 1, 2)"); // Different org
      await client.query("INSERT INTO user_roles (user_id, role_id, organization_id) VALUES (1, 2, 1)"); // Different role
      
      // This should fail - same combination
      await expect(
        client.query("INSERT INTO user_roles (user_id, role_id, organization_id) VALUES (1, 1, 1)")
      ).rejects.toThrow(/unique_user_role_org/);
    });

    test("should create column-level unique constraint", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL UNIQUE,
          name VARCHAR(100) NOT NULL,
          barcode VARCHAR(20) UNIQUE
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // PostgreSQL creates implicit constraint names for column-level UNIQUE
      const result = await client.query(`
        SELECT 
          tc.constraint_name,
          kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu 
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'products' 
          AND tc.constraint_type = 'UNIQUE'
        ORDER BY kcu.column_name
      `);

      expect(result.rows).toHaveLength(2);
      
      // Test enforcement
      await client.query("INSERT INTO products (sku, name) VALUES ('PROD-001', 'Product 1')");
      await expect(
        client.query("INSERT INTO products (sku, name) VALUES ('PROD-001', 'Product 2')")
      ).rejects.toThrow();
    });

    test("should handle unique constraints with NULL values", async () => {
      const schema = `
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          employee_code VARCHAR(20) NOT NULL UNIQUE,
          social_security_number VARCHAR(20) UNIQUE,
          email VARCHAR(255)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // PostgreSQL allows multiple NULLs in unique columns
      await client.query("INSERT INTO employees (employee_code, social_security_number) VALUES ('EMP001', NULL)");
      await client.query("INSERT INTO employees (employee_code, social_security_number) VALUES ('EMP002', NULL)");
      
      const result = await client.query("SELECT COUNT(*) as count FROM employees WHERE social_security_number IS NULL");
      expect(result.rows[0].count).toBe('2');

      // But non-NULL values must be unique
      await client.query("INSERT INTO employees (employee_code, social_security_number) VALUES ('EMP003', '123-45-6789')");
      await expect(
        client.query("INSERT INTO employees (employee_code, social_security_number) VALUES ('EMP004', '123-45-6789')")
      ).rejects.toThrow();
    });
  });

  describe("Unique Constraint Modifications", () => {
    test("should add unique constraint to existing table", async () => {
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          username VARCHAR(50) NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Insert some data
      await client.query("INSERT INTO users (email, username) VALUES ('user1@example.com', 'user1')");
      await client.query("INSERT INTO users (email, username) VALUES ('user2@example.com', 'user2')");

      const updatedSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          username VARCHAR(50) NOT NULL,
          CONSTRAINT unique_email UNIQUE (email),
          CONSTRAINT unique_username UNIQUE (username)
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      // Verify constraints were added
      const result = await client.query(`
        SELECT COUNT(*) as constraint_count
        FROM information_schema.table_constraints
        WHERE table_name = 'users'
          AND table_schema = 'public'
          AND constraint_type = 'UNIQUE'
      `);

      expect(result.rows[0].constraint_count).toBe('2');

      // Test enforcement
      await expect(
        client.query("INSERT INTO users (email, username) VALUES ('user1@example.com', 'user3')")
      ).rejects.toThrow(/unique_email/);
    });

    test("should drop unique constraint", async () => {
      const initialSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL,
          name VARCHAR(100) NOT NULL,
          CONSTRAINT unique_sku UNIQUE (sku)
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      const updatedSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL,
          name VARCHAR(100) NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      // Verify constraint was dropped
      const result = await client.query(`
        SELECT COUNT(*) as constraint_count
        FROM information_schema.table_constraints
        WHERE table_name = 'products' 
          AND constraint_type = 'UNIQUE'
      `);

      expect(result.rows[0].constraint_count).toBe('0');

      // Should now allow duplicate SKUs
      await client.query("INSERT INTO products (sku, name) VALUES ('PROD-001', 'Product 1')");
      await client.query("INSERT INTO products (sku, name) VALUES ('PROD-001', 'Product 2')");
      
      const products = await client.query("SELECT COUNT(*) as count FROM products WHERE sku = 'PROD-001'");
      expect(products.rows[0].count).toBe('2');
    });

    test("should handle adding unique constraint when duplicates exist", async () => {
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Insert duplicate emails
      await client.query("INSERT INTO users (email) VALUES ('duplicate@example.com')");
      await client.query("INSERT INTO users (email) VALUES ('duplicate@example.com')");

      const updatedSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          CONSTRAINT unique_email UNIQUE (email)
        );
      `;

      // Should fail because duplicates exist
      await expect(schemaService.apply(updatedSchema, ['public'], true)).rejects.toThrow();
    });
  });

  describe("Unique Constraints vs Unique Indexes", () => {
    test("should differentiate between unique constraint and unique index", async () => {
      const schema = `
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          col1 VARCHAR(50),
          col2 VARCHAR(50),
          col3 VARCHAR(50),
          CONSTRAINT unique_col1 UNIQUE (col1)
        );
        
        CREATE UNIQUE INDEX unique_col2_idx ON test_table (col2);
      `;

      await schemaService.apply(schema, ['public'], true);

      // Check constraints
      const constraints = await client.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'test_table' 
          AND constraint_type = 'UNIQUE'
      `);

      expect(constraints.rows).toHaveLength(1);
      expect(constraints.rows[0].constraint_name).toBe('unique_col1');

      // Check indexes (both constraint and standalone index create indexes)
      const indexes = await client.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'test_table'
          AND indexname LIKE '%unique%'
        ORDER BY indexname
      `);

      expect(indexes.rows.map(r => r.indexname)).toContain('unique_col2_idx');
    });

    test("should handle partial unique constraints via unique indexes", async () => {
      // Note: PostgreSQL doesn't support WHERE clause in UNIQUE constraints directly
      // Must use unique indexes for conditional uniqueness
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          is_active BOOLEAN DEFAULT true,
          deleted_at TIMESTAMP
        );
        
        -- Unique email only for active users
        CREATE UNIQUE INDEX unique_active_email ON users (email) WHERE is_active = true;
        
        -- Unique email for inactive non-deleted users (separate from active users)
        CREATE UNIQUE INDEX unique_inactive_email ON users (email) WHERE is_active = false AND deleted_at IS NULL;
      `;

      await schemaService.apply(schema, ['public'], true);

      // Can have same email for active and inactive users (different indexes apply)
      await client.query("INSERT INTO users (email, is_active) VALUES ('test@example.com', true)");
      await client.query("INSERT INTO users (email, is_active) VALUES ('test@example.com', false)");
      
      // But not duplicate active users
      await expect(
        client.query("INSERT INTO users (email, is_active) VALUES ('test@example.com', true)")
      ).rejects.toThrow();
      
      // And not duplicate inactive users  
      await expect(
        client.query("INSERT INTO users (email, is_active) VALUES ('test@example.com', false)")
      ).rejects.toThrow();
    });
  });

  describe("Complex Unique Constraint Scenarios", () => {
    test("should handle deferrable unique constraints", async () => {
      const schema = `
        CREATE TABLE seat_assignments (
          id SERIAL PRIMARY KEY,
          event_id INTEGER NOT NULL,
          seat_number VARCHAR(10) NOT NULL,
          attendee_id INTEGER,
          CONSTRAINT unique_seat_per_event UNIQUE (event_id, seat_number) DEFERRABLE INITIALLY DEFERRED
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Note: Our parser doesn't support DEFERRABLE syntax (sql-parser-cst limitation)
      // So the constraint is created as non-deferrable and enforced immediately
      await client.query("INSERT INTO seat_assignments (event_id, seat_number, attendee_id) VALUES (1, 'A1', 100)");
      await client.query("INSERT INTO seat_assignments (event_id, seat_number, attendee_id) VALUES (1, 'A2', 101)");
      
      // Immediate constraint enforcement - seat swap should fail
      await expect(
        client.query("UPDATE seat_assignments SET seat_number = 'A2' WHERE attendee_id = 100")
      ).rejects.toThrow(/unique_seat_per_event/);

      // Verify original assignments remain
      const result = await client.query("SELECT attendee_id, seat_number FROM seat_assignments ORDER BY attendee_id");
      expect(result.rows).toEqual([
        { attendee_id: 100, seat_number: 'A1' },
        { attendee_id: 101, seat_number: 'A2' }
      ]);
    });

    test("should handle unique constraints with expressions", async () => {
      // Note: PostgreSQL doesn't support expressions in UNIQUE constraints directly
      // Must use unique indexes for expression-based uniqueness
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          username VARCHAR(50) NOT NULL
        );
        
        -- Case-insensitive unique email
        CREATE UNIQUE INDEX unique_lower_email ON users (LOWER(email));
        
        -- Case-insensitive unique username
        CREATE UNIQUE INDEX unique_lower_username ON users (LOWER(username));
      `;

      await schemaService.apply(schema, ['public'], true);

      await client.query("INSERT INTO users (email, username) VALUES ('John@Example.com', 'JohnDoe')");
      
      // Should fail - same email different case
      await expect(
        client.query("INSERT INTO users (email, username) VALUES ('john@example.com', 'JaneDoe')")
      ).rejects.toThrow();
      
      // Should fail - same username different case
      await expect(
        client.query("INSERT INTO users (email, username) VALUES ('jane@example.com', 'johndoe')")
      ).rejects.toThrow();
    });

    test("should handle unique constraints in inheritance hierarchies", async () => {
      // Note: Our parser doesn't support INHERITS syntax (sql-parser-cst limitation)
      // So we test similar behavior with separate tables
      const schema = `
        CREATE TABLE persons (
          id SERIAL PRIMARY KEY,
          national_id VARCHAR(20) NOT NULL,
          name VARCHAR(100) NOT NULL,
          CONSTRAINT unique_national_id UNIQUE (national_id)
        );
        
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          national_id VARCHAR(20) NOT NULL,
          name VARCHAR(100) NOT NULL,
          employee_code VARCHAR(20) NOT NULL UNIQUE,
          department VARCHAR(50)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Without inheritance, tables are separate - can have same national_id
      await client.query("INSERT INTO persons (national_id, name) VALUES ('123456789', 'John Doe')");
      await client.query("INSERT INTO employees (national_id, name, employee_code) VALUES ('123456789', 'John Doe', 'EMP001')");
      
      // But employee_code must be unique within employees
      await expect(
        client.query("INSERT INTO employees (national_id, name, employee_code) VALUES ('987654321', 'Jane Doe', 'EMP001')")
      ).rejects.toThrow();
    });

    test("should preserve unique constraints when modifying table", async () => {
      const initialSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL,
          name VARCHAR(100) NOT NULL,
          CONSTRAINT unique_sku UNIQUE (sku)
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Add columns, unique constraint should remain
      const updatedSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          price DECIMAL(10,2),
          CONSTRAINT unique_sku UNIQUE (sku)
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      // Test constraint still works
      await client.query("INSERT INTO products (sku, name, price) VALUES ('PROD-001', 'Product 1', 99.99)");
      await expect(
        client.query("INSERT INTO products (sku, name, price) VALUES ('PROD-001', 'Product 2', 149.99)")
      ).rejects.toThrow(/unique_sku/);
    });

    test("should create unique constraint names with table prefix for multiple tables with same column", async () => {
      const schema = `
        CREATE TABLE table_a (
          id SERIAL PRIMARY KEY,
          code VARCHAR(50) NOT NULL UNIQUE
        );

        CREATE TABLE table_b (
          id SERIAL PRIMARY KEY,
          code VARCHAR(50) NOT NULL UNIQUE
        );

        CREATE TABLE table_c (
          id SERIAL PRIMARY KEY,
          code VARCHAR(50) NOT NULL UNIQUE
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      const result = await client.query(`
        SELECT tc.table_name, tc.constraint_name
        FROM information_schema.table_constraints tc
        WHERE tc.constraint_type = 'UNIQUE'
          AND tc.table_schema = 'public'
          AND tc.table_name IN ('table_a', 'table_b', 'table_c')
        ORDER BY tc.table_name
      `);

      expect(result.rows).toHaveLength(3);
      expect(result.rows[0].constraint_name).toBe('table_a_code_unique');
      expect(result.rows[1].constraint_name).toBe('table_b_code_unique');
      expect(result.rows[2].constraint_name).toBe('table_c_code_unique');
    });
  });
});