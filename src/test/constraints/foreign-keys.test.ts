import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { createTestClient, cleanDatabase, createTestDatabaseService } from "../utils";

describe("Foreign Key Constraints", () => {
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

  describe("Basic Foreign Key Operations", () => {
    test("should create a simple foreign key constraint", async () => {
      const schema = `
        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          department_id INTEGER NOT NULL,
          CONSTRAINT fk_department FOREIGN KEY (department_id) REFERENCES departments(id)
        );
      `;

      await schemaService.apply(schema);

      // Verify foreign key exists
      const result = await client.query(`
        SELECT 
          tc.constraint_name,
          tc.table_name,
          kcu.column_name,
          ccu.table_name AS referenced_table,
          ccu.column_name AS referenced_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu 
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu 
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' 
          AND tc.table_name = 'employees'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({
        constraint_name: 'fk_department',
        table_name: 'employees',
        column_name: 'department_id',
        referenced_table: 'departments',
        referenced_column: 'id'
      });
    });

    test("should create foreign key with ON DELETE CASCADE", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );

        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          user_id INTEGER NOT NULL,
          CONSTRAINT fk_user FOREIGN KEY (user_id) 
            REFERENCES users(id) 
            ON DELETE CASCADE
        );
      `;

      await schemaService.apply(schema);

      // Test CASCADE behavior
      await client.query("INSERT INTO users (email) VALUES ('test@example.com')");
      await client.query("INSERT INTO posts (title, user_id) VALUES ('Test Post', 1)");
      
      await client.query("DELETE FROM users WHERE id = 1");
      
      const posts = await client.query("SELECT * FROM posts");
      expect(posts.rows).toHaveLength(0); // Post should be deleted
    });

    test("should create foreign key with ON UPDATE CASCADE", async () => {
      const schema = `
        CREATE TABLE categories (
          code VARCHAR(10) PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          category_code VARCHAR(10),
          CONSTRAINT fk_category FOREIGN KEY (category_code) 
            REFERENCES categories(code) 
            ON UPDATE CASCADE
        );
      `;

      await schemaService.apply(schema);

      await client.query("INSERT INTO categories (code, name) VALUES ('ELEC', 'Electronics')");
      await client.query("INSERT INTO products (name, category_code) VALUES ('Laptop', 'ELEC')");
      
      await client.query("UPDATE categories SET code = 'TECH' WHERE code = 'ELEC'");
      
      const products = await client.query("SELECT category_code FROM products");
      expect(products.rows[0].category_code).toBe('TECH');
    });

    test("should handle composite foreign keys", async () => {
      const schema = `
        CREATE TABLE regions (
          country_code VARCHAR(2),
          region_code VARCHAR(3),
          name VARCHAR(100) NOT NULL,
          PRIMARY KEY (country_code, region_code)
        );

        CREATE TABLE cities (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          country_code VARCHAR(2) NOT NULL,
          region_code VARCHAR(3) NOT NULL,
          CONSTRAINT fk_region FOREIGN KEY (country_code, region_code) 
            REFERENCES regions(country_code, region_code)
        );
      `;

      await schemaService.apply(schema);

      // Verify composite foreign key
      const result = await client.query(`
        SELECT COUNT(*) as column_count
        FROM information_schema.key_column_usage
        WHERE constraint_name = 'fk_region'
      `);

      expect(result.rows[0].column_count).toBe('2');
    });
  });

  describe("Foreign Key Modifications", () => {
    test("should add foreign key to existing table", async () => {
      // Initial schema without foreign key
      const initialSchema = `
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

      await schemaService.apply(initialSchema);

      // Updated schema with foreign key
      const updatedSchema = `
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

      await schemaService.apply(updatedSchema);

      // Verify foreign key was added
      const result = await client.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'employees' 
          AND constraint_type = 'FOREIGN KEY'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].constraint_name).toBe('fk_department');
    });

    test("should drop foreign key constraint", async () => {
      // Initial schema with foreign key
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

      await schemaService.apply(initialSchema);

      // Updated schema without foreign key
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

      await schemaService.apply(updatedSchema);

      // Verify foreign key was dropped
      const result = await client.query(`
        SELECT COUNT(*) as fk_count
        FROM information_schema.table_constraints
        WHERE table_name = 'employees' 
          AND constraint_type = 'FOREIGN KEY'
      `);

      expect(result.rows[0].fk_count).toBe('0');
    });

    test("should modify foreign key action clauses", async () => {
      // Initial: ON DELETE RESTRICT (default)
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );

        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          user_id INTEGER NOT NULL,
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `;

      await schemaService.apply(initialSchema);

      // Updated: ON DELETE CASCADE
      const updatedSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );

        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          user_id INTEGER NOT NULL,
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `;

      await schemaService.apply(updatedSchema);

      // Test new CASCADE behavior
      await client.query("INSERT INTO users (email) VALUES ('test@example.com')");
      await client.query("INSERT INTO posts (title, user_id) VALUES ('Test Post', 1)");
      await client.query("DELETE FROM users WHERE id = 1");
      
      const posts = await client.query("SELECT * FROM posts");
      expect(posts.rows).toHaveLength(0);
    });
  });

  describe("Dependency Ordering", () => {
    test("should create tables in correct order when foreign keys exist", async () => {
      const schema = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
        );

        CREATE TABLE customers (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      // Should create customers first, then orders
      await schemaService.apply(schema);

      const tables = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      expect(tables.rows).toHaveLength(2);
      expect(tables.rows.map(r => r.table_name)).toEqual(['customers', 'orders']);
    });

    test("should drop tables in correct order when foreign keys exist", async () => {
      // Setup tables with foreign key
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

      await schemaService.apply(initialSchema);

      // Drop all tables
      const emptySchema = ``;

      // Should drop employees first, then departments
      await schemaService.apply(emptySchema);

      const tables = await client.query(`
        SELECT COUNT(*) as table_count
        FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);

      expect(tables.rows[0].table_count).toBe('0');
    });

    test("should handle circular foreign key dependencies", async () => {
      // For circular dependencies, use inline constraint syntax
      const schema = `
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          manager_id INTEGER,
          department_id INTEGER,
          CONSTRAINT fk_manager FOREIGN KEY (manager_id) REFERENCES employees(id),
          CONSTRAINT fk_department FOREIGN KEY (department_id) REFERENCES departments(id)
        );

        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          head_employee_id INTEGER,
          CONSTRAINT fk_head FOREIGN KEY (head_employee_id) REFERENCES employees(id)
        );
      `;

      await schemaService.apply(schema);

      // Verify all constraints exist
      const result = await client.query(`
        SELECT COUNT(*) as fk_count
        FROM information_schema.table_constraints
        WHERE constraint_type = 'FOREIGN KEY'
      `);

      expect(result.rows[0].fk_count).toBe('3');
    });
  });

  describe("Error Handling", () => {
    test("should fail when referencing non-existent table", async () => {
      const schema = `
        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          user_id INTEGER NOT NULL,
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `;

      await expect(schemaService.apply(schema)).rejects.toThrow();
    });

    test("should fail when referencing non-existent column", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );

        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          user_id INTEGER NOT NULL,
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(user_id)
        );
      `;

      await expect(schemaService.apply(schema)).rejects.toThrow();
    });

    test("should validate foreign key data integrity", async () => {
      const schema = `
        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          department_id INTEGER NOT NULL,
          CONSTRAINT fk_department FOREIGN KEY (department_id) REFERENCES departments(id)
        );
      `;

      await schemaService.apply(schema);

      // Try to insert employee with non-existent department
      await expect(
        client.query("INSERT INTO employees (name, department_id) VALUES ('John', 999)")
      ).rejects.toThrow();
    });
  });

  describe("Edge Cases", () => {
    test("should handle self-referential foreign keys", async () => {
      const schema = `
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          manager_id INTEGER,
          CONSTRAINT fk_manager FOREIGN KEY (manager_id) REFERENCES employees(id)
        );
      `;

      await schemaService.apply(schema);

      // Insert CEO (no manager)
      await client.query("INSERT INTO employees (name, manager_id) VALUES ('CEO', NULL)");
      
      // Insert employee with manager
      await client.query("INSERT INTO employees (name, manager_id) VALUES ('Employee', 1)");

      const result = await client.query("SELECT COUNT(*) as count FROM employees");
      expect(result.rows[0].count).toBe('2');
    });

    test("should handle multiple foreign keys to same table", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) NOT NULL
        );

        CREATE TABLE messages (
          id SERIAL PRIMARY KEY,
          content TEXT NOT NULL,
          sender_id INTEGER NOT NULL,
          receiver_id INTEGER NOT NULL,
          CONSTRAINT fk_sender FOREIGN KEY (sender_id) REFERENCES users(id),
          CONSTRAINT fk_receiver FOREIGN KEY (receiver_id) REFERENCES users(id)
        );
      `;

      await schemaService.apply(schema);

      const result = await client.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'messages' 
          AND constraint_type = 'FOREIGN KEY'
        ORDER BY constraint_name
      `);

      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].constraint_name).toBe('fk_receiver');
      expect(result.rows[1].constraint_name).toBe('fk_sender');
    });

    test("should preserve foreign keys when modifying unrelated columns", async () => {
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

      await schemaService.apply(initialSchema);

      // Add new column, foreign key should remain
      const updatedSchema = `
        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(255),
          department_id INTEGER,
          CONSTRAINT fk_department FOREIGN KEY (department_id) REFERENCES departments(id)
        );
      `;

      await schemaService.apply(updatedSchema);

      const result = await client.query(`
        SELECT COUNT(*) as fk_count
        FROM information_schema.table_constraints
        WHERE table_name = 'employees' 
          AND constraint_type = 'FOREIGN KEY'
      `);

      expect(result.rows[0].fk_count).toBe('1');
    });
  });
});