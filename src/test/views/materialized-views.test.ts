import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { createTestClient, cleanDatabase, TEST_DB_CONFIG } from "../utils";

describe("Materialized View Operations", () => {
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

  describe("Basic Materialized Views", () => {
    test("should create a materialized view", async () => {
      const schema = `
        CREATE TABLE sales (
          id SERIAL PRIMARY KEY,
          product_id INTEGER NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          sale_date DATE DEFAULT CURRENT_DATE
        );

        CREATE MATERIALIZED VIEW daily_sales_summary AS
        SELECT 
          sale_date,
          COUNT(*) as transaction_count,
          SUM(amount) as total_amount,
          AVG(amount) as avg_amount
        FROM sales
        GROUP BY sale_date;
      `;

      await schemaService.apply(schema);

      // Verify materialized view exists
      const matViewResult = await client.query(`
        SELECT matviewname 
        FROM pg_matviews 
        WHERE schemaname = 'public' AND matviewname = 'daily_sales_summary'
      `);
      expect(matViewResult.rows).toHaveLength(1);

      // Verify we can query it (even though it's empty initially)
      const queryResult = await client.query(`SELECT * FROM daily_sales_summary`);
      expect(queryResult.rows).toHaveLength(0);
    });

    test("should handle materialized view with data", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          category VARCHAR(100)
        );

        CREATE MATERIALIZED VIEW category_stats AS
        SELECT 
          category,
          COUNT(*) as product_count,
          AVG(price) as avg_price,
          MIN(price) as min_price,
          MAX(price) as max_price
        FROM products
        GROUP BY category;
      `;

      await schemaService.apply(schema);

      // Add sample data
      await client.query(`
        INSERT INTO products (name, price, category) VALUES 
        ('Laptop', 999.99, 'Electronics'),
        ('Mouse', 29.99, 'Electronics'),
        ('Desk', 299.99, 'Furniture'),
        ('Chair', 199.99, 'Furniture')
      `);

      // Refresh the materialized view
      await client.query(`REFRESH MATERIALIZED VIEW category_stats`);

      // Query the materialized view
      const result = await client.query(`SELECT * FROM category_stats ORDER BY category`);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toMatchObject({
        category: 'Electronics',
        product_count: '2'
      });
      expect(result.rows[1]).toMatchObject({
        category: 'Furniture',
        product_count: '2'
      });
    });

    test("should support materialized views with indexes", async () => {
      const schema = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          event_type VARCHAR(50) NOT NULL,
          user_id INTEGER NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE MATERIALIZED VIEW hourly_event_stats AS
        SELECT 
          DATE_TRUNC('hour', created_at) as hour,
          event_type,
          COUNT(*) as event_count
        FROM events
        GROUP BY DATE_TRUNC('hour', created_at), event_type;

        CREATE INDEX idx_hourly_stats_hour ON hourly_event_stats (hour);
        CREATE INDEX idx_hourly_stats_type ON hourly_event_stats (event_type);
      `;

      await schemaService.apply(schema);

      // Verify materialized view and indexes exist
      const matViewResult = await client.query(`
        SELECT matviewname 
        FROM pg_matviews 
        WHERE schemaname = 'public' AND matviewname = 'hourly_event_stats'
      `);
      expect(matViewResult.rows).toHaveLength(1);

      // Verify indexes on materialized view
      const indexResult = await client.query(`
        SELECT indexname 
        FROM pg_indexes 
        WHERE schemaname = 'public' AND tablename = 'hourly_event_stats'
        ORDER BY indexname
      `);
      expect(indexResult.rows).toHaveLength(2);
      expect(indexResult.rows.map(r => r.indexname)).toEqual([
        'idx_hourly_stats_hour',
        'idx_hourly_stats_type'
      ]);
    });

    test("should support materialized views with unique indexes", async () => {
      const schema = `
        CREATE TABLE user_profiles (
          user_id INTEGER PRIMARY KEY,
          username VARCHAR(50) UNIQUE NOT NULL,
          email VARCHAR(255) NOT NULL,
          last_login TIMESTAMP
        );

        CREATE MATERIALIZED VIEW user_summary AS
        SELECT 
          user_id,
          username,
          email
        FROM user_profiles;

        CREATE UNIQUE INDEX idx_user_summary_user_id ON user_summary (user_id);
        CREATE UNIQUE INDEX idx_user_summary_username ON user_summary (username);
      `;

      await schemaService.apply(schema);

      // Add test data and refresh
      await client.query(`
        INSERT INTO user_profiles (user_id, username, email) VALUES 
        (1, 'john_doe', 'john@example.com'),
        (2, 'jane_smith', 'jane@example.com')
      `);
      await client.query(`REFRESH MATERIALIZED VIEW user_summary`);

      // Verify unique constraint works
      const result = await client.query(`SELECT * FROM user_summary ORDER BY user_id`);
      expect(result.rows).toHaveLength(2);

      // Test that we can use the index for lookups
      const lookupResult = await client.query(`
        SELECT username FROM user_summary WHERE user_id = 1
      `);
      expect(lookupResult.rows[0].username).toBe('john_doe');
    });
  });

  describe("Materialized View Refresh", () => {
    test("should handle REFRESH MATERIALIZED VIEW", async () => {
      const schema = `
        CREATE TABLE counters (
          id SERIAL PRIMARY KEY,
          name VARCHAR(50) NOT NULL,
          value INTEGER DEFAULT 0
        );

        CREATE MATERIALIZED VIEW counter_summary AS
        SELECT 
          COUNT(*) as total_counters,
          SUM(value) as total_value,
          AVG(value::decimal) as avg_value
        FROM counters;
      `;

      await schemaService.apply(schema);

      // Initially empty
      await client.query(`REFRESH MATERIALIZED VIEW counter_summary`);
      let result = await client.query(`SELECT * FROM counter_summary`);
      expect(result.rows[0].total_counters).toBe('0');

      // Add data
      await client.query(`INSERT INTO counters (name, value) VALUES ('counter1', 10), ('counter2', 20)`);
      
      // Before refresh - old data
      result = await client.query(`SELECT * FROM counter_summary`);
      expect(result.rows[0].total_counters).toBe('0');

      // After refresh - new data
      await client.query(`REFRESH MATERIALIZED VIEW counter_summary`);
      result = await client.query(`SELECT * FROM counter_summary`);
      expect(result.rows[0].total_counters).toBe('2');
      expect(result.rows[0].total_value).toBe('30');
    });

    test("should support REFRESH MATERIALIZED VIEW CONCURRENTLY", async () => {
      const schema = `
        CREATE TABLE activity_log (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          action VARCHAR(50) NOT NULL,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE MATERIALIZED VIEW user_activity_counts AS
        SELECT 
          user_id,
          COUNT(*) as activity_count,
          MAX(timestamp) as last_activity
        FROM activity_log
        GROUP BY user_id;

        -- Create unique index to enable concurrent refresh
        CREATE UNIQUE INDEX idx_user_activity_user_id ON user_activity_counts (user_id);
      `;

      await schemaService.apply(schema);

      // Add initial data and refresh
      await client.query(`
        INSERT INTO activity_log (user_id, action) VALUES 
        (1, 'login'), (1, 'view_page'), (2, 'login')
      `);
      await client.query(`REFRESH MATERIALIZED VIEW user_activity_counts`);

      // Verify initial state
      let result = await client.query(`
        SELECT user_id, activity_count 
        FROM user_activity_counts 
        ORDER BY user_id
      `);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].activity_count).toBe('2'); // user 1
      expect(result.rows[1].activity_count).toBe('1'); // user 2

      // Add more data
      await client.query(`INSERT INTO activity_log (user_id, action) VALUES (1, 'logout')`);

      // Concurrent refresh (doesn't block reads)
      await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY user_activity_counts`);

      // Verify updated state
      result = await client.query(`
        SELECT activity_count 
        FROM user_activity_counts 
        WHERE user_id = 1
      `);
      expect(result.rows[0].activity_count).toBe('3');
    });
  });

  describe("Materialized View Dependencies", () => {
    test("should handle materialized views that depend on regular views", async () => {
      const schema = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          order_date DATE DEFAULT CURRENT_DATE,
          status VARCHAR(20) DEFAULT 'pending'
        );

        CREATE VIEW completed_orders AS
        SELECT id, customer_id, amount, order_date
        FROM orders
        WHERE status = 'completed';

        CREATE MATERIALIZED VIEW monthly_revenue AS
        SELECT 
          DATE_TRUNC('month', order_date) as month,
          COUNT(*) as order_count,
          SUM(amount) as total_revenue
        FROM completed_orders
        GROUP BY DATE_TRUNC('month', order_date);
      `;

      await schemaService.apply(schema);

      // Verify both view and materialized view exist
      const viewResult = await client.query(`
        SELECT table_name 
        FROM information_schema.views 
        WHERE table_schema = 'public' AND table_name = 'completed_orders'
      `);
      expect(viewResult.rows).toHaveLength(1);

      const matViewResult = await client.query(`
        SELECT matviewname 
        FROM pg_matviews 
        WHERE schemaname = 'public' AND matviewname = 'monthly_revenue'
      `);
      expect(matViewResult.rows).toHaveLength(1);
    });

    test("should handle complex materialized view dependencies", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          category_id INTEGER NOT NULL,
          price DECIMAL(10,2) NOT NULL
        );

        CREATE TABLE categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          parent_id INTEGER REFERENCES categories(id)
        );

        CREATE VIEW products_with_categories AS
        SELECT 
          p.id,
          p.name as product_name,
          p.price,
          c.name as category_name,
          c.parent_id
        FROM products p
        JOIN categories c ON p.category_id = c.id;

        CREATE MATERIALIZED VIEW category_price_stats AS
        SELECT 
          category_name,
          COUNT(*) as product_count,
          AVG(price) as avg_price,
          MIN(price) as min_price,
          MAX(price) as max_price
        FROM products_with_categories
        GROUP BY category_name;
      `;

      await schemaService.apply(schema);

      // Test with sample data
      await client.query(`INSERT INTO categories (id, name) VALUES (1, 'Electronics'), (2, 'Books')`);
      await client.query(`
        INSERT INTO products (name, category_id, price) VALUES 
        ('Laptop', 1, 999.99),
        ('Phone', 1, 599.99),
        ('Novel', 2, 19.99)
      `);

      await client.query(`REFRESH MATERIALIZED VIEW category_price_stats`);

      const result = await client.query(`
        SELECT category_name, product_count, avg_price::decimal(10,2) as avg_price
        FROM category_price_stats 
        ORDER BY category_name
      `);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[1].category_name).toBe('Electronics');
      expect(result.rows[1].product_count).toBe('2');
    });
  });

  describe("Materialized View Modifications", () => {
    test("should handle materialized view definition changes", async () => {
      // Initial schema
      const initialSchema = `
        CREATE TABLE metrics (
          id SERIAL PRIMARY KEY,
          metric_name VARCHAR(50) NOT NULL,
          value DECIMAL(10,2) NOT NULL,
          recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE MATERIALIZED VIEW metric_summary AS
        SELECT 
          metric_name,
          COUNT(*) as record_count,
          AVG(value) as avg_value
        FROM metrics
        GROUP BY metric_name;
      `;

      await schemaService.apply(initialSchema);

      // Updated schema with additional columns
      const updatedSchema = `
        CREATE TABLE metrics (
          id SERIAL PRIMARY KEY,
          metric_name VARCHAR(50) NOT NULL,
          value DECIMAL(10,2) NOT NULL,
          recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE MATERIALIZED VIEW metric_summary AS
        SELECT 
          metric_name,
          COUNT(*) as record_count,
          AVG(value) as avg_value,
          MIN(value) as min_value,
          MAX(value) as max_value,
          MAX(recorded_at) as last_recorded
        FROM metrics
        GROUP BY metric_name;
      `;

      await schemaService.apply(updatedSchema);

      // Verify the materialized view was updated
      const columnResult = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'metric_summary'
        ORDER BY column_name
      `);
      
      const columnNames = columnResult.rows.map(r => r.column_name);
      expect(columnNames).toContain('min_value');
      expect(columnNames).toContain('max_value');
      expect(columnNames).toContain('last_recorded');
    });

    test("should handle materialized view removal", async () => {
      // Initial schema with materialized view
      const initialSchema = `
        CREATE TABLE logs (
          id SERIAL PRIMARY KEY,
          level VARCHAR(20) NOT NULL,
          message TEXT NOT NULL
        );

        CREATE MATERIALIZED VIEW log_summary AS
        SELECT level, COUNT(*) as count
        FROM logs
        GROUP BY level;
      `;

      await schemaService.apply(initialSchema);

      // Updated schema without materialized view
      const updatedSchema = `
        CREATE TABLE logs (
          id SERIAL PRIMARY KEY,
          level VARCHAR(20) NOT NULL,
          message TEXT NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema);

      // Verify materialized view was removed
      const matViewResult = await client.query(`
        SELECT COUNT(*) as count
        FROM pg_matviews 
        WHERE schemaname = 'public'
      `);
      expect(parseInt(matViewResult.rows[0].count)).toBe(0);
    });
  });
});