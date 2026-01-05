import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SchemaService } from "../../../core/schema/service";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  getTableColumns,
  createTestSchemaService,
} from "../../utils";

describe("Type Alias Idempotency", () => {
  let client: Client;
  let service: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);

    
    service = createTestSchemaService();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("INT vs INTEGER Equivalence", () => {
    test("should treat 'int' and 'INTEGER' as identical types", async () => {
      // Create with lowercase 'int'
      const schema1 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age int
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Change to uppercase 'INTEGER' - should detect NO changes
      const schema2 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age INTEGER
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
      expect(plan.concurrent.length).toBe(0);
    });

    test("should treat 'int DEFAULT value' and 'INTEGER DEFAULT value' as identical", async () => {
      // Create with 'int DEFAULT 25'
      const schema1 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age int DEFAULT 25
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Verify column created correctly
      const columns1 = await getTableColumns(client, "users");
      const ageCol1 = columns1.find(c => c.name === "age");
      expect(ageCol1?.type).toBe("integer");
      expect(ageCol1?.default).toMatch(/25/);

      // Change to 'INTEGER DEFAULT 25' - should detect NO changes
      const schema2 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age INTEGER DEFAULT 25
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
      expect(plan.concurrent.length).toBe(0);

      // Apply and verify still no changes on second apply
      await service.apply(schema2, ['public'], true);

      const plan2 = await service.plan(schema2);
      expect(plan2.hasChanges).toBe(false);
    });

    test("should be idempotent when removing default from 'int' to 'INTEGER'", async () => {
      // Create with 'int DEFAULT 25'
      const schema1 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age int DEFAULT 25
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Change to 'INTEGER' (no default) - should only DROP DEFAULT
      const schema2 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age INTEGER
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(true);
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(true);
      expect(plan.transactional.some(s => s.includes("ALTER COLUMN age TYPE"))).toBe(false);

      await service.apply(schema2, ['public'], true);

      // Verify idempotency
      const plan2 = await service.plan(schema2);
      expect(plan2.hasChanges).toBe(false);
    });
  });

  describe("SMALLINT Alias Equivalence", () => {
    test("should treat 'int2' and 'SMALLINT' as identical", async () => {
      const schema1 = `
        CREATE TABLE counters (
          id SERIAL PRIMARY KEY,
          count int2
        );
      `;

      await service.apply(schema1, ['public'], true);

      const schema2 = `
        CREATE TABLE counters (
          id SERIAL PRIMARY KEY,
          count SMALLINT
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
    });

    test("should be idempotent with 'int2 DEFAULT value' and 'SMALLINT DEFAULT value'", async () => {
      const schema1 = `
        CREATE TABLE counters (
          id SERIAL PRIMARY KEY,
          count int2 DEFAULT 0
        );
      `;

      await service.apply(schema1, ['public'], true);

      const schema2 = `
        CREATE TABLE counters (
          id SERIAL PRIMARY KEY,
          count SMALLINT DEFAULT 0
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
    });
  });

  describe("BIGINT Alias Equivalence", () => {
    test("should treat 'int8' and 'BIGINT' as identical", async () => {
      const schema1 = `
        CREATE TABLE large_numbers (
          id SERIAL PRIMARY KEY,
          big_value int8
        );
      `;

      await service.apply(schema1, ['public'], true);

      const schema2 = `
        CREATE TABLE large_numbers (
          id SERIAL PRIMARY KEY,
          big_value BIGINT
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
    });

    test("should be idempotent with 'int8 DEFAULT value' and 'BIGINT DEFAULT value'", async () => {
      const schema1 = `
        CREATE TABLE large_numbers (
          id SERIAL PRIMARY KEY,
          big_value int8 DEFAULT 999999999
        );
      `;

      await service.apply(schema1, ['public'], true);

      const schema2 = `
        CREATE TABLE large_numbers (
          id SERIAL PRIMARY KEY,
          big_value BIGINT DEFAULT 999999999
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
    });
  });

  describe("INTEGER Alias Equivalence (int4)", () => {
    test("should treat 'int4' and 'INTEGER' as identical", async () => {
      const schema1 = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          stock int4
        );
      `;

      await service.apply(schema1, ['public'], true);

      const schema2 = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          stock INTEGER
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
    });

    test("should be idempotent with 'int4 DEFAULT value' and 'INTEGER DEFAULT value'", async () => {
      const schema1 = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          stock int4 DEFAULT 100
        );
      `;

      await service.apply(schema1, ['public'], true);

      const schema2 = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          stock INTEGER DEFAULT 100
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
    });
  });

  describe("Mixed Case Type Aliases", () => {
    test("should handle mixed case variations", async () => {
      const schema1 = `
        CREATE TABLE mixed (
          id SERIAL PRIMARY KEY,
          val1 Int,
          val2 InTeGeR,
          val3 SmAlLiNt
        );
      `;

      await service.apply(schema1, ['public'], true);

      const schema2 = `
        CREATE TABLE mixed (
          id SERIAL PRIMARY KEY,
          val1 INTEGER,
          val2 INTEGER,
          val3 SMALLINT
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
    });
  });

  describe("Type Alias Chains", () => {
    test("should handle transitivity: int -> INTEGER -> int4", async () => {
      // Start with 'int'
      const schema1 = `
        CREATE TABLE chain (
          id SERIAL PRIMARY KEY,
          value int DEFAULT 50
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Change to 'INTEGER'
      const schema2 = `
        CREATE TABLE chain (
          id SERIAL PRIMARY KEY,
          value INTEGER DEFAULT 50
        );
      `;

      const plan1 = await service.plan(schema2);
      expect(plan1.hasChanges).toBe(false);

      await service.apply(schema2, ['public'], true);

      // Change to 'int4'
      const schema3 = `
        CREATE TABLE chain (
          id SERIAL PRIMARY KEY,
          value int4 DEFAULT 50
        );
      `;

      const plan2 = await service.plan(schema3);
      expect(plan2.hasChanges).toBe(false);

      await service.apply(schema3, ['public'], true);

      // Back to 'int' - full circle
      const plan3 = await service.plan(schema1);
      expect(plan3.hasChanges).toBe(false);
    });
  });

  describe("Null Values with Type Aliases", () => {
    test("should handle NULL values consistently across type aliases", async () => {
      const schema1 = `
        CREATE TABLE nullable (
          id SERIAL PRIMARY KEY,
          value int
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Insert NULL
      await client.query("INSERT INTO nullable (value) VALUES (NULL)");

      // Change to INTEGER
      const schema2 = `
        CREATE TABLE nullable (
          id SERIAL PRIMARY KEY,
          value INTEGER
        );
      `;

      await service.apply(schema2, ['public'], true);

      // Verify NULL preserved
      const result = await client.query("SELECT * FROM nullable WHERE id = 1");
      expect(result.rows[0].value).toBeNull();

      // Should still be idempotent
      const plan = await service.plan(schema2);
      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("TIMESTAMPTZ Alias Equivalence", () => {
    test("should treat 'timestamptz' and 'timestamp with time zone' as identical", async () => {
      const schema1 = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          created_at timestamptz
        );
      `;

      await service.apply(schema1, ['public'], true);

      const plan = await service.plan(schema1);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
    });

    test("should be idempotent with 'timestamptz DEFAULT now()'", async () => {
      const schema1 = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          created_at timestamptz DEFAULT now(),
          updated_at timestamptz DEFAULT now()
        );
      `;

      await service.apply(schema1, ['public'], true);

      const plan = await service.plan(schema1);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
    });
  });

  describe("Data Preservation Across Aliases", () => {
    test("should preserve data when switching between int aliases", async () => {
      const schema1 = `
        CREATE TABLE data_test (
          id SERIAL PRIMARY KEY,
          small_val int2 DEFAULT 100,
          medium_val int DEFAULT 1000,
          large_val int8 DEFAULT 10000
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Insert test data
      await client.query("INSERT INTO data_test (id) VALUES (DEFAULT)");
      await client.query("INSERT INTO data_test (small_val, medium_val, large_val) VALUES (50, 500, 5000)");

      // Switch to named aliases
      const schema2 = `
        CREATE TABLE data_test (
          id SERIAL PRIMARY KEY,
          small_val SMALLINT DEFAULT 100,
          medium_val INTEGER DEFAULT 1000,
          large_val BIGINT DEFAULT 10000
        );
      `;

      await service.apply(schema2, ['public'], true);

      // Verify data preserved
      const result = await client.query("SELECT * FROM data_test ORDER BY id");
      expect(result.rows.length).toBe(2);
      expect(result.rows[0].small_val).toBe(100);
      expect(result.rows[0].medium_val).toBe(1000);
      expect(result.rows[0].large_val).toBe("10000");
      expect(result.rows[1].small_val).toBe(50);
      expect(result.rows[1].medium_val).toBe(500);
      expect(result.rows[1].large_val).toBe("5000");

      // Should be idempotent
      const plan = await service.plan(schema2);
      expect(plan.hasChanges).toBe(false);
    });
  });
});
