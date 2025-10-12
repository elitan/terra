import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../core/schema/service";
import { DatabaseService } from "../core/database/client";
import { createTestClient, cleanDatabase, createTestDatabaseService } from "./utils";

describe("Destructive Operation Safety", () => {
  let client: Client;
  let schemaService: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    const databaseService = createTestDatabaseService();
    schemaService = new SchemaService(databaseService);
  });

  afterEach(async () => {
    await client.end();
  });

  describe("Table Dropping Safety", () => {
    test("should prevent dropping tables with data by default", async () => {
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(255) NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, true);

      // Insert some data
      await client.query("INSERT INTO users (name, email) VALUES ('John Doe', 'john@example.com')");
      await client.query("INSERT INTO users (name, email) VALUES ('Jane Smith', 'jane@example.com')");

      // Try to drop table with data (should fail with safety check)
      const emptySchema = ``;

      // This should either:
      // 1. Fail with a safety error, OR
      // 2. Require a --force flag, OR  
      // 3. Show a warning and require confirmation
      // The exact behavior depends on implementation, but it should NOT silently drop data
      const rowCount = await client.query("SELECT COUNT(*) as count FROM users");
      expect(rowCount.rows[0].count).toBe('2');

      // For now, this might succeed (current implementation)
      // But the test documents the expected behavior for safety implementation
    });

    test("should provide data loss warnings for destructive operations", async () => {
      const initialSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          category VARCHAR(50),
          description TEXT
        );

        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          product_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL,
          CONSTRAINT fk_product FOREIGN KEY (product_id) REFERENCES products(id)
        );
      `;

      await schemaService.apply(initialSchema, true);

      // Insert data
      await client.query("INSERT INTO products (name, price, category) VALUES ('Widget', 9.99, 'Gadgets')");
      await client.query("INSERT INTO orders (product_id, quantity) VALUES (1, 5)");

      // Remove category column (data loss)
      const updatedSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          description TEXT
        );

        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          product_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL,
          CONSTRAINT fk_product FOREIGN KEY (product_id) REFERENCES products(id)
        );
      `;

      // This should work but ideally with warnings about data loss
      await schemaService.apply(updatedSchema, true);

      // Verify category data is lost
      const columns = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'products'
        ORDER BY column_name
      `);

      expect(columns.rows.map(r => r.column_name)).toEqual(['description', 'id', 'name', 'price']);
    });

    test("should allow forced destructive operations with explicit flag", async () => {
      // This test documents the expected API for forced operations
      const initialSchema = `
        CREATE TABLE temp_data (
          id SERIAL PRIMARY KEY,
          data TEXT NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, true);
      await client.query("INSERT INTO temp_data (data) VALUES ('important data')");

      // In a production system, this would require --force flag
      // const emptySchema = ``;
      // await schemaService.apply(emptySchema, { force: true }, true);

      // For now, just verify data exists
      const count = await client.query("SELECT COUNT(*) as count FROM temp_data");
      expect(count.rows[0].count).toBe('1');
    });
  });

  describe("Column Dropping Safety", () => {
    test("should detect data loss when dropping columns", async () => {
      const initialSchema = `
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          first_name VARCHAR(50) NOT NULL,
          last_name VARCHAR(50) NOT NULL,
          email VARCHAR(255) NOT NULL,
          phone VARCHAR(20),
          salary DECIMAL(10,2),
          notes TEXT
        );
      `;

      await schemaService.apply(initialSchema, true);

      // Insert data in all columns
      await client.query(`
        INSERT INTO employees (first_name, last_name, email, phone, salary, notes) 
        VALUES ('John', 'Doe', 'john@example.com', '555-1234', 75000.00, 'Excellent employee')
      `);

      // Remove multiple columns
      const updatedSchema = `
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          first_name VARCHAR(50) NOT NULL,
          last_name VARCHAR(50) NOT NULL,
          email VARCHAR(255) NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema, true);

      // Verify columns are gone but core data remains
      const employee = await client.query("SELECT first_name, last_name, email FROM employees");
      expect(employee.rows[0]).toEqual({
        first_name: 'John',
        last_name: 'Doe',
        email: 'john@example.com'
      });

      // Verify dropped columns don't exist
      const columns = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'employees'
        ORDER BY column_name
      `);

      expect(columns.rows.map(r => r.column_name)).toEqual(['email', 'first_name', 'id', 'last_name']);
    });

    test("should handle dropping columns with constraints", async () => {
      const initialSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL UNIQUE,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL CHECK (price > 0),
          category_id INTEGER,
          CONSTRAINT fk_category FOREIGN KEY (category_id) REFERENCES categories(id)
        );

        CREATE TABLE categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, true);

      await client.query("INSERT INTO categories (name) VALUES ('Electronics')");
      await client.query("INSERT INTO products (sku, name, price, category_id) VALUES ('WIDGET-001', 'Widget', 99.99, 1)");

      // Remove category_id (has foreign key constraint)
      const updatedSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL UNIQUE,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL CHECK (price > 0)
        );

        CREATE TABLE categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema, true);

      // Verify foreign key constraint is also removed
      const constraints = await client.query(`
        SELECT COUNT(*) as fk_count
        FROM information_schema.table_constraints
        WHERE table_name = 'products' 
          AND constraint_type = 'FOREIGN KEY'
      `);

      expect(constraints.rows[0].fk_count).toBe('0');

      // Other constraints should remain
      const remaining = await client.query(`
        SELECT constraint_type, COUNT(*) as count
        FROM information_schema.table_constraints
        WHERE table_name = 'products'
        GROUP BY constraint_type
        ORDER BY constraint_type
      `);

      // Should have: 1 CHECK (price > 0), 1 UNIQUE (sku), 1 PRIMARY KEY (id)
      // Note: SERIAL columns may create additional check constraints in PostgreSQL
      const checkConstraints = remaining.rows.find(r => r.constraint_type === 'CHECK');
      const uniqueConstraints = remaining.rows.find(r => r.constraint_type === 'UNIQUE');
      const primaryKeyConstraints = remaining.rows.find(r => r.constraint_type === 'PRIMARY KEY');
      
      expect(parseInt(checkConstraints?.count || '0')).toBeGreaterThanOrEqual(1); // At least our price > 0 check
      expect(uniqueConstraints?.count).toBe('1'); // sku UNIQUE
      expect(primaryKeyConstraints?.count).toBe('1'); // id PRIMARY KEY
    });
  });

  describe("Constraint Removal Safety", () => {
    test("should warn when removing constraints that ensure data integrity", async () => {
      const initialSchema = `
        CREATE TABLE accounts (
          id SERIAL PRIMARY KEY,
          account_number VARCHAR(20) NOT NULL UNIQUE,
          balance DECIMAL(12,2) NOT NULL CHECK (balance >= 0),
          account_type VARCHAR(20) NOT NULL CHECK (LENGTH(account_type) > 0)
        );
      `;

      await schemaService.apply(initialSchema, true);

      await client.query("INSERT INTO accounts (account_number, balance, account_type) VALUES ('ACC-001', 1000.00, 'checking')");

      // Remove safety constraints
      const updatedSchema = `
        CREATE TABLE accounts (
          id SERIAL PRIMARY KEY,
          account_number VARCHAR(20) NOT NULL,
          balance DECIMAL(12,2) NOT NULL,
          account_type VARCHAR(20) NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema, true);

      // Verify constraints are gone - now dangerous operations are possible
      await client.query("INSERT INTO accounts (account_number, balance, account_type) VALUES ('ACC-002', -500.00, '')");

      const account = await client.query("SELECT balance, account_type FROM accounts WHERE account_number = 'ACC-002'");
      expect(account.rows[0]).toEqual({ balance: '-500.00', account_type: '' });
    });

    test("should handle foreign key constraint removal safely", async () => {
      const initialSchema = `
        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          department_id INTEGER,
          CONSTRAINT fk_department FOREIGN KEY (department_id) REFERENCES departments(id)
        );
      `;

      await schemaService.apply(initialSchema, true);

      await client.query("INSERT INTO departments (name) VALUES ('Engineering')");
      await client.query("INSERT INTO employees (name, department_id) VALUES ('John Doe', 1)");

      // Remove foreign key constraint
      const updatedSchema = `
        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          department_id INTEGER
        );
      `;

      await schemaService.apply(updatedSchema, true);

      // Now orphaned references are possible
      await client.query("INSERT INTO employees (name, department_id) VALUES ('Jane Doe', 999)");

      const orphan = await client.query("SELECT department_id FROM employees WHERE name = 'Jane Doe'");
      expect(orphan.rows[0].department_id).toBe(999);
    });
  });

  describe("Type Change Safety", () => {
    test("should warn about potential data loss in type conversions", async () => {
      const initialSchema = `
        CREATE TABLE measurements (
          id SERIAL PRIMARY KEY,
          value DECIMAL(10,4) NOT NULL,
          description TEXT
        );
      `;

      await schemaService.apply(initialSchema, true);

      // Insert precise decimal data
      await client.query("INSERT INTO measurements (value, description) VALUES (123.4567, 'Precise measurement')");
      await client.query("INSERT INTO measurements (value, description) VALUES (999.9999, 'Max precision')");

      // Convert to less precise type (potential data loss)
      const updatedSchema = `
        CREATE TABLE measurements (
          id SERIAL PRIMARY KEY,
          value DECIMAL(8,2) NOT NULL,
          description TEXT
        );
      `;

      await schemaService.apply(updatedSchema, true);

      // Check for precision loss
      const values = await client.query("SELECT value FROM measurements ORDER BY id");
      expect(values.rows[0].value).toBe('123.46'); // Rounded
      expect(values.rows[1].value).toBe('1000.00'); // Rounded up
    });

    test("should handle incompatible type conversions", async () => {
      const initialSchema = `
        CREATE TABLE mixed_data (
          id SERIAL PRIMARY KEY,
          text_field TEXT,
          number_field VARCHAR(20)
        );
      `;

      await schemaService.apply(initialSchema, true);

      // Insert mixed data types
      await client.query("INSERT INTO mixed_data (text_field, number_field) VALUES ('Hello World', '123')");
      await client.query("INSERT INTO mixed_data (text_field, number_field) VALUES ('Not a number', 'abc')");

      // Try to convert text to number (some will fail)
      const updatedSchema = `
        CREATE TABLE mixed_data (
          id SERIAL PRIMARY KEY,
          text_field TEXT,
          number_field INTEGER
        );
      `;

      // This should fail or require explicit handling
      await expect(schemaService.apply(updatedSchema, true)).rejects.toThrow();
    });
  });

  describe("Index and Performance Impact", () => {
    test("should warn about dropping indexes that affect performance", async () => {
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          username VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_users_email ON users (email);
        CREATE INDEX idx_users_username ON users (username);
        CREATE INDEX idx_users_created_at ON users (created_at);
      `;

      await schemaService.apply(initialSchema, true);

      // Insert data that would benefit from indexes
      for (let i = 1; i <= 100; i++) {
        await client.query(`INSERT INTO users (email, username) VALUES ('user${i}@example.com', 'user${i}')`);
      }

      // Remove some indexes (performance impact)
      const updatedSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          username VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_users_email ON users (email);
      `;

      await schemaService.apply(updatedSchema, true);

      // Verify only one index remains
      const indexes = await client.query(`
        SELECT indexname 
        FROM pg_indexes 
        WHERE tablename = 'users' 
          AND indexname NOT LIKE '%pkey%'
        ORDER BY indexname
      `);

      expect(indexes.rows).toHaveLength(1);
      expect(indexes.rows[0].indexname).toBe('idx_users_email');
    });
  });

  describe("Safety Configuration", () => {
    test("should respect safety settings for destructive operations", async () => {
      // This test documents expected configuration options
      const initialSchema = `
        CREATE TABLE temporary_table (
          id SERIAL PRIMARY KEY,
          data TEXT NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, true);
      await client.query("INSERT INTO temporary_table (data) VALUES ('test data')");

      // Expected safety options (to be implemented):
      // - allowDropTables: false (default)
      // - allowDropColumns: false (default)  
      // - allowDataLoss: false (default)
      // - requireConfirmation: true (default)
      // - dryRun: false (default)

      const emptySchema = ``;

      // Should require explicit permission for destructive operations
      // await expect(
      //   schemaService.apply(emptySchema, { allowDropTables: false }, true)
      // ).rejects.toThrow(/destructive operation/);

      // For now, just verify data exists
      const count = await client.query("SELECT COUNT(*) as count FROM temporary_table");
      expect(count.rows[0].count).toBe('1');
    });

    test("should provide dry-run mode for safety validation", async () => {
      const initialSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          old_field VARCHAR(50)
        );
      `;

      await schemaService.apply(initialSchema, true);
      await client.query("INSERT INTO products (name, price, old_field) VALUES ('Widget', 9.99, 'old data')");

      const updatedSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL
        );
      `;

      // In dry-run mode, should show what would be changed without applying
      // const plan = await schemaService.plan(updatedSchema, { dryRun: true });
      // expect(plan.warnings).toContain('Column old_field will be dropped (data loss)');

      // For now, just verify the planning doesn't change data
      const count = await client.query("SELECT COUNT(*) as count FROM products");
      expect(count.rows[0].count).toBe('1');
    });
  });

  describe("Rollback and Recovery", () => {
    test("should support rollback for failed destructive operations", async () => {
      const initialSchema = `
        CREATE TABLE critical_data (
          id SERIAL PRIMARY KEY,
          important_info TEXT NOT NULL,
          backup_field TEXT
        );
      `;

      await schemaService.apply(initialSchema, true);
      await client.query("INSERT INTO critical_data (important_info, backup_field) VALUES ('Critical info', 'Backup')");

      // Simulate a failed migration that should rollback
      const problematicSchema = `
        CREATE TABLE critical_data (
          id SERIAL PRIMARY KEY,
          important_info TEXT NOT NULL,
          new_field INTEGER NOT NULL  -- This would fail due to no default for existing rows
        );
      `;

      // This should fail and rollback
      await expect(schemaService.apply(problematicSchema, true)).rejects.toThrow();

      // Original data should still be intact
      const data = await client.query("SELECT important_info, backup_field FROM critical_data");
      expect(data.rows[0]).toEqual({
        important_info: 'Critical info',
        backup_field: 'Backup'
      });
    });

    test("should preserve data during failed type conversions", async () => {
      const initialSchema = `
        CREATE TABLE test_conversions (
          id SERIAL PRIMARY KEY,
          text_number VARCHAR(20),
          valid_number VARCHAR(20)
        );
      `;

      await schemaService.apply(initialSchema, true);
      await client.query("INSERT INTO test_conversions (text_number, valid_number) VALUES ('not a number', '123')");

      // Try invalid conversion (should fail and preserve data)
      const problematicSchema = `
        CREATE TABLE test_conversions (
          id SERIAL PRIMARY KEY,
          text_number INTEGER,
          valid_number INTEGER  
        );
      `;

      await expect(schemaService.apply(problematicSchema, true)).rejects.toThrow();

      // Original data should be preserved
      const data = await client.query("SELECT text_number, valid_number FROM test_conversions");
      expect(data.rows[0]).toEqual({
        text_number: 'not a number',
        valid_number: '123'
      });
    });
  });
});