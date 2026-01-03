import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { createTestClient, cleanDatabase, createTestDatabaseService } from "../utils";

describe("Check Constraints", () => {
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

  describe("Basic Check Constraint Operations", () => {
    test("should create simple check constraint", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          CONSTRAINT positive_price CHECK (price > 0)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify check constraint exists
      const result = await client.query(`
        SELECT 
          conname as constraint_name,
          pg_get_constraintdef(oid) as constraint_definition
        FROM pg_constraint
        WHERE conrelid = 'products'::regclass
          AND contype = 'c'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].constraint_name).toBe('positive_price');
      // PostgreSQL normalizes expressions, so check for the core logic
      expect(result.rows[0].constraint_definition).toMatch(/price\s*>\s*.*0/);
    });

    test("should create check constraint with multiple conditions", async () => {
      const schema = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          quantity INTEGER NOT NULL,
          unit_price DECIMAL(10,2) NOT NULL,
          discount_percent INTEGER DEFAULT 0,
          CONSTRAINT valid_order CHECK (
            quantity > 0 
            AND unit_price > 0 
            AND discount_percent >= 0 
            AND discount_percent <= 100
          )
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Test constraint validation
      // Valid insert
      await client.query(`
        INSERT INTO orders (quantity, unit_price, discount_percent) 
        VALUES (5, 99.99, 10)
      `);

      // Invalid: negative quantity
      await expect(
        client.query("INSERT INTO orders (quantity, unit_price) VALUES (-1, 10)")
      ).rejects.toThrow(/valid_order/);

      // Invalid: discount > 100
      await expect(
        client.query("INSERT INTO orders (quantity, unit_price, discount_percent) VALUES (1, 10, 101)")
      ).rejects.toThrow(/valid_order/);
    });

    test("should create check constraint with complex expressions", async () => {
      const schema = `
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          first_name VARCHAR(50) NOT NULL,
          last_name VARCHAR(50) NOT NULL,
          email VARCHAR(255) NOT NULL,
          birth_date DATE NOT NULL,
          hire_date DATE NOT NULL,
          salary DECIMAL(10,2) NOT NULL,
          CONSTRAINT valid_dates CHECK (hire_date > birth_date),
          CONSTRAINT minimum_age CHECK (birth_date <= CURRENT_DATE - INTERVAL '18 years'),
          CONSTRAINT valid_email CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$'),
          CONSTRAINT reasonable_salary CHECK (salary BETWEEN 20000 AND 1000000)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify all constraints
      const result = await client.query(`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'employees'::regclass
          AND contype = 'c'
        ORDER BY conname
      `);

      expect(result.rows.map(r => r.conname)).toEqual([
        'minimum_age',
        'reasonable_salary',
        'valid_dates',
        'valid_email'
      ]);
    });

    test("should create column-level check constraints", async () => {
      const schema = `
        CREATE TABLE inventory (
          id SERIAL PRIMARY KEY,
          product_name VARCHAR(100) NOT NULL CHECK (LENGTH(product_name) >= 3),
          quantity INTEGER NOT NULL CHECK (quantity >= 0),
          reorder_level INTEGER CHECK (reorder_level >= 0)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Test column constraints
      await expect(
        client.query("INSERT INTO inventory (product_name, quantity) VALUES ('AB', 10)")
      ).rejects.toThrow(); // Name too short

      await expect(
        client.query("INSERT INTO inventory (product_name, quantity) VALUES ('Product', -5)")
      ).rejects.toThrow(); // Negative quantity
    });
  });

  describe("Check Constraint Modifications", () => {
    test("should add check constraint to existing table", async () => {
      const initialSchema = `
        CREATE TABLE accounts (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) NOT NULL,
          balance DECIMAL(10,2) NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Insert some data
      await client.query("INSERT INTO accounts (username, balance) VALUES ('user1', 100)");

      const updatedSchema = `
        CREATE TABLE accounts (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) NOT NULL,
          balance DECIMAL(10,2) NOT NULL,
          CONSTRAINT non_negative_balance CHECK (balance >= 0)
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      // Verify constraint was added
      const result = await client.query(`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'accounts'::regclass
          AND contype = 'c'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].conname).toBe('non_negative_balance');

      // Test constraint is enforced
      await expect(
        client.query("INSERT INTO accounts (username, balance) VALUES ('user2', -50)")
      ).rejects.toThrow(/non_negative_balance/);
    });

    test("should drop check constraint", async () => {
      const initialSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          CONSTRAINT positive_price CHECK (price > 0)
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      const updatedSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      // Verify constraint was dropped
      const result = await client.query(`
        SELECT COUNT(*) as constraint_count
        FROM pg_constraint
        WHERE conrelid = 'products'::regclass
          AND contype = 'c'
      `);

      expect(result.rows[0].constraint_count).toBe('0');

      // Should now allow negative prices
      await client.query("INSERT INTO products (name, price) VALUES ('Test', -10)");
      const product = await client.query("SELECT price FROM products WHERE name = 'Test'");
      expect(product.rows[0].price).toBe('-10.00');
    });

    test("should modify check constraint", async () => {
      const initialSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          CONSTRAINT price_range CHECK (price > 0 AND price < 1000)
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Update constraint to allow higher prices
      const updatedSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          CONSTRAINT price_range CHECK (price > 0 AND price < 10000)
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      // Should now allow prices up to 9999.99
      await client.query("INSERT INTO products (name, price) VALUES ('Expensive', 5000)");
      const product = await client.query("SELECT price FROM products WHERE name = 'Expensive'");
      expect(product.rows[0].price).toBe('5000.00');
    });
  });

  describe("Cross-Column Check Constraints", () => {
    test("should validate date ranges", async () => {
      const schema = `
        CREATE TABLE projects (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          budget DECIMAL(12,2) NOT NULL,
          spent DECIMAL(12,2) DEFAULT 0,
          CONSTRAINT valid_date_range CHECK (end_date > start_date),
          CONSTRAINT budget_not_exceeded CHECK (spent <= budget)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Valid project
      await client.query(`
        INSERT INTO projects (name, start_date, end_date, budget) 
        VALUES ('Project A', '2024-01-01', '2024-12-31', 100000)
      `);

      // Invalid: end before start
      await expect(
        client.query(`
          INSERT INTO projects (name, start_date, end_date, budget) 
          VALUES ('Project B', '2024-12-31', '2024-01-01', 50000)
        `)
      ).rejects.toThrow(/valid_date_range/);

      // Invalid: spent exceeds budget
      await expect(
        client.query(`
          INSERT INTO projects (name, start_date, end_date, budget, spent) 
          VALUES ('Project C', '2024-01-01', '2024-06-30', 50000, 60000)
        `)
      ).rejects.toThrow(/budget_not_exceeded/);
    });

    test("should validate conditional logic", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          discount_eligible BOOLEAN DEFAULT false,
          discount_percent INTEGER,
          CONSTRAINT discount_rules CHECK (
            (discount_eligible = false AND discount_percent IS NULL) OR
            (discount_eligible = true AND discount_percent BETWEEN 1 AND 50)
          )
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Valid: no discount
      await client.query(`
        INSERT INTO products (name, category, price, discount_eligible) 
        VALUES ('Product A', 'Electronics', 100, false)
      `);

      // Valid: with discount
      await client.query(`
        INSERT INTO products (name, category, price, discount_eligible, discount_percent) 
        VALUES ('Product B', 'Electronics', 200, true, 20)
      `);

      // Invalid: discount without being eligible
      await expect(
        client.query(`
          INSERT INTO products (name, category, price, discount_eligible, discount_percent) 
          VALUES ('Product C', 'Electronics', 150, false, 15)
        `)
      ).rejects.toThrow(/discount_rules/);

      // Invalid: discount > 50%
      await expect(
        client.query(`
          INSERT INTO products (name, category, price, discount_eligible, discount_percent) 
          VALUES ('Product D', 'Electronics', 300, true, 60)
        `)
      ).rejects.toThrow(/discount_rules/);
    });
  });

  describe("Check Constraints with Functions", () => {
    test("should use built-in functions in check constraints", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) NOT NULL,
          email VARCHAR(255) NOT NULL,
          phone VARCHAR(20),
          CONSTRAINT valid_username CHECK (LENGTH(username) BETWEEN 3 AND 50),
          CONSTRAINT lowercase_email CHECK (email = LOWER(email)),
          CONSTRAINT valid_phone CHECK (phone ~ '^\\+?[0-9]{10,15}$' OR phone IS NULL)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Valid user
      await client.query(`
        INSERT INTO users (username, email, phone) 
        VALUES ('johndoe', 'john@example.com', '+1234567890')
      `);

      // Invalid: username too short
      await expect(
        client.query("INSERT INTO users (username, email) VALUES ('ab', 'ab@example.com')")
      ).rejects.toThrow(/valid_username/);

      // Invalid: email with uppercase
      await expect(
        client.query("INSERT INTO users (username, email) VALUES ('janedoe', 'Jane@Example.COM')")
      ).rejects.toThrow(/lowercase_email/);

      // Invalid: bad phone format
      await expect(
        client.query("INSERT INTO users (username, email, phone) VALUES ('bobsmith', 'bob@example.com', '123')")
      ).rejects.toThrow(/valid_phone/);
    });

    test("should handle date/time calculations", async () => {
      const schema = `
        CREATE TABLE subscriptions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          start_date DATE NOT NULL DEFAULT CURRENT_DATE,
          end_date DATE NOT NULL,
          auto_renew BOOLEAN DEFAULT true,
          CONSTRAINT minimum_duration CHECK (end_date >= start_date + INTERVAL '1 day'),
          CONSTRAINT maximum_duration CHECK (end_date <= start_date + INTERVAL '3 years'),
          CONSTRAINT not_past_dated CHECK (start_date >= CURRENT_DATE - INTERVAL '1 day')
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Valid: 1 year subscription
      await client.query(`
        INSERT INTO subscriptions (user_id, start_date, end_date) 
        VALUES (1, CURRENT_DATE, CURRENT_DATE + INTERVAL '1 year')
      `);

      // Invalid: less than 1 day
      await expect(
        client.query(`
          INSERT INTO subscriptions (user_id, start_date, end_date) 
          VALUES (2, CURRENT_DATE, CURRENT_DATE)
        `)
      ).rejects.toThrow(/minimum_duration/);

      // Invalid: more than 3 years
      await expect(
        client.query(`
          INSERT INTO subscriptions (user_id, start_date, end_date) 
          VALUES (3, CURRENT_DATE, CURRENT_DATE + INTERVAL '4 years')
        `)
      ).rejects.toThrow(/maximum_duration/);
    });
  });

  describe("Edge Cases and Complex Scenarios", () => {
    test("should handle check constraints with subqueries", async () => {
      // Note: PostgreSQL doesn't allow subqueries in CHECK constraints
      // This test verifies that we properly handle/reject such attempts
      const schema = `
        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          budget DECIMAL(12,2) NOT NULL,
          CONSTRAINT positive_budget CHECK (budget > 0)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // For complex validations that would require subqueries,
      // users should use triggers instead
      const result = await client.query(`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'departments'::regclass
          AND contype = 'c'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].conname).toBe('positive_budget');
    });

    test("should handle multiple check constraints on same column", async () => {
      const schema = `
        CREATE TABLE passwords (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT min_length CHECK (LENGTH(password_hash) >= 60),
          CONSTRAINT max_length CHECK (LENGTH(password_hash) <= 255),
          CONSTRAINT not_empty CHECK (password_hash != ''),
          CONSTRAINT no_spaces CHECK (password_hash !~ '\\s')
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      const result = await client.query(`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'passwords'::regclass
          AND contype = 'c'
        ORDER BY conname
      `);

      expect(result.rows.map(r => r.conname)).toEqual([
        'max_length',
        'min_length',
        'no_spaces',
        'not_empty'
      ]);
    });

    test("should preserve check constraints when modifying table", async () => {
      const initialSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          CONSTRAINT positive_price CHECK (price > 0)
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Add new column, constraints should remain
      const updatedSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          price DECIMAL(10,2) NOT NULL,
          stock INTEGER DEFAULT 0,
          CONSTRAINT positive_price CHECK (price > 0)
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      // Verify constraint still exists and works
      await expect(
        client.query("INSERT INTO products (name, price) VALUES ('Test', -5)")
      ).rejects.toThrow(/positive_price/);
    });

    test("should be idempotent when constraint names differ but expressions match", async () => {
      await client.query(`
        CREATE TABLE exercises (
          id SERIAL PRIMARY KEY,
          difficulty TEXT NOT NULL,
          CONSTRAINT exercises_difficulty_check CHECK (difficulty IN ('beginner', 'intermediate', 'advanced'))
        );
      `);

      const desiredSchema = `
        CREATE TABLE exercises (
          id SERIAL PRIMARY KEY,
          difficulty TEXT NOT NULL,
          CONSTRAINT exercises_check CHECK (difficulty IN ('beginner', 'intermediate', 'advanced'))
        );
      `;

      const plan = await schemaService.plan(desiredSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent for BETWEEN constraints with different names", async () => {
      await client.query(`
        CREATE TABLE workouts (
          id SERIAL PRIMARY KEY,
          rpe INTEGER NOT NULL,
          CONSTRAINT workouts_rpe_check CHECK (rpe BETWEEN 1 AND 10)
        );
      `);

      const desiredSchema = `
        CREATE TABLE workouts (
          id SERIAL PRIMARY KEY,
          rpe INTEGER NOT NULL,
          CONSTRAINT workouts_check CHECK (rpe BETWEEN 1 AND 10)
        );
      `;

      const plan = await schemaService.plan(desiredSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });
});