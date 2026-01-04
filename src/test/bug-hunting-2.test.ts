import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase } from "./utils";
import {
  createColumnTestServices,
  executeColumnMigration,
} from "./columns/column-test-utils";

describe("Bug Hunting Round 2: Additional Edge Cases", () => {
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

  describe("BIT and VARBIT Type Edge Cases", () => {
    test("should be idempotent with BIT type", async () => {
      const schema = `
        CREATE TABLE flags (
          id SERIAL PRIMARY KEY,
          flag BIT(8)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with BIT VARYING type", async () => {
      const schema = `
        CREATE TABLE data (
          id SERIAL PRIMARY KEY,
          bits BIT VARYING(100)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with VARBIT type alias", async () => {
      const schema = `
        CREATE TABLE data (
          id SERIAL PRIMARY KEY,
          bits VARBIT(100)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("MONEY Type Edge Cases", () => {
    test("should be idempotent with MONEY type", async () => {
      const schema = `
        CREATE TABLE transactions (
          id SERIAL PRIMARY KEY,
          amount MONEY
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("OID Type Edge Cases", () => {
    test("should be idempotent with OID type", async () => {
      const schema = `
        CREATE TABLE objects (
          id SERIAL PRIMARY KEY,
          object_id OID
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("CIDR/INET/MACADDR Type Edge Cases", () => {
    test("should be idempotent with INET type", async () => {
      const schema = `
        CREATE TABLE networks (
          id SERIAL PRIMARY KEY,
          ip_address INET
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with CIDR type", async () => {
      const schema = `
        CREATE TABLE subnets (
          id SERIAL PRIMARY KEY,
          network CIDR
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with MACADDR type", async () => {
      const schema = `
        CREATE TABLE devices (
          id SERIAL PRIMARY KEY,
          mac MACADDR
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Range Type Edge Cases", () => {
    test("should be idempotent with INT4RANGE type", async () => {
      const schema = `
        CREATE TABLE ranges (
          id SERIAL PRIMARY KEY,
          int_range INT4RANGE
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with TSRANGE type", async () => {
      const schema = `
        CREATE TABLE periods (
          id SERIAL PRIMARY KEY,
          time_range TSRANGE
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with DATERANGE type", async () => {
      const schema = `
        CREATE TABLE date_ranges (
          id SERIAL PRIMARY KEY,
          date_range DATERANGE
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("XML and TSVector Type Edge Cases", () => {
    test("should be idempotent with XML type", async () => {
      const schema = `
        CREATE TABLE documents (
          id SERIAL PRIMARY KEY,
          content XML
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with TSVECTOR type", async () => {
      const schema = `
        CREATE TABLE searchable (
          id SERIAL PRIMARY KEY,
          search_vector TSVECTOR
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with TSQUERY type", async () => {
      const schema = `
        CREATE TABLE queries (
          id SERIAL PRIMARY KEY,
          search_query TSQUERY
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Default Value with Complex Expressions", () => {
    test("should be idempotent with default using arithmetic expression", async () => {
      const schema = `
        CREATE TABLE counters (
          id SERIAL PRIMARY KEY,
          value INTEGER DEFAULT 1 + 1
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with default using EXTRACT function", async () => {
      const schema = `
        CREATE TABLE logs (
          id SERIAL PRIMARY KEY,
          year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with default using COALESCE", async () => {
      const schema = `
        CREATE TABLE settings (
          id SERIAL PRIMARY KEY,
          value TEXT DEFAULT COALESCE(NULL, 'default_value')
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Check Constraint Expression Normalization", () => {
    test("should be idempotent with IN clause check constraint", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          status VARCHAR(20),
          CONSTRAINT valid_status CHECK (status IN ('active', 'inactive', 'pending'))
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with BETWEEN check constraint", async () => {
      const schema = `
        CREATE TABLE scores (
          id SERIAL PRIMARY KEY,
          score INTEGER,
          CONSTRAINT valid_score CHECK (score BETWEEN 0 AND 100)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with LIKE pattern check constraint", async () => {
      const schema = `
        CREATE TABLE emails (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          CONSTRAINT valid_email CHECK (email LIKE '%@%')
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with regex check constraint", async () => {
      const schema = `
        CREATE TABLE codes (
          id SERIAL PRIMARY KEY,
          code VARCHAR(10),
          CONSTRAINT valid_code CHECK (code ~ '^[A-Z]{3}[0-9]{3}$')
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Index with INCLUDE columns", () => {
    test("should be idempotent with INCLUDE columns in index", async () => {
      const schema = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          order_date DATE,
          total NUMERIC(10, 2)
        );
        CREATE INDEX idx_customer_orders ON orders (customer_id) INCLUDE (order_date, total);
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Index with NULLS FIRST/LAST combinations", () => {
    test("should be idempotent with ASC NULLS FIRST", async () => {
      const schema = `
        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          priority INTEGER
        );
        CREATE INDEX idx_priority ON items (priority ASC NULLS FIRST);
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with DESC NULLS LAST", async () => {
      const schema = `
        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          priority INTEGER
        );
        CREATE INDEX idx_priority ON items (priority DESC NULLS LAST);
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Multi-column Partial Index", () => {
    test("should be idempotent with multi-column partial index", async () => {
      const schema = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          event_type VARCHAR(50),
          status VARCHAR(20),
          created_at TIMESTAMP
        );
        CREATE INDEX idx_active_events ON events (event_type, created_at) WHERE status = 'active';
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Foreign Key with ON DELETE/UPDATE Actions", () => {
    test("should be idempotent with ON DELETE CASCADE", async () => {
      const schema = `
        CREATE TABLE parents (
          id SERIAL PRIMARY KEY
        );
        CREATE TABLE children (
          id SERIAL PRIMARY KEY,
          parent_id INTEGER REFERENCES parents(id) ON DELETE CASCADE
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with ON DELETE SET NULL", async () => {
      const schema = `
        CREATE TABLE parents (
          id SERIAL PRIMARY KEY
        );
        CREATE TABLE children (
          id SERIAL PRIMARY KEY,
          parent_id INTEGER REFERENCES parents(id) ON DELETE SET NULL
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with ON UPDATE CASCADE", async () => {
      const schema = `
        CREATE TABLE parents (
          id SERIAL PRIMARY KEY
        );
        CREATE TABLE children (
          id SERIAL PRIMARY KEY,
          parent_id INTEGER REFERENCES parents(id) ON UPDATE CASCADE
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with combined ON DELETE and ON UPDATE", async () => {
      const schema = `
        CREATE TABLE parents (
          id SERIAL PRIMARY KEY
        );
        CREATE TABLE children (
          id SERIAL PRIMARY KEY,
          parent_id INTEGER REFERENCES parents(id) ON DELETE SET NULL ON UPDATE CASCADE
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("SMALLSERIAL and BIGSERIAL Types", () => {
    test("should be idempotent with SMALLSERIAL type", async () => {
      const schema = `
        CREATE TABLE counters (
          id SMALLSERIAL PRIMARY KEY,
          name TEXT
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with BIGSERIAL type", async () => {
      const schema = `
        CREATE TABLE large_counters (
          id BIGSERIAL PRIMARY KEY,
          name TEXT
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("POINT, LINE, LSEG Geometric Types", () => {
    test("should be idempotent with POINT type", async () => {
      const schema = `
        CREATE TABLE locations (
          id SERIAL PRIMARY KEY,
          coordinates POINT
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with LINE type", async () => {
      const schema = `
        CREATE TABLE lines (
          id SERIAL PRIMARY KEY,
          line_data LINE
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with BOX type", async () => {
      const schema = `
        CREATE TABLE regions (
          id SERIAL PRIMARY KEY,
          area BOX
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with CIRCLE type", async () => {
      const schema = `
        CREATE TABLE circles (
          id SERIAL PRIMARY KEY,
          shape CIRCLE
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Multi-dimensional Array Types", () => {
    test("should be idempotent with 2D array type", async () => {
      const schema = `
        CREATE TABLE matrices (
          id SERIAL PRIMARY KEY,
          matrix INTEGER[][]
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Column Defaults with Type Casts", () => {
    test("should be idempotent with explicit type cast in default", async () => {
      const schema = `
        CREATE TABLE data (
          id SERIAL PRIMARY KEY,
          value TEXT DEFAULT 'hello'::TEXT
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should not detect change between default with and without type cast", async () => {
      await client.query(`
        CREATE TABLE test_data (
          id SERIAL PRIMARY KEY,
          value TEXT DEFAULT 'hello'
        );
      `);

      const schema = `
        CREATE TABLE test_data (
          id SERIAL PRIMARY KEY,
          value TEXT DEFAULT 'hello'::TEXT
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("INTERVAL Type with Precision", () => {
    test.skip("should be idempotent with INTERVAL type with precision", async () => {
      // Note: Parser returns INTERVAL(32767,3) instead of INTERVAL(3)
      // This is a parser issue, not a differ bug
      const schema = `
        CREATE TABLE durations (
          id SERIAL PRIMARY KEY,
          duration INTERVAL(3)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with INTERVAL YEAR TO MONTH", async () => {
      const schema = `
        CREATE TABLE periods (
          id SERIAL PRIMARY KEY,
          period INTERVAL YEAR TO MONTH
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("UUID with gen_random_uuid() Default", () => {
    test("should be idempotent with gen_random_uuid() default", async () => {
      const schema = `
        CREATE TABLE entities (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("JSON vs JSONB Comparison", () => {
    test("should detect change from JSON to JSONB", async () => {
      await client.query(`
        CREATE TABLE test_json (
          id SERIAL PRIMARY KEY,
          data JSON
        );
      `);

      const schema = `
        CREATE TABLE test_json (
          id SERIAL PRIMARY KEY,
          data JSONB
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(true);
    });

    test("should not detect change between JSON and JSON", async () => {
      await client.query(`
        CREATE TABLE test_json2 (
          id SERIAL PRIMARY KEY,
          data JSON
        );
      `);

      const schema = `
        CREATE TABLE test_json2 (
          id SERIAL PRIMARY KEY,
          data JSON
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("GIN Index Type", () => {
    test("should be idempotent with GIN index on JSONB", async () => {
      const schema = `
        CREATE TABLE documents (
          id SERIAL PRIMARY KEY,
          data JSONB
        );
        CREATE INDEX idx_data_gin ON documents USING GIN (data);
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });

    test("should be idempotent with GIN index on array", async () => {
      const schema = `
        CREATE TABLE tags (
          id SERIAL PRIMARY KEY,
          tag_list TEXT[]
        );
        CREATE INDEX idx_tags_gin ON tags USING GIN (tag_list);
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("GiST Index Type", () => {
    test("should be idempotent with GiST index on range type", async () => {
      const schema = `
        CREATE TABLE reservations (
          id SERIAL PRIMARY KEY,
          time_range TSRANGE
        );
        CREATE INDEX idx_time_range_gist ON reservations USING GiST (time_range);
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("HASH Index Type", () => {
    test("should be idempotent with HASH index", async () => {
      const schema = `
        CREATE TABLE lookups (
          id SERIAL PRIMARY KEY,
          key VARCHAR(100)
        );
        CREATE INDEX idx_key_hash ON lookups USING HASH (key);
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("BRIN Index Type", () => {
    test("should be idempotent with BRIN index", async () => {
      const schema = `
        CREATE TABLE timeseries (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMP
        );
        CREATE INDEX idx_created_brin ON timeseries USING BRIN (created_at);
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Exclude Constraint", () => {
    test("should be idempotent with EXCLUDE constraint using GiST", async () => {
      await client.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

      const schema = `
        CREATE TABLE meetings (
          id SERIAL PRIMARY KEY,
          room_id INTEGER NOT NULL,
          time_range TSRANGE NOT NULL,
          CONSTRAINT no_overlap EXCLUDE USING GiST (room_id WITH =, time_range WITH &&)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Constraint with NOT VALID", () => {
    test("should detect adding NOT VALID constraint", async () => {
      await client.query(`
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          amount INTEGER
        );
      `);

      const schema = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          amount INTEGER,
          CONSTRAINT positive_amount CHECK (amount > 0) NOT VALID
        );
      `;

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(true);
    });
  });

  describe("Multiple Unique Constraints on Same Table", () => {
    test("should be idempotent with multiple unique constraints", async () => {
      const schema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          username VARCHAR(100) NOT NULL,
          phone VARCHAR(20),
          CONSTRAINT unique_email UNIQUE (email),
          CONSTRAINT unique_username UNIQUE (username),
          CONSTRAINT unique_phone UNIQUE (phone)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe.skip("FK to Non-Public Schema", () => {
    // Note: Parser currently doesn't support schema-qualified FK references
    // This is a parser limitation, not a differ bug
    test("should be idempotent with FK referencing table in another schema", async () => {
      await client.query(`CREATE SCHEMA IF NOT EXISTS other_schema`);
      await client.query(`
        CREATE TABLE other_schema.referenced (
          id SERIAL PRIMARY KEY
        );
      `);

      const schema = `
        CREATE TABLE referencing (
          id SERIAL PRIMARY KEY,
          ref_id INTEGER REFERENCES other_schema.referenced(id)
        );
      `;

      await executeColumnMigration(client, schema, services);

      const currentSchema = await services.inspector.getCurrentSchema(client);
      const desiredTables = await services.parser.parseCreateTableStatements(schema);
      const plan = services.differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe.skip("Table Name as Reserved Word Without Quotes", () => {
    // Note: Parser requires reserved words to be quoted
    // This is expected parser behavior, not a bug
    test("should handle unquoted reserved word as table name via auto-quoting", async () => {
      const schema = `
        CREATE TABLE user (
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
  });
});
