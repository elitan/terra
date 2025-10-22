import { describe, test, expect, beforeEach } from "bun:test";
import { SchemaParser } from "../../core/schema/parser";
import type { View } from "../../types/schema";

describe("View Parsing", () => {
  let parser: SchemaParser;

  beforeEach(() => {
    parser = new SchemaParser();
  });

  describe("Basic View Parsing", () => {
    test("should parse simple CREATE VIEW statement", async () => {
      const sql = `
        CREATE VIEW user_emails AS
        SELECT id, email FROM users;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.name).toBe('user_emails');
      expect(view.definition).toContain('SELECT');
      expect(view.definition).toContain('users');
      expect(view.materialized).toBeFalsy();
    });

    test("should parse CREATE MATERIALIZED VIEW statement", async () => {
      const sql = `
        CREATE MATERIALIZED VIEW user_stats AS
        SELECT COUNT(*) as total_users FROM users;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.name).toBe('user_stats');
      expect(view.materialized).toBe(true);
      expect(view.definition).toContain('SELECT');
      expect(view.definition).toContain('count');
    });

    test("should parse CREATE OR REPLACE VIEW statement", async () => {
      const sql = `
        CREATE OR REPLACE VIEW user_summary AS
        SELECT id, name, email FROM users WHERE active = true;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.name).toBe('user_summary');
      expect(view.definition).toContain('WHERE');
    });

    test("should parse views with complex SELECT statements", async () => {
      const sql = `
        CREATE VIEW sales_report AS
        SELECT 
          p.name as product_name,
          c.name as category_name,
          SUM(s.amount) as total_sales,
          COUNT(*) as transaction_count,
          AVG(s.amount) as avg_sale_amount
        FROM sales s
        JOIN products p ON s.product_id = p.id
        JOIN categories c ON p.category_id = c.id
        WHERE s.sale_date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY p.name, c.name
        HAVING SUM(s.amount) > 1000
        ORDER BY total_sales DESC;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.name).toBe('sales_report');
      expect(view.definition).toContain('JOIN');
      expect(view.definition).toContain('GROUP BY');
      expect(view.definition).toContain('HAVING');
    });

    test("should parse views with CTEs", async () => {
      const sql = `
        CREATE VIEW employee_hierarchy AS
        WITH RECURSIVE hierarchy AS (
          SELECT id, name, manager_id, 1 as level
          FROM employees
          WHERE manager_id IS NULL
          UNION ALL
          SELECT e.id, e.name, e.manager_id, h.level + 1
          FROM employees e
          JOIN hierarchy h ON e.manager_id = h.id
        )
        SELECT * FROM hierarchy ORDER BY level, name;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.name).toBe('employee_hierarchy');
      expect(view.definition).toContain('WITH RECURSIVE');
      expect(view.definition).toContain('UNION');
    });

    test("should parse views with window functions", async () => {
      const sql = `
        CREATE VIEW sales_rankings AS
        SELECT 
          salesperson_id,
          amount,
          sale_date,
          ROW_NUMBER() OVER (PARTITION BY salesperson_id ORDER BY amount DESC) as rank_in_person,
          RANK() OVER (ORDER BY amount DESC) as overall_rank,
          PERCENT_RANK() OVER (ORDER BY amount) as percentile_rank
        FROM sales;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.name).toBe('sales_rankings');
      expect(view.definition).toContain('row_number()');
      expect(view.definition).toContain('OVER');
      expect(view.definition).toContain('PARTITION BY');
    });
  });

  describe("View Options Parsing", () => {
    test("should parse WITH CHECK OPTION", async () => {
      const sql = `
        CREATE VIEW active_users AS
        SELECT id, email, active FROM users
        WHERE active = true
        WITH CHECK OPTION;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.name).toBe('active_users');
      expect(view.checkOption).toBe('CASCADED'); // Default
    });

    test("should parse WITH LOCAL CHECK OPTION", async () => {
      const sql = `
        CREATE VIEW local_active_users AS
        SELECT id, email FROM users
        WHERE active = true
        WITH LOCAL CHECK OPTION;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.checkOption).toBe('LOCAL');
    });

    test("should parse WITH CASCADED CHECK OPTION", async () => {
      const sql = `
        CREATE VIEW cascaded_active_users AS
        SELECT id, email FROM users
        WHERE active = true
        WITH CASCADED CHECK OPTION;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.checkOption).toBe('CASCADED');
    });

    test.skip("should parse security_barrier option", async () => {
      const sql = `
        CREATE VIEW secure_users AS
        SELECT id, email FROM users
        WITH (security_barrier = true);
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.securityBarrier).toBe(true);
    });
  });

  describe("Multiple Views Parsing", () => {
    test("should parse multiple views in single schema", async () => {
      const sql = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          active BOOLEAN DEFAULT true
        );

        CREATE VIEW active_users AS
        SELECT id, email FROM users WHERE active = true;

        CREATE VIEW inactive_users AS
        SELECT id, email FROM users WHERE active = false;

        CREATE MATERIALIZED VIEW user_stats AS
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN active THEN 1 END) as active_users,
          COUNT(CASE WHEN NOT active THEN 1 END) as inactive_users
        FROM users;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      expect(result.views).toHaveLength(3);

      const viewNames = result.views.map(v => v.name).sort();
      expect(viewNames).toEqual(['active_users', 'inactive_users', 'user_stats']);

      const materializedView = result.views.find(v => v.name === 'user_stats');
      expect(materializedView?.materialized).toBe(true);

      const regularViews = result.views.filter(v => !v.materialized);
      expect(regularViews).toHaveLength(2);
    });

    test("should handle view dependencies correctly", async () => {
      const sql = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          status VARCHAR(20),
          amount DECIMAL(10,2)
        );

        CREATE VIEW completed_orders AS
        SELECT * FROM orders WHERE status = 'completed';

        CREATE VIEW high_value_completed_orders AS
        SELECT * FROM completed_orders WHERE amount > 1000;

        CREATE MATERIALIZED VIEW order_summary AS
        SELECT COUNT(*) as total_orders FROM high_value_completed_orders;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      expect(result.views).toHaveLength(3);

      // Views should be parsed regardless of dependency order
      const viewNames = result.views.map(v => v.name).sort();
      expect(viewNames).toEqual([
        'completed_orders',
        'high_value_completed_orders', 
        'order_summary'
      ]);
    });
  });

  describe("Edge Cases and Error Handling", () => {
    test("should handle views with quoted identifiers", async () => {
      const sql = `
        CREATE VIEW "user-emails" AS
        SELECT "user_id", "email_address" FROM "user_profiles";
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.name).toBe('user-emails');
    });

    test("should handle views with schema-qualified table names", async () => {
      const sql = `
        CREATE VIEW public_users AS
        SELECT id, email FROM public.users;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.name).toBe('public_users');
      expect(view.definition).toContain('public.users');
    });

    test("should handle views with complex expressions", async () => {
      const sql = `
        CREATE VIEW user_analytics AS
        SELECT 
          id,
          email,
          CASE 
            WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN 'new'
            WHEN created_at >= CURRENT_DATE - INTERVAL '365 days' THEN 'recent'
            ELSE 'old'
          END as user_category,
          EXTRACT(YEAR FROM created_at) as signup_year,
          COALESCE(last_login, created_at) as last_activity,
          ARRAY[id, EXTRACT(EPOCH FROM created_at)::INTEGER] as user_data
        FROM users;
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.name).toBe('user_analytics');
      expect(view.definition).toContain('CASE');
      expect(view.definition).toContain('EXTRACT');
      expect(view.definition).toContain('COALESCE');
    });

    test("should reject invalid view syntax", async () => {
      const sql = `
        CREATE VIEW invalid_view AS
        SELEECT * FROM users;  -- Typo in SELECT
      `;

      await expect(parser.parseSchema(sql)).rejects.toThrow();
    });

    test("should handle empty view definitions gracefully", async () => {
      const sql = `
        CREATE VIEW empty_view AS;
      `;

      await expect(parser.parseSchema(sql)).rejects.toThrow();
    });

    test("should parse views with comments and whitespace", async () => {
      const sql = `
        -- This is a comment
        CREATE VIEW /* inline comment */ user_summary AS
        SELECT 
          id,           -- User ID
          email,        -- Email address
          active        -- Active status
        FROM users
        WHERE active = true;  -- Only active users
      `;

      const result = await parser.parseSchema(sql);
      expect(result.views).toHaveLength(1);

      const view = result.views[0];
      expect(view.name).toBe('user_summary');
    });
  });

  describe("Parser Integration", () => {
    test("should integrate with existing table and enum parsing", async () => {
      const sql = `
        CREATE TYPE user_status AS ENUM ('active', 'inactive', 'suspended');

        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          status user_status DEFAULT 'active'
        );

        CREATE VIEW active_users AS
        SELECT id, email FROM users WHERE status = 'active';

        CREATE INDEX idx_users_email ON users (email);
      `;

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      expect(result.views).toHaveLength(1);
      expect(result.enums).toHaveLength(1);

      // Verify table has index
      expect(result.tables[0].indexes).toHaveLength(1);
      
      // Verify enum
      expect(result.enums[0].name).toBe('user_status');
      expect(result.enums[0].values).toEqual(['active', 'inactive', 'suspended']);

      // Verify view
      expect(result.views[0].name).toBe('active_users');
    });
  });
});