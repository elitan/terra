import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { createTestClient, cleanDatabase, TEST_DB_CONFIG } from "../utils";

describe("Realistic Business Scenarios for Views", () => {
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

  describe("E-commerce Analytics", () => {
    test("should handle comprehensive sales analytics with realistic data", async () => {
      const schema = `
        CREATE TABLE customers (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          first_name VARCHAR(100) NOT NULL,
          last_name VARCHAR(100) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          country VARCHAR(50),
          is_premium BOOLEAN DEFAULT false
        );

        CREATE TABLE categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          parent_id INTEGER REFERENCES categories(id),
          margin_percentage DECIMAL(5,2) DEFAULT 20.00
        );

        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL UNIQUE,
          name VARCHAR(255) NOT NULL,
          category_id INTEGER REFERENCES categories(id),
          cost_price DECIMAL(10,2) NOT NULL,
          list_price DECIMAL(10,2) NOT NULL,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER REFERENCES customers(id),
          order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          total_amount DECIMAL(10,2) NOT NULL,
          discount_amount DECIMAL(10,2) DEFAULT 0,
          tax_amount DECIMAL(10,2) DEFAULT 0,
          status VARCHAR(20) DEFAULT 'pending',
          shipping_country VARCHAR(50)
        );

        CREATE TABLE order_items (
          id SERIAL PRIMARY KEY,
          order_id INTEGER REFERENCES orders(id),
          product_id INTEGER REFERENCES products(id),
          quantity INTEGER NOT NULL,
          unit_price DECIMAL(10,2) NOT NULL,
          discount_amount DECIMAL(10,2) DEFAULT 0
        );

        -- Comprehensive sales analytics view
        CREATE VIEW sales_analytics AS
        SELECT 
          DATE_TRUNC('month', o.order_date) as month,
          c.country,
          cat.name as category,
          COUNT(DISTINCT o.id) as order_count,
          COUNT(DISTINCT o.customer_id) as unique_customers,
          SUM(o.total_amount) as gross_revenue,
          SUM(o.total_amount - o.discount_amount - o.tax_amount) as net_revenue,
          SUM(oi.quantity * p.cost_price) as total_cost,
          SUM(o.total_amount - o.discount_amount - o.tax_amount) - SUM(oi.quantity * p.cost_price) as profit,
          AVG(o.total_amount) as avg_order_value,
          SUM(CASE WHEN c.is_premium THEN o.total_amount ELSE 0 END) as premium_revenue,
          COUNT(CASE WHEN o.status = 'completed' THEN 1 END) * 100.0 / COUNT(*) as completion_rate
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        JOIN categories cat ON p.category_id = cat.id
        WHERE o.order_date >= CURRENT_DATE - INTERVAL '24 months'
        GROUP BY DATE_TRUNC('month', o.order_date), c.country, cat.name
        HAVING SUM(o.total_amount) > 0;

        -- Customer lifecycle view
        CREATE VIEW customer_lifecycle AS
        SELECT 
          c.id,
          c.email,
          c.country,
          c.created_at as registration_date,
          MIN(o.order_date) as first_order_date,
          MAX(o.order_date) as last_order_date,
          COUNT(o.id) as total_orders,
          SUM(o.total_amount) as lifetime_value,
          AVG(o.total_amount) as avg_order_value,
          DATE_PART('day', MAX(o.order_date) - MIN(o.order_date)) as days_active,
          CASE 
            WHEN MAX(o.order_date) >= CURRENT_DATE - INTERVAL '30 days' THEN 'active'
            WHEN MAX(o.order_date) >= CURRENT_DATE - INTERVAL '90 days' THEN 'at_risk'
            ELSE 'churned'
          END as status,
          COUNT(o.id) * 1.0 / NULLIF(DATE_PART('day', MAX(o.order_date) - MIN(o.order_date)), 0) * 30 as monthly_order_frequency
        FROM customers c
        LEFT JOIN orders o ON c.id = o.customer_id AND o.status = 'completed'
        GROUP BY c.id, c.email, c.country, c.created_at;
      `;

      await schemaService.apply(schema);

      // Insert realistic test data
      await client.query(`
        INSERT INTO customers (email, first_name, last_name, country, is_premium) VALUES 
        ('john@example.com', 'John', 'Doe', 'US', true),
        ('jane@example.com', 'Jane', 'Smith', 'CA', false),
        ('bob@example.com', 'Bob', 'Johnson', 'UK', false),
        ('alice@example.com', 'Alice', 'Brown', 'US', true)
      `);

      await client.query(`
        INSERT INTO categories (name, margin_percentage) VALUES 
        ('Electronics', 25.00),
        ('Books', 40.00),
        ('Clothing', 60.00)
      `);

      await client.query(`
        INSERT INTO products (sku, name, category_id, cost_price, list_price) VALUES 
        ('LAPTOP001', 'Gaming Laptop', 1, 800.00, 1200.00),
        ('BOOK001', 'Programming Guide', 2, 15.00, 35.00),
        ('SHIRT001', 'Cotton T-Shirt', 3, 8.00, 25.00),
        ('PHONE001', 'Smartphone', 1, 300.00, 599.00)
      `);

      // Create orders with realistic patterns
      await client.query(`
        INSERT INTO orders (customer_id, total_amount, discount_amount, tax_amount, status, shipping_country) VALUES 
        (1, 1200.00, 100.00, 88.00, 'completed', 'US'),
        (1, 35.00, 0.00, 2.80, 'completed', 'US'),
        (2, 599.00, 59.90, 43.13, 'completed', 'CA'),
        (3, 25.00, 0.00, 2.00, 'completed', 'UK'),
        (4, 1234.00, 50.00, 94.72, 'pending', 'US')
      `);

      await client.query(`
        INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES 
        (1, 1, 1, 1200.00),  -- Gaming laptop
        (2, 2, 1, 35.00),    -- Programming book
        (3, 4, 1, 599.00),   -- Smartphone  
        (4, 3, 1, 25.00),    -- T-shirt
        (5, 1, 1, 1200.00)   -- Another laptop (pending order)
      `);

      // Test sales analytics view
      const analyticsResult = await client.query(`
        SELECT * FROM sales_analytics 
        WHERE month = DATE_TRUNC('month', CURRENT_DATE)
        ORDER BY gross_revenue DESC
      `);

      expect(analyticsResult.rows.length).toBeGreaterThan(0);
      
      // Verify business logic
      const topResult = analyticsResult.rows[0];
      expect(parseFloat(topResult.profit)).toBeGreaterThan(0); // Should be profitable
      expect(parseFloat(topResult.completion_rate)).toBeLessThanOrEqual(100);
      expect(parseInt(topResult.unique_customers)).toBeGreaterThan(0);

      // Test customer lifecycle view
      const lifecycleResult = await client.query(`
        SELECT * FROM customer_lifecycle 
        WHERE total_orders > 0
        ORDER BY lifetime_value DESC
      `);

      expect(lifecycleResult.rows.length).toBeGreaterThan(0);
      
      const topCustomer = lifecycleResult.rows[0];
      expect(parseFloat(topCustomer.lifetime_value)).toBeGreaterThan(0);
      expect(['active', 'at_risk', 'churned']).toContain(topCustomer.status);
      expect(parseInt(topCustomer.total_orders)).toBeGreaterThan(0);
    });

    test("should handle inventory management with low stock alerts", async () => {
      const schema = `
        CREATE TABLE warehouses (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          location VARCHAR(100) NOT NULL
        );

        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL UNIQUE,
          name VARCHAR(255) NOT NULL,
          min_stock_level INTEGER DEFAULT 10,
          max_stock_level INTEGER DEFAULT 100,
          reorder_point INTEGER DEFAULT 20
        );

        CREATE TABLE inventory (
          id SERIAL PRIMARY KEY,
          warehouse_id INTEGER REFERENCES warehouses(id),
          product_id INTEGER REFERENCES products(id),
          quantity INTEGER NOT NULL DEFAULT 0,
          reserved_quantity INTEGER DEFAULT 0,
          last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(warehouse_id, product_id)
        );

        CREATE TABLE inventory_movements (
          id SERIAL PRIMARY KEY,
          warehouse_id INTEGER REFERENCES warehouses(id),
          product_id INTEGER REFERENCES products(id),
          movement_type VARCHAR(20) NOT NULL, -- 'in', 'out', 'adjustment'
          quantity INTEGER NOT NULL,
          reference_id INTEGER, -- order_id, purchase_id, etc.
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Critical inventory alerts view
        CREATE VIEW inventory_alerts AS
        SELECT 
          w.name as warehouse_name,
          p.sku,
          p.name as product_name,
          i.quantity as current_stock,
          i.reserved_quantity,
          i.quantity - i.reserved_quantity as available_stock,
          p.min_stock_level,
          p.reorder_point,
          CASE 
            WHEN i.quantity - i.reserved_quantity <= 0 THEN 'OUT_OF_STOCK'
            WHEN i.quantity - i.reserved_quantity <= p.min_stock_level THEN 'CRITICAL_LOW'
            WHEN i.quantity - i.reserved_quantity <= p.reorder_point THEN 'REORDER_NEEDED'
            WHEN i.quantity >= p.max_stock_level THEN 'OVERSTOCK'
            ELSE 'NORMAL'
          END as alert_level,
          COALESCE(recent_sales.avg_daily_sales, 0) as avg_daily_sales,
          CASE 
            WHEN COALESCE(recent_sales.avg_daily_sales, 0) > 0 
            THEN (i.quantity - i.reserved_quantity) / recent_sales.avg_daily_sales
            ELSE NULL
          END as days_of_stock_remaining
        FROM inventory i
        JOIN warehouses w ON i.warehouse_id = w.id
        JOIN products p ON i.product_id = p.id
        LEFT JOIN (
          SELECT 
            warehouse_id,
            product_id,
            AVG(ABS(quantity)) as avg_daily_sales
          FROM inventory_movements 
          WHERE movement_type = 'out' 
            AND created_at >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY warehouse_id, product_id
        ) recent_sales ON i.warehouse_id = recent_sales.warehouse_id 
                     AND i.product_id = recent_sales.product_id
        WHERE i.quantity - i.reserved_quantity <= p.reorder_point
           OR i.quantity >= p.max_stock_level;
      `;

      await schemaService.apply(schema);

      // Insert test data
      await client.query(`
        INSERT INTO warehouses (name, location) VALUES 
        ('Main Warehouse', 'New York'),
        ('West Coast Hub', 'Los Angeles')
      `);

      await client.query(`
        INSERT INTO products (sku, name, min_stock_level, max_stock_level, reorder_point) VALUES 
        ('WIDGET001', 'Super Widget', 5, 100, 15),
        ('GADGET001', 'Amazing Gadget', 10, 200, 25)
      `);

      await client.query(`
        INSERT INTO inventory (warehouse_id, product_id, quantity, reserved_quantity) VALUES 
        (1, 1, 3, 1),   -- Critical low: available = 2, min = 5
        (1, 2, 150, 0), -- Overstock: 150 > 100 max
        (2, 1, 12, 2)   -- Reorder needed: available = 10, reorder_point = 15
      `);

      // Add some sales history
      await client.query(`
        INSERT INTO inventory_movements (warehouse_id, product_id, movement_type, quantity, created_at) VALUES 
        (1, 1, 'out', -2, CURRENT_DATE - INTERVAL '1 day'),
        (1, 1, 'out', -3, CURRENT_DATE - INTERVAL '2 days'),
        (1, 1, 'out', -1, CURRENT_DATE - INTERVAL '3 days')
      `);

      const alertsResult = await client.query(`
        SELECT * FROM inventory_alerts 
        ORDER BY 
          CASE alert_level 
            WHEN 'OUT_OF_STOCK' THEN 1
            WHEN 'CRITICAL_LOW' THEN 2  
            WHEN 'REORDER_NEEDED' THEN 3
            WHEN 'OVERSTOCK' THEN 4
          END,
          days_of_stock_remaining ASC NULLS LAST
      `);

      expect(alertsResult.rows.length).toBeGreaterThan(0);

      // Verify alert logic
      const criticalAlert = alertsResult.rows.find(r => r.alert_level === 'CRITICAL_LOW');
      expect(criticalAlert).toBeDefined();
      expect(parseInt(criticalAlert.available_stock)).toBeLessThanOrEqual(parseInt(criticalAlert.min_stock_level));

      const overstockAlert = alertsResult.rows.find(r => r.alert_level === 'OVERSTOCK');
      expect(overstockAlert).toBeDefined();
      expect(parseInt(overstockAlert.current_stock)).toBeGreaterThanOrEqual(parseInt(overstockAlert.max_stock_level));
    });
  });

  describe("User Analytics & Engagement", () => {
    test("should track user engagement with cohort analysis", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          signed_up_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          first_login_at TIMESTAMP,
          last_login_at TIMESTAMP,
          total_logins INTEGER DEFAULT 0,
          subscription_tier VARCHAR(20) DEFAULT 'free'
        );

        CREATE TABLE user_events (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          event_type VARCHAR(50) NOT NULL,
          event_data JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Cohort analysis view for user retention
        CREATE VIEW user_cohorts AS
        WITH user_cohorts AS (
          SELECT 
            user_id,
            DATE_TRUNC('month', signed_up_at) as cohort_month,
            signed_up_at
          FROM users
        ),
        user_activities AS (
          SELECT 
            uc.user_id,
            uc.cohort_month,
            DATE_TRUNC('month', ue.created_at) as activity_month,
            FLOOR(DATE_PART('day', ue.created_at - uc.signed_up_at) / 30) as months_since_signup
          FROM user_cohorts uc
          LEFT JOIN user_events ue ON uc.user_id = ue.user_id
          WHERE ue.event_type IN ('login', 'page_view', 'feature_use')
        )
        SELECT 
          cohort_month,
          COUNT(DISTINCT user_id) as cohort_size,
          months_since_signup,
          COUNT(DISTINCT CASE WHEN activity_month IS NOT NULL THEN user_id END) as active_users,
          COUNT(DISTINCT CASE WHEN activity_month IS NOT NULL THEN user_id END) * 100.0 / 
            COUNT(DISTINCT user_id) as retention_rate
        FROM user_activities
        GROUP BY cohort_month, months_since_signup
        HAVING COUNT(DISTINCT user_id) > 0
        ORDER BY cohort_month, months_since_signup;

        -- Daily/Weekly/Monthly Active Users
        CREATE MATERIALIZED VIEW engagement_metrics AS
        SELECT 
          DATE_TRUNC('day', created_at) as date,
          COUNT(DISTINCT user_id) as daily_active_users,
          COUNT(DISTINCT CASE 
            WHEN created_at >= DATE_TRUNC('day', created_at) - INTERVAL '6 days' 
            THEN user_id 
          END) as weekly_active_users,
          COUNT(DISTINCT CASE 
            WHEN created_at >= DATE_TRUNC('day', created_at) - INTERVAL '29 days' 
            THEN user_id 
          END) as monthly_active_users,
          COUNT(*) as total_events
        FROM user_events
        WHERE event_type IN ('login', 'page_view', 'feature_use')
          AND created_at >= CURRENT_DATE - INTERVAL '90 days'
        GROUP BY DATE_TRUNC('day', created_at);
      `;

      await schemaService.apply(schema);

      // Insert realistic user data
      const signupDates = [
        'CURRENT_DATE - INTERVAL \'60 days\'',
        'CURRENT_DATE - INTERVAL \'45 days\'', 
        'CURRENT_DATE - INTERVAL \'30 days\'',
        'CURRENT_DATE - INTERVAL \'15 days\'',
        'CURRENT_DATE - INTERVAL \'7 days\''
      ];

      for (let i = 0; i < signupDates.length; i++) {
        await client.query(`
          INSERT INTO users (email, signed_up_at, subscription_tier) VALUES 
          ('user${i + 1}@example.com', ${signupDates[i]}, ${i % 2 === 0 ? "'premium'" : "'free'"})
        `);
      }

      // Generate realistic event data
      for (let userId = 1; userId <= 5; userId++) {
        for (let day = -30; day <= 0; day++) {
          // Some users are more active than others
          const eventsPerDay = userId <= 2 ? Math.floor(Math.random() * 10) + 1 : Math.floor(Math.random() * 3);
          
          for (let event = 0; event < eventsPerDay; event++) {
            await client.query(`
              INSERT INTO user_events (user_id, event_type, created_at) VALUES 
              ($1, $2, CURRENT_DATE + INTERVAL '${day} days' + INTERVAL '${Math.floor(Math.random() * 24)} hours')
            `, [userId, ['login', 'page_view', 'feature_use'][Math.floor(Math.random() * 3)]]);
          }
        }
      }

      // Refresh materialized view
      await client.query('REFRESH MATERIALIZED VIEW engagement_metrics');

      // Test cohort analysis
      const cohortResult = await client.query(`
        SELECT * FROM user_cohorts 
        WHERE months_since_signup <= 3
        ORDER BY cohort_month, months_since_signup
      `);

      expect(cohortResult.rows.length).toBeGreaterThan(0);

      // Verify retention rates make sense
      const firstCohort = cohortResult.rows.filter(r => r.months_since_signup === '0')[0];
      if (firstCohort) {
        expect(parseFloat(firstCohort.retention_rate)).toBeLessThanOrEqual(100);
        expect(parseInt(firstCohort.cohort_size)).toBeGreaterThan(0);
      }

      // Test engagement metrics
      const engagementResult = await client.query(`
        SELECT * FROM engagement_metrics 
        WHERE date >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY date DESC
      `);

      expect(engagementResult.rows.length).toBeGreaterThan(0);

      const recentDay = engagementResult.rows[0];
      expect(parseInt(recentDay.daily_active_users)).toBeGreaterThan(0);
      expect(parseInt(recentDay.weekly_active_users)).toBeGreaterThanOrEqual(parseInt(recentDay.daily_active_users));
      expect(parseInt(recentDay.monthly_active_users)).toBeGreaterThanOrEqual(parseInt(recentDay.weekly_active_users));
    });
  });
});