import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "./utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  findColumn,
} from "./columns/column-test-utils";

describe("Bug Hunting: Edge Cases That Should Pass", () => {
  let client: Client;
  const services = createColumnTestServices();

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("Partial Index WHERE Clause Normalization", () => {
    test("BUG: should be idempotent with different whitespace in WHERE clause", async () => {
      await client.query(`
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          status VARCHAR(50),
          active BOOLEAN DEFAULT true
        );
      `);
      await client.query(`
        CREATE INDEX idx_active ON orders (status) WHERE active = true;
      `);

      const schema = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          status VARCHAR(50),
          active BOOLEAN DEFAULT true
        );
        CREATE INDEX idx_active ON orders (status) WHERE active=true;
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("BUG: should be idempotent with extra parentheses in WHERE clause", async () => {
      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          active BOOLEAN
        );
      `);
      await client.query(`
        CREATE INDEX idx_users_active ON users (email) WHERE (active = true);
      `);

      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          active BOOLEAN
        );
        CREATE INDEX idx_users_active ON users (email) WHERE active = true;
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Generated Column Expression Edge Cases", () => {
    test("should be idempotent with type cast in generated expression", async () => {
      const schema = `
        CREATE TABLE prices (
          id SERIAL PRIMARY KEY,
          amount NUMERIC(10, 2),
          formatted TEXT GENERATED ALWAYS AS (amount::text || ' USD') STORED
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("BUG: should be idempotent with schema-qualified function in generated column", async () => {
      const schema = `
        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          name TEXT,
          upper_name TEXT GENERATED ALWAYS AS (pg_catalog.upper(name)) STORED
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with COALESCE expression", async () => {
      const schema = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          name TEXT,
          display_name TEXT GENERATED ALWAYS AS (
            COALESCE(name, 'unknown')
          ) STORED
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("BUG: should handle generated column with nested CASE and parentheses", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          price NUMERIC(10, 2),
          discount NUMERIC(5, 2),
          final_price NUMERIC(10, 2) GENERATED ALWAYS AS (
            CASE
              WHEN (discount IS NOT NULL AND discount > 0) THEN (price * (1 - discount))
              ELSE price
            END
          ) STORED
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Default Value Edge Cases", () => {
    test("BUG: should be idempotent with negative number default", async () => {
      const schema = `
        CREATE TABLE settings (
          id SERIAL PRIMARY KEY,
          threshold INTEGER DEFAULT -100
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("BUG: should be idempotent with negative decimal default", async () => {
      const schema = `
        CREATE TABLE transactions (
          id SERIAL PRIMARY KEY,
          adjustment NUMERIC(10, 2) DEFAULT -99.99
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with function call as default", async () => {
      const schema = `
        CREATE TABLE logs (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with NOW() default", async () => {
      const schema = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          event_time TIMESTAMP DEFAULT NOW()
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with array default", async () => {
      const schema = `
        CREATE TABLE configs (
          id SERIAL PRIMARY KEY,
          tags TEXT[] DEFAULT '{}'
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("BUG: should be idempotent with ARRAY[] constructor default", async () => {
      const schema = `
        CREATE TABLE configs (
          id SERIAL PRIMARY KEY,
          tags TEXT[] DEFAULT ARRAY[]::TEXT[]
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("NUMERIC/DECIMAL Edge Cases", () => {
    test("should be idempotent with NUMERIC without precision", async () => {
      const schema = `
        CREATE TABLE amounts (
          id SERIAL PRIMARY KEY,
          value NUMERIC
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with DECIMAL alias", async () => {
      const schema = `
        CREATE TABLE prices (
          id SERIAL PRIMARY KEY,
          amount DECIMAL(10, 2)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should not detect change between NUMERIC and DECIMAL", async () => {
      await client.query(`
        CREATE TABLE test_amounts (
          id SERIAL PRIMARY KEY,
          value NUMERIC(10, 2)
        );
      `);

      const schema = `
        CREATE TABLE test_amounts (
          id SERIAL PRIMARY KEY,
          value DECIMAL(10, 2)
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("CHECK Constraint Edge Cases", () => {
    test("BUG: should be idempotent with complex boolean expression", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          price NUMERIC(10, 2),
          discount NUMERIC(5, 2),
          CONSTRAINT valid_pricing CHECK (
            (price > 0 AND discount >= 0 AND discount < 1) OR
            (price = 0 AND discount = 0)
          )
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("BUG: should be idempotent with whitespace differences in CHECK", async () => {
      await client.query(`
        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          qty INTEGER,
          CONSTRAINT positive_qty CHECK (qty > 0)
        );
      `);

      const schema = `
        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          qty INTEGER,
          CONSTRAINT positive_qty CHECK (qty>0)
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Foreign Key Edge Cases", () => {
    test("should handle FK with column names containing underscores", async () => {
      const schema = `
        CREATE TABLE parent_table (
          parent_id SERIAL PRIMARY KEY
        );
        CREATE TABLE child_table (
          id SERIAL PRIMARY KEY,
          parent_table_id INTEGER REFERENCES parent_table(parent_id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should handle self-referencing FK", async () => {
      const schema = `
        CREATE TABLE categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100),
          parent_id INTEGER REFERENCES categories(id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should handle self-referencing FK combined with cycle to another table", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          manager_id INTEGER REFERENCES users(id),
          department_id INTEGER REFERENCES departments(id)
        );
        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          head_user_id INTEGER REFERENCES users(id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const result = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('users', 'departments')
      `);
      expect(result.rows.length).toBe(2);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Index Edge Cases", () => {
    test("should be idempotent with expression index", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        );
        CREATE INDEX idx_users_lower_email ON users (LOWER(email));
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with multi-column expression index", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255),
          description TEXT
        );
        CREATE INDEX idx_search ON products (LOWER(name), LOWER(description));
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with DESC index", async () => {
      const schema = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMP
        );
        CREATE INDEX idx_events_recent ON events (created_at DESC);
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with NULLS FIRST/LAST", async () => {
      const schema = `
        CREATE TABLE tasks (
          id SERIAL PRIMARY KEY,
          due_date DATE
        );
        CREATE INDEX idx_tasks_due ON tasks (due_date NULLS LAST);
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Unique Constraint Edge Cases", () => {
    test("should handle unique constraint with multiple columns", async () => {
      const schema = `
        CREATE TABLE user_roles (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          role_id INTEGER NOT NULL,
          CONSTRAINT unique_user_role UNIQUE (user_id, role_id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("BUG: unique constraint column order not detected as change", async () => {
      await client.query(`
        CREATE TABLE pairs (
          id SERIAL PRIMARY KEY,
          a INTEGER,
          b INTEGER,
          CONSTRAINT unique_pair UNIQUE (a, b)
        );
      `);

      const schema = `
        CREATE TABLE pairs (
          id SERIAL PRIMARY KEY,
          a INTEGER,
          b INTEGER,
          CONSTRAINT unique_pair UNIQUE (b, a)
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(true);
    });
  });

  describe("Column Type Edge Cases", () => {
    test("should be idempotent with VARCHAR without length", async () => {
      const schema = `
        CREATE TABLE notes (
          id SERIAL PRIMARY KEY,
          content VARCHAR
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("BUG: should be idempotent with CHAR type", async () => {
      const schema = `
        CREATE TABLE codes (
          id SERIAL PRIMARY KEY,
          code CHAR(10)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("BUG: should be idempotent with TIME type", async () => {
      const schema = `
        CREATE TABLE schedules (
          id SERIAL PRIMARY KEY,
          start_time TIME
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("BUG: should be idempotent with TIME WITH TIME ZONE", async () => {
      const schema = `
        CREATE TABLE global_schedules (
          id SERIAL PRIMARY KEY,
          start_time TIME WITH TIME ZONE
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with INTERVAL type", async () => {
      const schema = `
        CREATE TABLE durations (
          id SERIAL PRIMARY KEY,
          duration INTERVAL
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with UUID type", async () => {
      const schema = `
        CREATE TABLE entities (
          id UUID PRIMARY KEY,
          name TEXT
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with JSONB type", async () => {
      const schema = `
        CREATE TABLE documents (
          id SERIAL PRIMARY KEY,
          data JSONB
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with BYTEA type", async () => {
      const schema = `
        CREATE TABLE files (
          id SERIAL PRIMARY KEY,
          content BYTEA
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Quoted Identifier Edge Cases", () => {
    test("should handle table name that is a reserved word", async () => {
      const schema = `
        CREATE TABLE "order" (
          id SERIAL PRIMARY KEY,
          name TEXT
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should handle column name that is a reserved word", async () => {
      const schema = `
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          "select" TEXT,
          "from" INTEGER
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should handle mixed case identifiers", async () => {
      const schema = `
        CREATE TABLE "MyTable" (
          id SERIAL PRIMARY KEY,
          "mixedCaseColumn" TEXT
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Primary Key Edge Cases", () => {
    test("should handle composite primary key", async () => {
      const schema = `
        CREATE TABLE order_items (
          order_id INTEGER NOT NULL,
          item_id INTEGER NOT NULL,
          quantity INTEGER,
          PRIMARY KEY (order_id, item_id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should handle named primary key constraint", async () => {
      const schema = `
        CREATE TABLE products (
          id INTEGER NOT NULL,
          CONSTRAINT pk_products PRIMARY KEY (id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Empty and Edge Cases", () => {
    test("should handle table with only primary key column", async () => {
      const schema = `
        CREATE TABLE minimal (
          id SERIAL PRIMARY KEY
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should handle empty string default", async () => {
      const schema = `
        CREATE TABLE names (
          id SERIAL PRIMARY KEY,
          nickname VARCHAR(100) DEFAULT ''
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should handle boolean default true", async () => {
      const schema = `
        CREATE TABLE flags (
          id SERIAL PRIMARY KEY,
          active BOOLEAN DEFAULT true
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should handle boolean default false", async () => {
      const schema = `
        CREATE TABLE flags (
          id SERIAL PRIMARY KEY,
          deleted BOOLEAN DEFAULT false
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Float/Double Edge Cases", () => {
    test("BUG: should be idempotent with REAL type", async () => {
      const schema = `
        CREATE TABLE measurements (
          id SERIAL PRIMARY KEY,
          value REAL
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("BUG: should be idempotent with DOUBLE PRECISION type", async () => {
      const schema = `
        CREATE TABLE coordinates (
          id SERIAL PRIMARY KEY,
          latitude DOUBLE PRECISION,
          longitude DOUBLE PRECISION
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("BUG: should not detect change between FLOAT8 and DOUBLE PRECISION", async () => {
      await client.query(`
        CREATE TABLE test_floats (
          id SERIAL PRIMARY KEY,
          value DOUBLE PRECISION
        );
      `);

      const schema = `
        CREATE TABLE test_floats (
          id SERIAL PRIMARY KEY,
          value FLOAT8
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Timestamp Edge Cases", () => {
    test("should be idempotent with TIMESTAMP WITHOUT TIME ZONE", async () => {
      const schema = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMP WITHOUT TIME ZONE
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with TIMESTAMPTZ", async () => {
      const schema = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should not detect change between TIMESTAMP WITH TIME ZONE and TIMESTAMPTZ", async () => {
      await client.query(`
        CREATE TABLE tz_events (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ
        );
      `);

      const schema = `
        CREATE TABLE tz_events (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMP WITH TIME ZONE
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Complex Schema Edge Cases", () => {
    test("should handle multiple tables with circular references", async () => {
      const schema = `
        CREATE TABLE authors (
          id SERIAL PRIMARY KEY,
          name TEXT,
          favorite_book_id INTEGER REFERENCES books(id)
        );
        CREATE TABLE books (
          id SERIAL PRIMARY KEY,
          title TEXT,
          author_id INTEGER REFERENCES authors(id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const result = await client.query(`
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_name = 'authors' AND constraint_type = 'FOREIGN KEY'
      `);
      expect(result.rows.length).toBe(1);
    });

    test("should be idempotent after handling circular references", async () => {
      const schema = `
        CREATE TABLE authors (
          id SERIAL PRIMARY KEY,
          name TEXT,
          favorite_book_id INTEGER REFERENCES books(id)
        );
        CREATE TABLE books (
          id SERIAL PRIMARY KEY,
          title TEXT,
          author_id INTEGER REFERENCES authors(id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Special Characters in Identifiers", () => {
    test("should handle column name with spaces (quoted)", async () => {
      const schema = `
        CREATE TABLE special_names (
          id SERIAL PRIMARY KEY,
          "first name" TEXT,
          "last name" TEXT
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should handle identifiers with numbers", async () => {
      const schema = `
        CREATE TABLE table123 (
          id SERIAL PRIMARY KEY,
          column456 TEXT
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Generated Column with Quoted Identifiers", () => {
    test("should be idempotent with generated column referencing quoted column", async () => {
      const schema = `
        CREATE TABLE test_quoted (
          id SERIAL PRIMARY KEY,
          "firstName" TEXT,
          "lastName" TEXT,
          "fullName" TEXT GENERATED ALWAYS AS ("firstName" || ' ' || "lastName") STORED
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });
});
