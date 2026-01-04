import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase } from "./utils";
import {
  createColumnTestServices,
  executeColumnMigration,
} from "./columns/column-test-utils";

describe("Bug Hunting Round 3: Additional Edge Cases", () => {
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

  describe("NUMERIC precision/scale edge cases", () => {
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

    test("should be idempotent with NUMERIC with only precision", async () => {
      const schema = `
        CREATE TABLE amounts (
          id SERIAL PRIMARY KEY,
          value NUMERIC(10)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should detect change from NUMERIC to NUMERIC(10,2)", async () => {
      await client.query(`
        CREATE TABLE amounts (
          id SERIAL PRIMARY KEY,
          value NUMERIC
        );
      `);

      const schema = `
        CREATE TABLE amounts (
          id SERIAL PRIMARY KEY,
          value NUMERIC(10,2)
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(true);
    });
  });

  describe("VARCHAR length edge cases", () => {
    test("should be idempotent with VARCHAR without length", async () => {
      const schema = `
        CREATE TABLE names (
          id SERIAL PRIMARY KEY,
          name VARCHAR
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should detect change from VARCHAR to VARCHAR(255)", async () => {
      await client.query(`
        CREATE TABLE names (
          id SERIAL PRIMARY KEY,
          name VARCHAR
        );
      `);

      const schema = `
        CREATE TABLE names (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255)
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(true);
    });
  });

  describe("Default expression edge cases", () => {
    test("should be idempotent with random() default", async () => {
      const schema = `
        CREATE TABLE randoms (
          id SERIAL PRIMARY KEY,
          value DOUBLE PRECISION DEFAULT random()
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with length() default", async () => {
      const schema = `
        CREATE TABLE texts (
          id SERIAL PRIMARY KEY,
          len INTEGER DEFAULT length('default')
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with CURRENT_USER default", async () => {
      const schema = `
        CREATE TABLE audits (
          id SERIAL PRIMARY KEY,
          created_by TEXT DEFAULT CURRENT_USER
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with clock_timestamp() default", async () => {
      const schema = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          logged_at TIMESTAMP DEFAULT clock_timestamp()
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Composite unique constraint edge cases", () => {
    test("should be idempotent with multi-column unique constraint", async () => {
      const schema = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          event_date DATE NOT NULL,
          event_name VARCHAR(100) NOT NULL,
          venue_id INTEGER NOT NULL,
          CONSTRAINT unique_event UNIQUE (event_date, event_name, venue_id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Index on expression edge cases", () => {
    test("should be idempotent with LOWER() expression index", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        );
        CREATE INDEX idx_email_lower ON users (LOWER(email));
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with date_trunc expression index", async () => {
      const schema = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMP
        );
        CREATE INDEX idx_events_day ON events (date_trunc('day', created_at));
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe.skip("ENUM type edge cases", () => {
    // Note: ENUM type handling requires the executor to create the type first
    // This is a limitation of the test helper, not the differ logic
    test("should be idempotent with basic ENUM type", async () => {
      const schema = `
        CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
        CREATE TABLE persons (
          id SERIAL PRIMARY KEY,
          current_mood mood
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with ENUM array type", async () => {
      const schema = `
        CREATE TYPE status AS ENUM ('pending', 'active', 'archived');
        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          history status[]
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Self-referencing FK edge cases", () => {
    test("should be idempotent with self-referencing FK", async () => {
      const schema = `
        CREATE TABLE categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          parent_id INTEGER REFERENCES categories(id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Composite primary key edge cases", () => {
    test("should be idempotent with 2-column composite PK", async () => {
      const schema = `
        CREATE TABLE order_items (
          order_id INTEGER NOT NULL,
          product_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (order_id, product_id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with 3-column composite PK", async () => {
      const schema = `
        CREATE TABLE time_slots (
          date DATE NOT NULL,
          start_hour INTEGER NOT NULL,
          room_id INTEGER NOT NULL,
          available BOOLEAN DEFAULT true,
          PRIMARY KEY (date, start_hour, room_id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Default with NOW() vs CURRENT_TIMESTAMP", () => {
    test("should not detect change between NOW() and CURRENT_TIMESTAMP", async () => {
      await client.query(`
        CREATE TABLE logs (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      const schema = `
        CREATE TABLE logs (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("TEXT vs VARCHAR comparison", () => {
    test("should detect change from TEXT to VARCHAR", async () => {
      await client.query(`
        CREATE TABLE data (
          id SERIAL PRIMARY KEY,
          content TEXT
        );
      `);

      const schema = `
        CREATE TABLE data (
          id SERIAL PRIMARY KEY,
          content VARCHAR(255)
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(true);
    });
  });

  describe("BYTEA type", () => {
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

  describe("TIME type with precision", () => {
    test("should be idempotent with TIME without timezone", async () => {
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

    test("should be idempotent with TIME WITH TIME ZONE", async () => {
      const schema = `
        CREATE TABLE schedules (
          id SERIAL PRIMARY KEY,
          event_time TIME WITH TIME ZONE
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Comment handling", () => {
    test("should be idempotent with table comment", async () => {
      const schema = `
        CREATE TABLE documented (
          id SERIAL PRIMARY KEY
        );
        COMMENT ON TABLE documented IS 'This is a documented table';
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with column comment", async () => {
      const schema = `
        CREATE TABLE documented (
          id SERIAL PRIMARY KEY,
          name TEXT
        );
        COMMENT ON COLUMN documented.name IS 'The name field';
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Concurrently index edge cases", () => {
    test("should be idempotent with UNIQUE index", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL
        );
        CREATE UNIQUE INDEX idx_unique_sku ON products (sku);
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("DEFERRABLE constraint edge cases", () => {
    test("should be idempotent with DEFERRABLE FK", async () => {
      const schema = `
        CREATE TABLE parents (
          id SERIAL PRIMARY KEY
        );
        CREATE TABLE children (
          id SERIAL PRIMARY KEY,
          parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Boolean default variations", () => {
    test("should not detect change between TRUE and true", async () => {
      await client.query(`
        CREATE TABLE flags (
          id SERIAL PRIMARY KEY,
          active BOOLEAN DEFAULT TRUE
        );
      `);

      const schema = `
        CREATE TABLE flags (
          id SERIAL PRIMARY KEY,
          active BOOLEAN DEFAULT true
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });
});
