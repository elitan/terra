import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { createTestClient, cleanDatabase, TEST_DB_CONFIG } from "../utils";

describe("Schema Evolution & Migration Scenarios", () => {
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

  describe("Breaking Changes Impact", () => {
    test("should handle view updates when adding new table columns", async () => {
      // Initial schema
      const initialSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          price DECIMAL(10,2) NOT NULL
        );

        CREATE VIEW product_summary AS
        SELECT 
          id,
          name,
          price
        FROM products;
      `;

      await schemaService.apply(initialSchema);

      // Insert test data
      await client.query(`
        INSERT INTO products (name, price) 
        VALUES ('Test Product', 99.99)
      `);

      // Verify initial view works
      const initialResult = await client.query('SELECT * FROM product_summary');
      expect(initialResult.rows).toHaveLength(1);
      expect(initialResult.rows[0].name).toBe('Test Product');

      // Updated schema - add new field and update view to use it
      const updatedSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          description TEXT DEFAULT 'No description', -- New field
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- Another new field
        );

        CREATE VIEW product_summary AS
        SELECT 
          id,
          name,
          price,
          description, -- Now include new fields
          created_at
        FROM products;
      `;

      await schemaService.apply(updatedSchema);

      // Verify view works with new columns (existing data gets defaults)
      const updatedResult = await client.query('SELECT * FROM product_summary');
      expect(updatedResult.rows).toHaveLength(1);
      expect(updatedResult.rows[0].name).toBe('Test Product');
      expect(updatedResult.rows[0].description).toBe('No description');
      expect(updatedResult.rows[0].created_at).toBeDefined();
    });

    test("should handle view logic updates without changing table structure", async () => {
      const initialSchema = `
        CREATE TABLE sales (
          id SERIAL PRIMARY KEY,
          amount DECIMAL(10,2) NOT NULL,
          region VARCHAR(50) NOT NULL,
          sale_date DATE DEFAULT CURRENT_DATE
        );

        CREATE VIEW sales_analysis AS
        SELECT 
          region,
          COUNT(*) as sale_count,
          SUM(amount) as total_sales,
          AVG(amount) as avg_sale
        FROM sales
        GROUP BY region;
      `;

      await schemaService.apply(initialSchema);

      await client.query(`
        INSERT INTO sales (amount, region) VALUES 
        (100.00, 'North'),
        (200.00, 'North'),
        (150.00, 'South')
      `);

      // Verify initial view works
      const initialResult = await client.query('SELECT * FROM sales_analysis ORDER BY region');
      expect(initialResult.rows).toHaveLength(2);
      expect(parseFloat(initialResult.rows[0].total_sales)).toBe(300.00); // North

      // Updated schema - change view logic but keep table same
      const updatedSchema = `
        CREATE TABLE sales (
          id SERIAL PRIMARY KEY,
          amount DECIMAL(10,2) NOT NULL,
          region VARCHAR(50) NOT NULL,
          sale_date DATE DEFAULT CURRENT_DATE
        );

        CREATE VIEW sales_analysis AS
        SELECT 
          region,
          COUNT(*) as sale_count,
          SUM(amount) as total_sales,
          AVG(amount) as avg_sale,
          CASE 
            WHEN AVG(amount) > 125 THEN 'HIGH_VALUE'
            ELSE 'STANDARD'
          END as performance_tier
        FROM sales
        GROUP BY region;
      `;

      await schemaService.apply(updatedSchema);

      // Verify updated view includes new calculated field
      const updatedResult = await client.query('SELECT * FROM sales_analysis ORDER BY region');
      expect(updatedResult.rows).toHaveLength(2);
      expect(updatedResult.rows[0].performance_tier).toBeDefined();
      expect(updatedResult.rows[0].performance_tier).toBe('HIGH_VALUE'); // North region avg = 150
    });

    test("should handle adding new views to existing schema", async () => {
      const initialSchema = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          status VARCHAR(20) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE VIEW pending_orders AS
        SELECT id, customer_id, amount, created_at
        FROM orders
        WHERE status = 'pending';
      `;

      await schemaService.apply(initialSchema);

      // Insert test data
      await client.query(`
        INSERT INTO orders (customer_id, amount, status) VALUES 
        (1, 150.00, 'pending'),
        (2, 200.00, 'completed'),
        (1, 75.00, 'pending')
      `);

      // Verify initial view works
      const initialResult = await client.query('SELECT * FROM pending_orders');
      expect(initialResult.rows).toHaveLength(2);

      // Updated schema - add more views without changing existing ones
      const updatedSchema = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          status VARCHAR(20) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE VIEW pending_orders AS
        SELECT id, customer_id, amount, created_at
        FROM orders
        WHERE status = 'pending';

        CREATE VIEW completed_orders AS
        SELECT id, customer_id, amount, created_at
        FROM orders
        WHERE status = 'completed';

        CREATE VIEW customer_order_summary AS
        SELECT 
          customer_id,
          COUNT(*) as total_orders,
          SUM(amount) as total_amount,
          AVG(amount) as avg_amount
        FROM orders
        GROUP BY customer_id;
      `;

      await schemaService.apply(updatedSchema);

      // Verify all views work
      const pendingResult = await client.query('SELECT * FROM pending_orders');
      expect(pendingResult.rows).toHaveLength(2);

      const completedResult = await client.query('SELECT * FROM completed_orders');
      expect(completedResult.rows).toHaveLength(1);

      const summaryResult = await client.query('SELECT * FROM customer_order_summary ORDER BY customer_id');
      expect(summaryResult.rows).toHaveLength(2);
      expect(parseInt(summaryResult.rows[0].total_orders)).toBeGreaterThan(0);
    });
  });

  describe("Performance Impact During Migrations", () => {
    test("should maintain materialized view performance during table restructuring", async () => {
      const initialSchema = `
        CREATE TABLE transactions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          category VARCHAR(50),
          status VARCHAR(20) DEFAULT 'completed'
        );

        CREATE MATERIALIZED VIEW daily_transaction_summary AS
        SELECT 
          DATE_TRUNC('day', transaction_date) as transaction_day,
          category,
          COUNT(*) as transaction_count,
          SUM(amount) as total_amount,
          AVG(amount) as avg_amount
        FROM transactions
        WHERE status = 'completed'
        GROUP BY DATE_TRUNC('day', transaction_date), category;

        CREATE INDEX idx_daily_summary_day_category ON daily_transaction_summary (transaction_day, category);
      `;

      await schemaService.apply(initialSchema);

      // Insert performance test data
      const categories = ['food', 'transport', 'entertainment', 'utilities', 'shopping'];
      for (let i = 0; i < 1000; i++) {
        await client.query(`
          INSERT INTO transactions (user_id, amount, category, transaction_date) VALUES 
          ($1, $2, $3, CURRENT_DATE - INTERVAL '${Math.floor(Math.random() * 30)} days')
        `, [
          Math.floor(Math.random() * 100) + 1,
          (Math.random() * 500 + 10).toFixed(2),
          categories[Math.floor(Math.random() * categories.length)]
        ]);
      }

      await client.query('REFRESH MATERIALIZED VIEW daily_transaction_summary');

      // Measure initial query performance
      const startTime = Date.now();
      const initialResult = await client.query(`
        SELECT * FROM daily_transaction_summary 
        WHERE transaction_day >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY transaction_day DESC, total_amount DESC
      `);
      const initialQueryTime = Date.now() - startTime;

      expect(initialResult.rows.length).toBeGreaterThan(0);
      expect(initialQueryTime).toBeLessThan(1000); // Should be fast with index

      // Restructure table - add partitioning concept
      const updatedSchema = `
        CREATE TABLE transactions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          category VARCHAR(50),
          subcategory VARCHAR(50), -- New field
          status VARCHAR(20) DEFAULT 'completed',
          merchant_id INTEGER -- New field for more complex analysis
        );

        CREATE MATERIALIZED VIEW daily_transaction_summary AS
        SELECT 
          DATE_TRUNC('day', transaction_date) as transaction_day,
          category,
          subcategory,
          COUNT(*) as transaction_count,
          COUNT(DISTINCT user_id) as unique_users,
          COUNT(DISTINCT merchant_id) as unique_merchants,
          SUM(amount) as total_amount,
          AVG(amount) as avg_amount,
          MIN(amount) as min_amount,
          MAX(amount) as max_amount
        FROM transactions
        WHERE status = 'completed'
        GROUP BY DATE_TRUNC('day', transaction_date), category, subcategory;

        CREATE INDEX idx_daily_summary_day_category ON daily_transaction_summary (transaction_day, category);
        CREATE INDEX idx_daily_summary_amount ON daily_transaction_summary (total_amount);
      `;

      await schemaService.apply(updatedSchema);

      // Add data with new structure
      for (let i = 0; i < 500; i++) {
        await client.query(`
          INSERT INTO transactions (user_id, amount, category, subcategory, merchant_id, transaction_date) VALUES 
          ($1, $2, $3, $4, $5, CURRENT_DATE - INTERVAL '${Math.floor(Math.random() * 30)} days')
        `, [
          Math.floor(Math.random() * 100) + 1,
          (Math.random() * 500 + 10).toFixed(2),
          categories[Math.floor(Math.random() * categories.length)],
          'sub_' + categories[Math.floor(Math.random() * categories.length)],
          Math.floor(Math.random() * 50) + 1
        ]);
      }

      await client.query('REFRESH MATERIALIZED VIEW daily_transaction_summary');

      // Measure updated query performance
      const updatedStartTime = Date.now();
      const updatedResult = await client.query(`
        SELECT * FROM daily_transaction_summary 
        WHERE transaction_day >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY transaction_day DESC, total_amount DESC
      `);
      const updatedQueryTime = Date.now() - updatedStartTime;

      expect(updatedResult.rows.length).toBeGreaterThan(0);
      expect(updatedQueryTime).toBeLessThan(2000); // Should still be reasonably fast

      // Verify new fields are populated
      const sampleRow = updatedResult.rows[0];
      expect(sampleRow.subcategory).toBeDefined();
      expect(parseInt(sampleRow.unique_users)).toBeGreaterThan(0);
      expect(parseInt(sampleRow.unique_merchants)).toBeGreaterThan(0);
    });
  });

  describe("Data Integrity During Schema Changes", () => {
    test("should maintain data consistency with view enhancements", async () => {
      const initialSchema = `
        CREATE TABLE transactions (
          id SERIAL PRIMARY KEY,
          account_id INTEGER NOT NULL,
          transaction_type VARCHAR(20) NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE VIEW account_summary AS
        SELECT 
          account_id,
          COUNT(*) as transaction_count,
          SUM(amount) as total_amount,
          AVG(amount) as avg_amount
        FROM transactions
        GROUP BY account_id;
      `;

      await schemaService.apply(initialSchema);

      // Insert test data
      await client.query(`
        INSERT INTO transactions (account_id, transaction_type, amount) VALUES 
        (1, 'credit', 1000.00),
        (1, 'debit', 250.00),
        (2, 'credit', 500.00)
      `);

      // Verify initial calculations
      const initialResult = await client.query('SELECT * FROM account_summary ORDER BY account_id');
      expect(initialResult.rows).toHaveLength(2);
      expect(parseFloat(initialResult.rows[0].total_amount)).toBe(1250.00);

      // Enhanced schema with additional analytics
      const updatedSchema = `
        CREATE TABLE transactions (
          id SERIAL PRIMARY KEY,
          account_id INTEGER NOT NULL,
          transaction_type VARCHAR(20) NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          status VARCHAR(20) DEFAULT 'completed' -- New field
        );

        CREATE VIEW account_summary AS
        SELECT 
          account_id,
          COUNT(*) as transaction_count,
          SUM(amount) as total_amount,
          AVG(amount) as avg_amount,
          COUNT(CASE WHEN transaction_type = 'credit' THEN 1 END) as credit_count,
          COUNT(CASE WHEN transaction_type = 'debit' THEN 1 END) as debit_count,
          MAX(created_at) as last_transaction_date,
          CASE 
            WHEN AVG(amount) > 500 THEN 'HIGH_VALUE'
            ELSE 'STANDARD'
          END as account_tier
        FROM transactions
        WHERE status = 'completed'
        GROUP BY account_id;
      `;

      await schemaService.apply(updatedSchema);

      // Add new transaction with status
      await client.query(`
        INSERT INTO transactions (account_id, transaction_type, amount, status) VALUES 
        (1, 'credit', 300.00, 'completed')
      `);

      // Verify enhanced view works correctly
      const updatedResult = await client.query('SELECT * FROM account_summary ORDER BY account_id');
      expect(updatedResult.rows.length).toBeGreaterThan(0);
      
      const account1 = updatedResult.rows.find(r => r.account_id === 1);
      expect(account1).toBeDefined();
      expect(parseInt(account1.credit_count)).toBeGreaterThan(0);
      expect(parseInt(account1.debit_count)).toBeGreaterThan(0);
      expect(account1.account_tier).toBeDefined();
      expect(account1.last_transaction_date).toBeDefined();
    });
  });
});