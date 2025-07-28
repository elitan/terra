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
    test("should handle graceful view degradation when table columns are removed", async () => {
      // Initial schema with view depending on specific columns
      const initialSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          price DECIMAL(10,2) NOT NULL,
          legacy_field VARCHAR(100), -- This will be removed
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE VIEW product_summary AS
        SELECT 
          id,
          name,
          price,
          legacy_field, -- View depends on this field
          created_at
        FROM products;
      `;

      await schemaService.apply(initialSchema);

      // Insert test data
      await client.query(`
        INSERT INTO products (name, description, price, legacy_field) 
        VALUES ('Test Product', 'A test product', 99.99, 'legacy_value')
      `);

      // Verify initial view works
      const initialResult = await client.query('SELECT * FROM product_summary');
      expect(initialResult.rows).toHaveLength(1);
      expect(initialResult.rows[0].legacy_field).toBe('legacy_value');

      // Updated schema - remove the legacy field
      const updatedSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          price DECIMAL(10,2) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE VIEW product_summary AS
        SELECT 
          id,
          name,
          price,
          created_at,
          'DEPRECATED' as legacy_field -- Provide default value for compatibility
        FROM products;
      `;

      // This should succeed - view is updated to handle missing column
      await schemaService.apply(updatedSchema);

      // Verify view still works but with default value
      const updatedResult = await client.query('SELECT * FROM product_summary');
      expect(updatedResult.rows).toHaveLength(1);
      expect(updatedResult.rows[0].legacy_field).toBe('DEPRECATED');
      expect(updatedResult.rows[0].name).toBe('Test Product');
    });

    test("should handle table column type changes that affect views", async () => {
      const initialSchema = `
        CREATE TABLE metrics (
          id SERIAL PRIMARY KEY,
          metric_name VARCHAR(100) NOT NULL,
          value_text VARCHAR(50), -- Initially text
          recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE VIEW metric_analysis AS
        SELECT 
          metric_name,
          value_text,
          LENGTH(value_text) as text_length,
          UPPER(value_text) as normalized_value
        FROM metrics;
      `;

      await schemaService.apply(initialSchema);

      await client.query(`
        INSERT INTO metrics (metric_name, value_text) 
        VALUES ('test_metric', '12345')
      `);

      // Verify text-based view works
      const textResult = await client.query('SELECT * FROM metric_analysis');
      expect(textResult.rows[0].text_length).toBe(5);
      expect(textResult.rows[0].normalized_value).toBe('12345');

      // Change column to numeric - this requires view update
      const updatedSchema = `
        CREATE TABLE metrics (
          id SERIAL PRIMARY KEY,
          metric_name VARCHAR(100) NOT NULL,
          value_numeric DECIMAL(10,2), -- Changed to numeric
          recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE VIEW metric_analysis AS
        SELECT 
          metric_name,
          value_numeric,
          CASE 
            WHEN value_numeric IS NULL THEN 0
            ELSE CAST(value_numeric AS INTEGER)
          END as rounded_value,
          CASE
            WHEN value_numeric > 100 THEN 'HIGH'
            WHEN value_numeric > 10 THEN 'MEDIUM'  
            ELSE 'LOW'
          END as category
        FROM metrics;
      `;

      await schemaService.apply(updatedSchema);

      // Insert numeric data
      await client.query(`
        INSERT INTO metrics (metric_name, value_numeric) 
        VALUES ('numeric_metric', 150.75)
      `);

      const numericResult = await client.query('SELECT * FROM metric_analysis WHERE metric_name = \'numeric_metric\'');
      expect(numericResult.rows[0].rounded_value).toBe(150);
      expect(numericResult.rows[0].category).toBe('HIGH');
    });

    test("should handle cascading view dependencies during schema changes", async () => {
      const initialSchema = `
        CREATE TABLE base_data (
          id SERIAL PRIMARY KEY,
          category VARCHAR(50),
          amount DECIMAL(10,2),
          status VARCHAR(20) DEFAULT 'active'
        );

        CREATE VIEW level1_aggregation AS
        SELECT 
          category,
          COUNT(*) as record_count,
          SUM(amount) as total_amount,
          AVG(amount) as avg_amount
        FROM base_data
        WHERE status = 'active'
        GROUP BY category;

        CREATE VIEW level2_analysis AS
        SELECT 
          category,
          record_count,
          total_amount,
          avg_amount,
          CASE 
            WHEN avg_amount > 100 THEN 'premium'
            ELSE 'standard'
          END as tier
        FROM level1_aggregation;

        CREATE VIEW level3_summary AS
        SELECT 
          tier,
          COUNT(*) as category_count,
          SUM(total_amount) as tier_total,
          AVG(avg_amount) as tier_avg
        FROM level2_analysis
        GROUP BY tier;
      `;

      await schemaService.apply(initialSchema);

      // Insert test data
      await client.query(`
        INSERT INTO base_data (category, amount, status) VALUES 
        ('electronics', 150.00, 'active'),
        ('electronics', 200.00, 'active'),
        ('books', 25.00, 'active'),
        ('books', 35.00, 'active'),
        ('furniture', 500.00, 'active')
      `);

      // Verify all levels work
      const level3Result = await client.query('SELECT * FROM level3_summary ORDER BY tier');
      expect(level3Result.rows).toHaveLength(2); // premium and standard
      
      const premiumTier = level3Result.rows.find(r => r.tier === 'premium');
      expect(premiumTier).toBeDefined();
      expect(parseInt(premiumTier.category_count)).toBeGreaterThan(0);

      // Now change the base table schema - add a new status that affects filtering
      const updatedSchema = `
        CREATE TABLE base_data (
          id SERIAL PRIMARY KEY,
          category VARCHAR(50),
          amount DECIMAL(10,2),
          status VARCHAR(20) DEFAULT 'pending', -- Changed default
          priority INTEGER DEFAULT 1 -- New field
        );

        CREATE VIEW level1_aggregation AS
        SELECT 
          category,
          COUNT(*) as record_count,
          SUM(amount) as total_amount,
          AVG(amount) as avg_amount,
          AVG(priority) as avg_priority -- Use new field
        FROM base_data
        WHERE status IN ('active', 'pending') -- Updated filter
        GROUP BY category;

        CREATE VIEW level2_analysis AS
        SELECT 
          category,
          record_count,
          total_amount,
          avg_amount,
          avg_priority,
          CASE 
            WHEN avg_amount > 100 AND avg_priority > 2 THEN 'premium_high'
            WHEN avg_amount > 100 THEN 'premium'
            WHEN avg_priority > 2 THEN 'priority'
            ELSE 'standard'
          END as tier
        FROM level1_aggregation;

        CREATE VIEW level3_summary AS
        SELECT 
          tier,
          COUNT(*) as category_count,
          SUM(total_amount) as tier_total,
          AVG(avg_amount) as tier_avg,
          AVG(avg_priority) as tier_avg_priority
        FROM level2_analysis
        GROUP BY tier;
      `;

      await schemaService.apply(updatedSchema);

      // Add data with new schema
      await client.query(`
        INSERT INTO base_data (category, amount, status, priority) VALUES 
        ('electronics', 300.00, 'pending', 3),
        ('premium', 1000.00, 'active', 5)
      `);

      // Verify cascading views still work with new logic
      const updatedLevel3Result = await client.query('SELECT * FROM level3_summary ORDER BY tier');
      expect(updatedLevel3Result.rows.length).toBeGreaterThan(0);

      // Should have new tier types
      const tierNames = updatedLevel3Result.rows.map(r => r.tier);
      expect(tierNames.some(t => ['premium_high', 'priority'].includes(t))).toBe(true);
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
          DATE_TRUNC('day', transaction_date) as day,
          category,
          COUNT(*) as transaction_count,
          SUM(amount) as total_amount,
          AVG(amount) as avg_amount
        FROM transactions
        WHERE status = 'completed'
        GROUP BY DATE_TRUNC('day', transaction_date), category;

        CREATE INDEX idx_daily_summary_day_category ON daily_transaction_summary (day, category);
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
        WHERE day >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY day DESC, total_amount DESC
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
          DATE_TRUNC('day', transaction_date) as day,
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

        CREATE INDEX idx_daily_summary_day_category ON daily_transaction_summary (day, category);
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
        WHERE day >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY day DESC, total_amount DESC
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
    test("should maintain data consistency when view definitions change", async () => {
      const initialSchema = `
        CREATE TABLE financial_records (
          id SERIAL PRIMARY KEY,
          account_id INTEGER NOT NULL,
          transaction_type VARCHAR(20) NOT NULL, -- 'debit' or 'credit'
          amount DECIMAL(15,2) NOT NULL,
          balance_after DECIMAL(15,2), -- Running balance
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE VIEW account_balances AS
        SELECT 
          account_id,
          SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE -amount END) as calculated_balance,
          MAX(balance_after) as last_recorded_balance,
          COUNT(*) as transaction_count
        FROM financial_records
        GROUP BY account_id;
      `;

      await schemaService.apply(initialSchema);

      // Insert financial data
      await client.query(`
        INSERT INTO financial_records (account_id, transaction_type, amount, balance_after) VALUES 
        (1, 'credit', 1000.00, 1000.00),
        (1, 'debit', 250.00, 750.00),
        (1, 'credit', 500.00, 1250.00),
        (2, 'credit', 2000.00, 2000.00),
        (2, 'debit', 300.00, 1700.00)
      `);

      // Verify initial balance calculations
      const initialBalances = await client.query('SELECT * FROM account_balances ORDER BY account_id');
      expect(initialBalances.rows).toHaveLength(2);
      
      const account1 = initialBalances.rows[0];
      expect(parseFloat(account1.calculated_balance)).toBe(1250.00);
      expect(parseFloat(account1.last_recorded_balance)).toBe(1250.00);

      // Update schema with enhanced integrity checks
      const updatedSchema = `
        CREATE TABLE financial_records (
          id SERIAL PRIMARY KEY,
          account_id INTEGER NOT NULL,
          transaction_type VARCHAR(20) NOT NULL,
          amount DECIMAL(15,2) NOT NULL,
          balance_after DECIMAL(15,2),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          reconciled BOOLEAN DEFAULT false, -- New field
          reference_id VARCHAR(100) -- New field for audit trail
        );

        CREATE VIEW account_balances AS
        SELECT 
          account_id,
          SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE -amount END) as calculated_balance,
          MAX(balance_after) as last_recorded_balance,
          COUNT(*) as transaction_count,
          COUNT(CASE WHEN reconciled THEN 1 END) as reconciled_count,
          -- Data integrity check
          CASE 
            WHEN ABS(SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE -amount END) - MAX(balance_after)) < 0.01 
            THEN 'BALANCED'
            ELSE 'DISCREPANCY'
          END as integrity_status,
          MAX(created_at) as last_transaction_date
        FROM financial_records
        GROUP BY account_id;
      `;

      await schemaService.apply(updatedSchema);

      // Add new transactions with integrity fields
      await client.query(`
        INSERT INTO financial_records (account_id, transaction_type, amount, balance_after, reconciled, reference_id) VALUES 
        (1, 'debit', 100.00, 1150.00, true, 'REF001'),
        (3, 'credit', 5000.00, 5000.00, false, 'REF002')
      `);

      // Verify enhanced integrity checking
      const updatedBalances = await client.query('SELECT * FROM account_balances ORDER BY account_id');
      expect(updatedBalances.rows.length).toBeGreaterThanOrEqual(2);

      // Check integrity status
      const account1Updated = updatedBalances.rows.find(r => r.account_id === 1);
      expect(account1Updated.integrity_status).toBe('BALANCED');
      expect(parseInt(account1Updated.reconciled_count)).toBeGreaterThan(0);
      expect(account1Updated.last_transaction_date).toBeDefined();

      // Verify calculations are still correct
      expect(parseFloat(account1Updated.calculated_balance)).toBe(1150.00);
      expect(parseFloat(account1Updated.last_recorded_balance)).toBe(1150.00);
    });
  });
});