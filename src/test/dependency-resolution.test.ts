import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../core/schema/service";
import { DatabaseService } from "../core/database/client";
import { createTestClient, cleanDatabase, createTestDatabaseService } from "./utils";

describe("Dependency Resolution", () => {
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

  describe("Table Creation Order", () => {
    test("should create tables in correct dependency order", async () => {
      const schema = `
        -- Orders references Customers (should be created after)
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          order_date DATE DEFAULT CURRENT_DATE,
          total DECIMAL(10,2) NOT NULL,
          CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
        );

        -- Order Items references both Orders and Products
        CREATE TABLE order_items (
          id SERIAL PRIMARY KEY,
          order_id INTEGER NOT NULL,
          product_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders(id),
          CONSTRAINT fk_product FOREIGN KEY (product_id) REFERENCES products(id)
        );

        -- Products should be created early (referenced by order_items)
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL
        );

        -- Customers should be created early (referenced by orders)
        CREATE TABLE customers (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(255) NOT NULL
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify all tables exist
      const tables = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      expect(tables.rows.map(r => r.table_name)).toEqual([
        'customers', 'order_items', 'orders', 'products'
      ]);

      // Verify foreign keys work
      await client.query("INSERT INTO customers (name, email) VALUES ('John Doe', 'john@example.com')");
      await client.query("INSERT INTO products (name, price) VALUES ('Widget', 9.99)");
      await client.query("INSERT INTO orders (customer_id, total) VALUES (1, 19.98)");
      await client.query("INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (1, 1, 2, 9.99)");

      const orderCount = await client.query("SELECT COUNT(*) as count FROM orders");
      expect(orderCount.rows[0].count).toBe('1');
    });

    test("should handle multi-level dependencies", async () => {
      const schema = `
        -- Level 3: Depends on order_items
        CREATE TABLE shipment_items (
          id SERIAL PRIMARY KEY,
          shipment_id INTEGER NOT NULL,
          order_item_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL,
          CONSTRAINT fk_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id),
          CONSTRAINT fk_order_item FOREIGN KEY (order_item_id) REFERENCES order_items(id)
        );

        -- Level 2: Depends on orders and products  
        CREATE TABLE order_items (
          id SERIAL PRIMARY KEY,
          order_id INTEGER NOT NULL,
          product_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL,
          CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders(id),
          CONSTRAINT fk_product FOREIGN KEY (product_id) REFERENCES products(id)
        );

        -- Level 2: Depends on customers
        CREATE TABLE shipments (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          shipped_date DATE DEFAULT CURRENT_DATE,
          CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
        );

        -- Level 1: Depends on customers
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          order_date DATE DEFAULT CURRENT_DATE,
          CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
        );

        -- Level 0: No dependencies
        CREATE TABLE customers (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        -- Level 0: No dependencies
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Test the full dependency chain
      await client.query("INSERT INTO customers (name) VALUES ('Test Customer')");
      await client.query("INSERT INTO products (name) VALUES ('Test Product')");
      await client.query("INSERT INTO orders (customer_id) VALUES (1)");
      await client.query("INSERT INTO order_items (order_id, product_id, quantity) VALUES (1, 1, 5)");
      await client.query("INSERT INTO shipments (customer_id) VALUES (1)");
      await client.query("INSERT INTO shipment_items (shipment_id, order_item_id, quantity) VALUES (1, 1, 3)");

      const result = await client.query("SELECT COUNT(*) as count FROM shipment_items");
      expect(result.rows[0].count).toBe('1');
    });

    test("should handle circular foreign key dependencies", async () => {
      const schema = `
        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          manager_id INTEGER,
          CONSTRAINT fk_manager FOREIGN KEY (manager_id) REFERENCES employees(id)
        );

        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          department_id INTEGER,
          CONSTRAINT fk_department FOREIGN KEY (department_id) REFERENCES departments(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // For circular dependencies, one FK constraint should be added after table creation
      const constraints = await client.query(`
        SELECT 
          tc.table_name,
          tc.constraint_name,
          kcu.column_name,
          ccu.table_name as referenced_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
        ORDER BY tc.table_name, tc.constraint_name
      `);

      expect(constraints.rows).toHaveLength(2);
      
      // Test data insertion with circular references
      await client.query("INSERT INTO departments (name) VALUES ('Engineering')");
      await client.query("INSERT INTO employees (name, department_id) VALUES ('John Doe', 1)");
      await client.query("UPDATE departments SET manager_id = 1 WHERE id = 1");

      const dept = await client.query("SELECT manager_id FROM departments WHERE id = 1");
      expect(dept.rows[0].manager_id).toBe(1);
    });
  });

  describe("Table Deletion Order", () => {
    test("should drop tables in reverse dependency order", async () => {
      // First create tables with dependencies
      const createSchema = `
        CREATE TABLE customers (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
        );

        CREATE TABLE order_items (
          id SERIAL PRIMARY KEY,
          order_id INTEGER NOT NULL,
          CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders(id)
        );
      `;

      await schemaService.apply(createSchema, ['public'], true);

      // Insert some data
      await client.query("INSERT INTO customers (name) VALUES ('Test')");
      await client.query("INSERT INTO orders (customer_id) VALUES (1)");
      await client.query("INSERT INTO order_items (order_id) VALUES (1)");

      // Now drop all tables
      const emptySchema = ``;

      await schemaService.apply(emptySchema, ['public'], true);

      // Verify all tables are gone
      const tables = await client.query(`
        SELECT COUNT(*) as table_count
        FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);

      expect(tables.rows[0].table_count).toBe('0');
    });

    test("should handle partial table removal with dependencies", async () => {
      const initialSchema = `
        CREATE TABLE categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category_id INTEGER,
          CONSTRAINT fk_category FOREIGN KEY (category_id) REFERENCES categories(id)
        );

        CREATE TABLE order_items (
          id SERIAL PRIMARY KEY,
          product_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL,
          CONSTRAINT fk_product FOREIGN KEY (product_id) REFERENCES products(id)
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Remove products table (which is referenced by order_items and references categories)
      const updatedSchema = `
        CREATE TABLE categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE order_items (
          id SERIAL PRIMARY KEY,
          product_code VARCHAR(50) NOT NULL,
          quantity INTEGER NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      const tables = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      expect(tables.rows.map(r => r.table_name)).toEqual(['categories', 'order_items']);
    });
  });

  describe("Constraint Ordering", () => {
    test("should add foreign key constraints after all tables exist", async () => {
      const schema = `
        CREATE TABLE child_table (
          id SERIAL PRIMARY KEY,
          parent_id INTEGER NOT NULL,
          CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parent_table(id)
        );

        CREATE TABLE parent_table (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Both tables should exist
      const tables = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      expect(tables.rows.map(r => r.table_name)).toEqual(['child_table', 'parent_table']);

      // Foreign key should work
      await client.query("INSERT INTO parent_table (name) VALUES ('Parent')");
      await client.query("INSERT INTO child_table (parent_id) VALUES (1)");

      await expect(
        client.query("INSERT INTO child_table (parent_id) VALUES (999)")
      ).rejects.toThrow();
    });

    test("should drop foreign key constraints before dropping referenced tables", async () => {
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          title VARCHAR(255) NOT NULL,
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Remove users table (which is referenced by posts)
      const updatedSchema = `
        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          title VARCHAR(255) NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      // Should succeed - foreign key was dropped first
      const tables = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);

      expect(tables.rows.map(r => r.table_name)).toEqual(['posts']);

      // Foreign key should no longer exist
      const constraints = await client.query(`
        SELECT COUNT(*) as fk_count
        FROM information_schema.table_constraints
        WHERE table_name = 'posts' 
          AND constraint_type = 'FOREIGN KEY'
      `);

      expect(constraints.rows[0].fk_count).toBe('0');
    });
  });

  describe("Complex Dependency Scenarios", () => {
    test("should handle many-to-many relationships", async () => {
      const schema = `
        CREATE TABLE students (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE courses (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE enrollments (
          student_id INTEGER NOT NULL,
          course_id INTEGER NOT NULL,
          enrolled_date DATE DEFAULT CURRENT_DATE,
          grade CHAR(1),
          PRIMARY KEY (student_id, course_id),
          CONSTRAINT fk_student FOREIGN KEY (student_id) REFERENCES students(id),
          CONSTRAINT fk_course FOREIGN KEY (course_id) REFERENCES courses(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      await client.query("INSERT INTO students (name) VALUES ('Alice'), ('Bob')");
      await client.query("INSERT INTO courses (name) VALUES ('Math'), ('Science')");
      await client.query("INSERT INTO enrollments (student_id, course_id) VALUES (1, 1), (1, 2), (2, 1)");

      const enrollments = await client.query("SELECT COUNT(*) as count FROM enrollments");
      expect(enrollments.rows[0].count).toBe('3');
    });

    test("should handle self-referential dependencies with hierarchy", async () => {
      const schema = `
        CREATE TABLE categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          parent_id INTEGER,
          CONSTRAINT fk_parent_category FOREIGN KEY (parent_id) REFERENCES categories(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Create category hierarchy
      await client.query("INSERT INTO categories (name, parent_id) VALUES ('Electronics', NULL)");
      await client.query("INSERT INTO categories (name, parent_id) VALUES ('Computers', 1)");
      await client.query("INSERT INTO categories (name, parent_id) VALUES ('Laptops', 2)");

      const hierarchy = await client.query(`
        WITH RECURSIVE category_tree AS (
          SELECT id, name, parent_id, 0 as level
          FROM categories 
          WHERE parent_id IS NULL
          
          UNION ALL
          
          SELECT c.id, c.name, c.parent_id, ct.level + 1
          FROM categories c
          JOIN category_tree ct ON c.parent_id = ct.id
        )
        SELECT level, name FROM category_tree ORDER BY level, name
      `);

      expect(hierarchy.rows).toHaveLength(3);
      expect(hierarchy.rows[0]).toEqual({ level: 0, name: 'Electronics' });
      expect(hierarchy.rows[1]).toEqual({ level: 1, name: 'Computers' });
      expect(hierarchy.rows[2]).toEqual({ level: 2, name: 'Laptops' });
    });

    test("should handle cross-schema dependencies (when multiple schemas supported)", async () => {
      // Note: This test assumes future multi-schema support
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) NOT NULL,
          email VARCHAR(255) NOT NULL
        );

        -- This would reference a table in another schema in full implementation
        CREATE TABLE user_preferences (
          user_id INTEGER NOT NULL,
          preference_key VARCHAR(100) NOT NULL,
          preference_value TEXT,
          PRIMARY KEY (user_id, preference_key),
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      await client.query("INSERT INTO users (username, email) VALUES ('testuser', 'test@example.com')");
      await client.query("INSERT INTO user_preferences (user_id, preference_key, preference_value) VALUES (1, 'theme', 'dark')");

      const prefs = await client.query("SELECT COUNT(*) as count FROM user_preferences");
      expect(prefs.rows[0].count).toBe('1');
    });

    test("should handle dependency cycles with proper breaking", async () => {
      const schema = `
        CREATE TABLE teams (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          captain_id INTEGER,
          CONSTRAINT fk_captain FOREIGN KEY (captain_id) REFERENCES players(id)
        );

        CREATE TABLE players (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          team_id INTEGER,
          CONSTRAINT fk_team FOREIGN KEY (team_id) REFERENCES teams(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Insert data with careful ordering due to circular dependency
      await client.query("INSERT INTO teams (name) VALUES ('Red Team')");
      await client.query("INSERT INTO players (name, team_id) VALUES ('Alice', 1)");
      await client.query("UPDATE teams SET captain_id = 1 WHERE id = 1");

      const team = await client.query("SELECT captain_id FROM teams WHERE id = 1");
      const player = await client.query("SELECT team_id FROM players WHERE id = 1");
      
      expect(team.rows[0].captain_id).toBe(1);
      expect(player.rows[0].team_id).toBe(1);
    });
  });

  describe("Error Handling", () => {
    test("should provide clear error when dependency cannot be resolved", async () => {
      const schema = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES nonexistent_table(id)
        );
      `;

      await expect(schemaService.apply(schema, ['public'], true)).rejects.toThrow();
    });

    test("should handle missing column references", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(nonexistent_column)
        );
      `;

      await expect(schemaService.apply(schema, ['public'], true)).rejects.toThrow();
    });
  });

});