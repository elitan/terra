import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { createTestClient, cleanDatabase, TEST_DB_CONFIG } from "../utils";

describe("Basic View Operations", () => {
  let client: Client;
  let schemaService: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    const databaseService = new DatabaseService(TEST_DB_CONFIG);
    schemaService = new SchemaService(databaseService);
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("Simple View Creation", () => {
    test("should create a basic view from a single table", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          name VARCHAR(100) NOT NULL,
          active BOOLEAN DEFAULT true
        );

        CREATE VIEW active_users AS 
        SELECT id, email, name 
        FROM users 
        WHERE active = true;
      `;

      await schemaService.apply(schema);

      // Verify base table exists
      const tableResult = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'users'
      `);
      expect(tableResult.rows).toHaveLength(1);

      // Verify view exists
      const viewResult = await client.query(`
        SELECT table_name, view_definition 
        FROM information_schema.views 
        WHERE table_schema = 'public' AND table_name = 'active_users'
      `);
      expect(viewResult.rows).toHaveLength(1);
      expect(viewResult.rows[0].view_definition).toContain("SELECT");
      expect(viewResult.rows[0].view_definition).toContain("users");
    });

    test("should handle views with column aliases", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          category_id INTEGER
        );

        CREATE VIEW product_summary AS
        SELECT 
          id AS product_id,
          name AS product_name,
          price,
          CASE 
            WHEN price > 100 THEN 'expensive'
            WHEN price > 50 THEN 'moderate'
            ELSE 'cheap'
          END AS price_category
        FROM products;
      `;

      await schemaService.apply(schema);

      // Verify view works with data
      await client.query(`INSERT INTO products (name, price) VALUES ('Test Product', 75.50)`);
      
      const result = await client.query(`SELECT * FROM product_summary`);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        product_id: 1,
        product_name: 'Test Product',
        price: '75.50',
        price_category: 'moderate'
      });
    });

    test("should create views with joins", async () => {
      const schema = `
        CREATE TABLE categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          category_id INTEGER REFERENCES categories(id)
        );

        CREATE VIEW products_with_categories AS
        SELECT 
          p.id,
          p.name AS product_name,
          p.price,
          c.name AS category_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id;
      `;

      await schemaService.apply(schema);

      // Test the view with sample data
      await client.query(`INSERT INTO categories (name) VALUES ('Electronics')`);
      await client.query(`INSERT INTO products (name, price, category_id) VALUES ('Laptop', 999.99, 1)`);
      
      const result = await client.query(`SELECT * FROM products_with_categories`);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].category_name).toBe('Electronics');
    });

    test("should support views with aggregations", async () => {
      const schema = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          total_amount DECIMAL(10,2) NOT NULL,
          order_date DATE DEFAULT CURRENT_DATE
        );

        CREATE VIEW customer_stats AS
        SELECT 
          customer_id,
          COUNT(*) AS order_count,
          SUM(total_amount) AS total_spent,
          AVG(total_amount) AS avg_order_value,
          MAX(order_date) AS last_order_date
        FROM orders
        GROUP BY customer_id;
      `;

      await schemaService.apply(schema);

      // Test aggregation view
      await client.query(`INSERT INTO orders (customer_id, total_amount) VALUES (1, 100.00), (1, 150.00), (2, 75.00)`);
      
      const result = await client.query(`SELECT * FROM customer_stats ORDER BY customer_id`);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toMatchObject({
        customer_id: 1,
        order_count: '2',
        total_spent: '250.00'
      });
    });

    test("should support views with window functions", async () => {
      const schema = `
        CREATE TABLE sales (
          id SERIAL PRIMARY KEY,
          salesperson_id INTEGER NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          sale_date DATE DEFAULT CURRENT_DATE
        );

        CREATE VIEW sales_rankings AS
        SELECT 
          salesperson_id,
          amount,
          sale_date,
          ROW_NUMBER() OVER (PARTITION BY salesperson_id ORDER BY amount DESC) as rank_in_person,
          RANK() OVER (ORDER BY amount DESC) as overall_rank
        FROM sales;
      `;

      await schemaService.apply(schema);

      // Test with sample data
      await client.query(`
        INSERT INTO sales (salesperson_id, amount) VALUES 
        (1, 1000.00), (1, 800.00), (2, 1200.00), (2, 900.00)
      `);
      
      const result = await client.query(`SELECT * FROM sales_rankings ORDER BY overall_rank`);
      expect(result.rows).toHaveLength(4);
      expect(result.rows[0].overall_rank).toBe('1'); // Top sale should be 1200.00
    });
  });

  describe("View Dependencies", () => {
    test("should handle views that depend on other views", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE VIEW active_users AS
        SELECT id, email, created_at
        FROM users
        WHERE active = true;

        CREATE VIEW recent_active_users AS
        SELECT id, email
        FROM active_users
        WHERE created_at >= CURRENT_DATE - INTERVAL '30 days';
      `;

      await schemaService.apply(schema);

      // Verify both views exist
      const viewResult = await client.query(`
        SELECT table_name 
        FROM information_schema.views 
        WHERE table_schema = 'public' 
        ORDER BY table_name
      `);
      expect(viewResult.rows).toHaveLength(2);
      expect(viewResult.rows.map(r => r.table_name)).toEqual(['active_users', 'recent_active_users']);
    });

    test("should create views in correct dependency order", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          price DECIMAL(10,2) NOT NULL
        );

        -- This view depends on product_summary (defined later)
        CREATE VIEW expensive_products AS
        SELECT *
        FROM product_summary
        WHERE price > 100;

        -- Base view
        CREATE VIEW product_summary AS
        SELECT id, name, price
        FROM products;
      `;

      await schemaService.apply(schema);

      // Both views should be created successfully
      const viewResult = await client.query(`
        SELECT COUNT(*) as view_count
        FROM information_schema.views 
        WHERE table_schema = 'public'
      `);
      expect(parseInt(viewResult.rows[0].view_count)).toBe(2);
    });
  });

  describe("View Modifications", () => {
    test("should handle view definition changes", async () => {
      // Initial schema with a simple view
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          name VARCHAR(100) NOT NULL,
          active BOOLEAN DEFAULT true
        );

        CREATE VIEW user_emails AS
        SELECT id, email
        FROM users;
      `;

      await schemaService.apply(initialSchema);

      // Updated schema with modified view
      const updatedSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          name VARCHAR(100) NOT NULL,
          active BOOLEAN DEFAULT true
        );

        CREATE VIEW user_emails AS
        SELECT id, email, name
        FROM users
        WHERE active = true;
      `;

      await schemaService.apply(updatedSchema);

      // Verify view was updated
      const viewResult = await client.query(`
        SELECT view_definition 
        FROM information_schema.views 
        WHERE table_schema = 'public' AND table_name = 'user_emails'
      `);
      expect(viewResult.rows[0].view_definition).toContain("name");
      expect(viewResult.rows[0].view_definition).toContain("active");
    });

    test("should handle view removal", async () => {
      // Initial schema with view
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );

        CREATE VIEW user_list AS
        SELECT * FROM users;
      `;

      await schemaService.apply(initialSchema);

      // Updated schema without view
      const updatedSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema);

      // Verify view was removed
      const viewResult = await client.query(`
        SELECT COUNT(*) as view_count
        FROM information_schema.views 
        WHERE table_schema = 'public'
      `);
      expect(parseInt(viewResult.rows[0].view_count)).toBe(0);
    });
  });

  describe("View Options", () => {
    test("should support WITH CHECK OPTION", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          active BOOLEAN DEFAULT true
        );

        CREATE VIEW active_users AS
        SELECT id, email, active
        FROM users
        WHERE active = true
        WITH CHECK OPTION;
      `;

      await schemaService.apply(schema);

      // Insert via view should work for active users
      await client.query(`INSERT INTO active_users (email, active) VALUES ('test@example.com', true)`);
      
      // Insert via view should fail for inactive users
      await expect(
        client.query(`INSERT INTO active_users (email, active) VALUES ('test2@example.com', false)`)
      ).rejects.toThrow();
    });

    test("should support OR REPLACE for view updates", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );

        CREATE OR REPLACE VIEW user_emails AS
        SELECT id, email
        FROM users;
      `;

      await schemaService.apply(schema);

      const viewResult = await client.query(`
        SELECT COUNT(*) as view_count
        FROM information_schema.views 
        WHERE table_schema = 'public' AND table_name = 'user_emails'
      `);
      expect(parseInt(viewResult.rows[0].view_count)).toBe(1);
    });
  });

  describe("Complex View Scenarios", () => {
    test("should handle views with CTEs (Common Table Expressions)", async () => {
      const schema = `
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          manager_id INTEGER REFERENCES employees(id),
          salary DECIMAL(10,2)
        );

        CREATE VIEW employee_hierarchy AS
        WITH RECURSIVE hierarchy AS (
          -- Base case: top-level managers
          SELECT id, name, manager_id, salary, 1 as level, name as path
          FROM employees
          WHERE manager_id IS NULL
          
          UNION ALL
          
          -- Recursive case: employees with managers
          SELECT e.id, e.name, e.manager_id, e.salary, h.level + 1, h.path || ' -> ' || e.name
          FROM employees e
          JOIN hierarchy h ON e.manager_id = h.id
        )
        SELECT * FROM hierarchy;
      `;

      await schemaService.apply(schema);

      // Test hierarchical data
      await client.query(`INSERT INTO employees (name, salary) VALUES ('CEO', 200000)`); // id=1
      await client.query(`INSERT INTO employees (name, manager_id, salary) VALUES ('CTO', 1, 150000)`); // id=2
      await client.query(`INSERT INTO employees (name, manager_id, salary) VALUES ('Developer', 2, 80000)`); // id=3
      
      const result = await client.query(`SELECT * FROM employee_hierarchy ORDER BY level, id`);
      expect(result.rows).toHaveLength(3);
      expect(result.rows[2].level).toBe(3); // Developer at level 3
      expect(result.rows[2].path).toContain('CEO -> CTO -> Developer');
    });

    test("should handle views with subqueries", async () => {
      const schema = `
        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          budget DECIMAL(12,2)
        );

        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          department_id INTEGER REFERENCES departments(id),
          salary DECIMAL(10,2)
        );

        CREATE VIEW department_over_budget AS
        SELECT 
          d.name as department_name,
          d.budget,
          (SELECT SUM(e.salary) FROM employees e WHERE e.department_id = d.id) as total_salaries,
          d.budget - (SELECT COALESCE(SUM(e.salary), 0) FROM employees e WHERE e.department_id = d.id) as remaining_budget
        FROM departments d
        WHERE d.budget < (SELECT COALESCE(SUM(e.salary), 0) FROM employees e WHERE e.department_id = d.id);
      `;

      await schemaService.apply(schema);

      // Test with sample data
      await client.query(`INSERT INTO departments (name, budget) VALUES ('Engineering', 200000)`);
      await client.query(`INSERT INTO employees (name, department_id, salary) VALUES ('Dev1', 1, 120000), ('Dev2', 1, 100000)`);
      
      const result = await client.query(`SELECT * FROM department_over_budget`);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].department_name).toBe('Engineering');
      expect(parseFloat(result.rows[0].remaining_budget)).toBeLessThan(0);
    });
  });

  describe("Error Handling", () => {
    test("should handle invalid view definitions gracefully", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );

        CREATE VIEW invalid_view AS
        SELECT * FROM nonexistent_table;
      `;

      await expect(schemaService.apply(schema)).rejects.toThrow();
    });

    test("should handle circular view dependencies", async () => {
      const schema = `
        CREATE TABLE base_table (
          id SERIAL PRIMARY KEY,
          value INTEGER
        );

        CREATE VIEW view_a AS
        SELECT * FROM view_b;

        CREATE VIEW view_b AS
        SELECT * FROM view_a;
      `;

      await expect(schemaService.apply(schema)).rejects.toThrow();
    });

    test("should validate view syntax during parsing", async () => {
      const schema = `
        CREATE VIEW syntax_error AS
        SELEECT * FROM users;  -- Intentional typo
      `;

      await expect(schemaService.apply(schema)).rejects.toThrow();
    });
  });
});