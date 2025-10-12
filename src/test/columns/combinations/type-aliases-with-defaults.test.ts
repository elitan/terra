import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SchemaService } from "../../../core/schema/service";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  getTableColumns,
  createTestDatabaseService,
} from "../../utils";

describe("Type Aliases with Defaults - Combination Testing", () => {
  let client: Client;
  let service: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);

    const databaseService = createTestDatabaseService();
    service = new SchemaService(databaseService);
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("Type Change with Unchanged Default (Same Value)", () => {
    test("should not drop/set default when converting int to INTEGER with same default", async () => {
      const schema1 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age int DEFAULT 25
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Change type alias but keep same default
      const schema2 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age INTEGER DEFAULT 25
        );
      `;

      const plan = await service.plan(schema2);

      // Should detect NO changes at all
      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
      expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);
      expect(plan.transactional.some(s => s.includes("ALTER COLUMN"))).toBe(false);
    });

    test("should not drop/set default when converting int2 to SMALLINT with same default", async () => {
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
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
      expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);
    });

    test("should not drop/set default when converting int8 to BIGINT with same default", async () => {
      const schema1 = `
        CREATE TABLE large_counters (
          id SERIAL PRIMARY KEY,
          total int8 DEFAULT 999999999
        );
      `;

      await service.apply(schema1, ['public'], true);

      const schema2 = `
        CREATE TABLE large_counters (
          id SERIAL PRIMARY KEY,
          total BIGINT DEFAULT 999999999
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
      expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);
    });
  });

  describe("Type Alias Change with Default Value Change", () => {
    test("should only change default when converting int to INTEGER with different default", async () => {
      const schema1 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age int DEFAULT 25
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Change default value (but type alias is equivalent)
      const schema2 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age INTEGER DEFAULT 30
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(true);
      // Should only have default change operations, not type change
      expect(plan.transactional.some(s => s.includes("SET DEFAULT 30"))).toBe(true);
      expect(plan.transactional.some(s => s.includes("ALTER COLUMN age TYPE"))).toBe(false);
    });
  });

  describe("Type Alias Change with Adding Default", () => {
    test("should only add default when converting int to INTEGER and adding default", async () => {
      const schema1 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age int
        );
      `;

      await service.apply(schema1, ['public'], true);

      const schema2 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age INTEGER DEFAULT 25
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(true);
      expect(plan.transactional.some(s => s.includes("SET DEFAULT 25"))).toBe(true);
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
      expect(plan.transactional.some(s => s.includes("ALTER COLUMN age TYPE"))).toBe(false);
    });
  });

  describe("Type Alias Change with Removing Default", () => {
    test("should only drop default when converting int to INTEGER and removing default", async () => {
      const schema1 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age int DEFAULT 25
        );
      `;

      await service.apply(schema1, ['public'], true);

      const schema2 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age INTEGER
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(true);
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(true);
      expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);
      expect(plan.transactional.some(s => s.includes("ALTER COLUMN age TYPE"))).toBe(false);
    });
  });

  describe("String Type Aliases with Defaults", () => {
    test("should handle VARCHAR vs character varying with same default", async () => {
      const schema1 = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) DEFAULT 'guest'
        );
      `;

      await service.apply(schema1, ['public'], true);

      // PostgreSQL stores as 'character varying', verify idempotency
      const plan = await service.plan(schema1);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
      expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);
    });

    test("should handle TEXT with default that has type cast", async () => {
      const schema1 = `
        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          content TEXT DEFAULT 'empty'
        );
      `;

      await service.apply(schema1, ['public'], true);

      // PostgreSQL may store default as 'empty'::text - should still be idempotent
      const plan = await service.plan(schema1);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
    });
  });

  describe("Multiple Columns with Mixed Type Aliases and Defaults", () => {
    test("should handle multiple type alias changes with various default scenarios", async () => {
      const schema1 = `
        CREATE TABLE mixed (
          id SERIAL PRIMARY KEY,
          col1 int DEFAULT 10,
          col2 int2,
          col3 int8 DEFAULT 999,
          col4 INTEGER DEFAULT 50
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Change all to standard names, keep defaults same
      const schema2 = `
        CREATE TABLE mixed (
          id SERIAL PRIMARY KEY,
          col1 INTEGER DEFAULT 10,
          col2 SMALLINT,
          col3 BIGINT DEFAULT 999,
          col4 int DEFAULT 50
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
    });

    test("should handle mix of default changes and type alias changes", async () => {
      const schema1 = `
        CREATE TABLE mixed (
          id SERIAL PRIMARY KEY,
          col1 int DEFAULT 10,
          col2 int2 DEFAULT 20,
          col3 int8 DEFAULT 30
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Change col1: type alias + same default (no changes)
      // Change col2: type alias + different default (only SET DEFAULT)
      // Change col3: type alias + remove default (only DROP DEFAULT)
      const schema2 = `
        CREATE TABLE mixed (
          id SERIAL PRIMARY KEY,
          col1 INTEGER DEFAULT 10,
          col2 SMALLINT DEFAULT 99,
          col3 BIGINT
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(true);

      // col1 should have no operations
      const col1Operations = plan.transactional.filter(s => s.includes("col1"));
      expect(col1Operations.length).toBe(0);

      // col2 should only change default
      expect(plan.transactional.some(s => s.includes("col2") && s.includes("SET DEFAULT 99"))).toBe(true);
      expect(plan.transactional.some(s => s.includes("col2") && s.includes("TYPE"))).toBe(false);

      // col3 should only drop default
      expect(plan.transactional.some(s => s.includes("col3") && s.includes("DROP DEFAULT"))).toBe(true);
      expect(plan.transactional.some(s => s.includes("col3") && s.includes("TYPE"))).toBe(false);
    });
  });

  describe("Real Type Changes vs Alias Changes", () => {
    test("should distinguish real type change from alias change", async () => {
      const schema1 = `
        CREATE TABLE type_test (
          id SERIAL PRIMARY KEY,
          val int DEFAULT 100
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Change from int (INTEGER) to BIGINT - real type change
      const schema2 = `
        CREATE TABLE type_test (
          id SERIAL PRIMARY KEY,
          val BIGINT DEFAULT 100
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(true);
      // Should have type change operation (but not default operations since default value is same)
      expect(plan.transactional.some(s => s.includes("ALTER COLUMN val TYPE BIGINT"))).toBe(true);
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
      expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);
    });

    test("should handle real type change with default removal correctly", async () => {
      const schema1 = `
        CREATE TABLE type_test (
          id SERIAL PRIMARY KEY,
          val int DEFAULT 100
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Real type change + remove default
      const schema2 = `
        CREATE TABLE type_test (
          id SERIAL PRIMARY KEY,
          val BIGINT
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(true);
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(true);
      expect(plan.transactional.some(s => s.includes("ALTER COLUMN val TYPE BIGINT"))).toBe(true);
      expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);
    });
  });

  describe("Edge Cases with Expression Defaults", () => {
    test("should handle CURRENT_TIMESTAMP with type aliases", async () => {
      const schema1 = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          event_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Should be idempotent
      const plan = await service.plan(schema1);

      expect(plan.hasChanges).toBe(false);
    });

    test("should handle numeric expressions with type aliases", async () => {
      const schema1 = `
        CREATE TABLE calculations (
          id SERIAL PRIMARY KEY,
          result int DEFAULT 0
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Change to INTEGER (alias) - should be idempotent
      const schema2 = `
        CREATE TABLE calculations (
          id SERIAL PRIMARY KEY,
          result INTEGER DEFAULT 0
        );
      `;

      const plan = await service.plan(schema2);

      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Idempotency After Multiple Applies", () => {
    test("should remain idempotent after multiple apply cycles with type aliases", async () => {
      const schema1 = `
        CREATE TABLE cycle_test (
          id SERIAL PRIMARY KEY,
          val1 int DEFAULT 10,
          val2 int2 DEFAULT 20
        );
      `;

      // First apply
      await service.apply(schema1, ['public'], true);
      let plan = await service.plan(schema1);
      expect(plan.hasChanges).toBe(false);

      // Second apply (no-op)
      await service.apply(schema1, ['public'], true);
      plan = await service.plan(schema1);
      expect(plan.hasChanges).toBe(false);

      // Change to aliases
      const schema2 = `
        CREATE TABLE cycle_test (
          id SERIAL PRIMARY KEY,
          val1 INTEGER DEFAULT 10,
          val2 SMALLINT DEFAULT 20
        );
      `;

      // Should show no changes
      plan = await service.plan(schema2);
      expect(plan.hasChanges).toBe(false);

      // Apply and verify still idempotent
      await service.apply(schema2, ['public'], true);
      plan = await service.plan(schema2);
      expect(plan.hasChanges).toBe(false);

      // One more apply
      await service.apply(schema2, ['public'], true);
      plan = await service.plan(schema2);
      expect(plan.hasChanges).toBe(false);
    });
  });

  describe("Data Integrity with Type Aliases and Defaults", () => {
    test("should preserve existing data when switching type aliases", async () => {
      const schema1 = `
        CREATE TABLE data_test (
          id SERIAL PRIMARY KEY,
          value int DEFAULT 50
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Insert some data
      await client.query("INSERT INTO data_test (value) VALUES (100)");
      await client.query("INSERT INTO data_test (value) VALUES (DEFAULT)");
      await client.query("INSERT INTO data_test (value) VALUES (200)");

      // Change to INTEGER alias
      const schema2 = `
        CREATE TABLE data_test (
          id SERIAL PRIMARY KEY,
          value INTEGER DEFAULT 50
        );
      `;

      await service.apply(schema2, ['public'], true);

      // Verify data preserved
      const result = await client.query("SELECT * FROM data_test ORDER BY id");
      expect(result.rows.length).toBe(3);
      expect(result.rows[0].value).toBe(100);
      expect(result.rows[1].value).toBe(50);
      expect(result.rows[2].value).toBe(200);

      // Verify default still works
      await client.query("INSERT INTO data_test (id) VALUES (DEFAULT)");
      const newRow = await client.query("SELECT value FROM data_test WHERE id = 4");
      expect(newRow.rows[0].value).toBe(50);
    });
  });
});
