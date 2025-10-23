import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SchemaService } from "../../core/schema/service";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  getTableColumns,
  createTestDatabaseService,
} from "../utils";

/**
 * Regression Tests for Default Value and Type Normalization Bugs
 *
 * These tests document and prevent regression of bugs found in production.
 * Each test corresponds to a specific bug that was discovered and fixed.
 */

describe("Regression: Default Value and Type Normalization Bugs", () => {
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

  describe("Bug 1: Unnecessary DEFAULT operations during type changes", () => {
    /**
     * Bug Description:
     * When converting TEXT DEFAULT 'hejsan' to VARCHAR(255) DEFAULT 'hejsan',
     * Terra generated 3 unnecessary statements:
     * 1. DROP DEFAULT
     * 2. ALTER TYPE
     * 3. SET DEFAULT
     *
     * Root Cause:
     * The differ wasn't normalizing default values before comparison.
     * PostgreSQL stores defaults with type casts (e.g., 'hejsan'::text),
     * but the differ was comparing raw values.
     *
     * Fix:
     * Updated src/core/schema/differ.ts:203-206 to use normalizeDefault()
     * utility function, which strips PostgreSQL type casts before comparing.
     */

    test("should NOT drop/set default when converting TEXT to VARCHAR with same default", async () => {
      // Initial schema: TEXT with default
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name TEXT DEFAULT 'hejsan'
        );
      `;

      await service.apply(initialSchema, ['public'], true);

      // Verify initial state
      const initialColumns = await getTableColumns(client, "users");
      const nameCol = initialColumns.find(c => c.name === "name");
      expect(nameCol?.type).toBe("text");
      expect(nameCol?.default).toMatch(/hejsan/);

      // Change to VARCHAR(255) with same default
      const modifiedSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) DEFAULT 'hejsan'
        );
      `;

      const plan = await service.plan(modifiedSchema);

      // CRITICAL: Should only have 1 statement (ALTER TYPE), not 3
      expect(plan.transactional.length).toBe(1);
      expect(plan.transactional[0]).toContain('ALTER COLUMN "name" TYPE VARCHAR(255)');

      // Should NOT have DROP DEFAULT or SET DEFAULT
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
      expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);

      // Apply and verify final state
      await service.apply(modifiedSchema, ['public'], true);

      const finalColumns = await getTableColumns(client, "users");
      const finalNameCol = finalColumns.find(c => c.name === "name");
      expect(finalNameCol?.type).toBe("character varying");
      expect(finalNameCol?.default).toMatch(/hejsan/);

      // CRITICAL: Must be idempotent after apply
      const plan2 = await service.plan(modifiedSchema);
      expect(plan2.hasChanges).toBe(false);
      expect(plan2.transactional.length).toBe(0);
    });

    test("should handle VARCHAR length change with same default correctly", async () => {
      const initialSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          status VARCHAR(50) DEFAULT 'pending'
        );
      `;

      await service.apply(initialSchema, ['public'], true);

      // Change length but keep same default
      const modifiedSchema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          status VARCHAR(100) DEFAULT 'pending'
        );
      `;

      const plan = await service.plan(modifiedSchema);

      // Should only change type, not default
      expect(plan.transactional.length).toBe(1);
      expect(plan.transactional[0]).toContain('ALTER COLUMN "status" TYPE VARCHAR(100)');
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
      expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);
    });
  });

  describe("Bug 2: Non-idempotent type changes (int vs INTEGER)", () => {
    /**
     * Bug Description:
     * Converting age INTEGER DEFAULT 25 to age int (no default) would
     * repeatedly show both DROP DEFAULT and ALTER TYPE, even after being applied.
     *
     * Root Cause:
     * PostgreSQL treats INT and INTEGER as the same type, but normalizeType()
     * was uppercasing them without recognizing the equivalence (INT ≠ INTEGER).
     *
     * Fix:
     * Updated src/core/schema/parser/schema-parser.ts line 197:
     * - Added type aliases to normalization map: int → INTEGER, int2 → SMALLINT, etc.
     * - Changed to lowercase-first comparison for case-insensitive matching
     */

    test("should NOT show repeated changes for int vs INTEGER with default", async () => {
      // Start with INTEGER DEFAULT 25
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age INTEGER DEFAULT 25
        );
      `;

      await service.apply(initialSchema, ['public'], true);

      // Change to lowercase 'int' with no default
      const modifiedSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          age int
        );
      `;

      const plan1 = await service.plan(modifiedSchema);

      // Should only DROP DEFAULT (types are equivalent)
      expect(plan1.hasChanges).toBe(true);
      expect(plan1.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(true);
      expect(plan1.transactional.some(s => s.includes("ALTER COLUMN age TYPE"))).toBe(false);

      // Apply the change
      await service.apply(modifiedSchema, ['public'], true);

      // CRITICAL: Second plan should show NO changes (bug was here)
      const plan2 = await service.plan(modifiedSchema);

      expect(plan2.hasChanges).toBe(false);
      expect(plan2.transactional.length).toBe(0);
      expect(plan2.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
      expect(plan2.transactional.some(s => s.includes("ALTER COLUMN age TYPE"))).toBe(false);

      // Third apply should still show no changes
      await service.apply(modifiedSchema, ['public'], true);

      const plan3 = await service.plan(modifiedSchema);
      expect(plan3.hasChanges).toBe(false);
    });

    test("should treat int and INTEGER as identical types", async () => {
      // Create with lowercase 'int'
      const schema1 = `
        CREATE TABLE counters (
          id SERIAL PRIMARY KEY,
          count int DEFAULT 0
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Switch to uppercase 'INTEGER' (should be no-op)
      const schema2 = `
        CREATE TABLE counters (
          id SERIAL PRIMARY KEY,
          count INTEGER DEFAULT 0
        );
      `;

      const plan = await service.plan(schema2);

      // CRITICAL: Should detect NO changes
      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
    });

    test("should handle all integer type aliases correctly", async () => {
      const schema1 = `
        CREATE TABLE aliases (
          id SERIAL PRIMARY KEY,
          small_val int2,
          medium_val int,
          big_val int8
        );
      `;

      await service.apply(schema1, ['public'], true);

      // Switch to standard names
      const schema2 = `
        CREATE TABLE aliases (
          id SERIAL PRIMARY KEY,
          small_val SMALLINT,
          medium_val INTEGER,
          big_val BIGINT
        );
      `;

      const plan = await service.plan(schema2);

      // All aliases should be recognized as equivalent
      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional.length).toBe(0);
    });
  });

  describe("Combined Bug Scenario", () => {
    /**
     * This test combines both bugs:
     * 1. Type change with unchanged default
     * 2. Type alias equivalence
     */

    test("should handle TEXT to VARCHAR with int column correctly", async () => {
      const initialSchema = `
        CREATE TABLE mixed (
          id SERIAL PRIMARY KEY,
          name TEXT DEFAULT 'user',
          age int DEFAULT 25
        );
      `;

      await service.apply(initialSchema, ['public'], true);

      // Change TEXT to VARCHAR, int to INTEGER (both keep defaults)
      const modifiedSchema = `
        CREATE TABLE mixed (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) DEFAULT 'user',
          age INTEGER DEFAULT 25
        );
      `;

      const plan = await service.plan(modifiedSchema);

      // Should only change TEXT to VARCHAR (1 statement)
      // int -> INTEGER should be no-op
      expect(plan.hasChanges).toBe(true);
      expect(plan.transactional.length).toBe(1);
      expect(plan.transactional[0]).toContain('ALTER COLUMN "name" TYPE VARCHAR(255)');

      // Should NOT drop/set defaults for either column
      expect(plan.transactional.some(s => s.includes("DROP DEFAULT"))).toBe(false);
      expect(plan.transactional.some(s => s.includes("SET DEFAULT"))).toBe(false);

      // Apply and verify idempotency
      await service.apply(modifiedSchema, ['public'], true);

      const plan2 = await service.plan(modifiedSchema);
      expect(plan2.hasChanges).toBe(false);
      expect(plan2.transactional.length).toBe(0);
    });

    test("should handle data preservation through both bug scenarios", async () => {
      const initialSchema = `
        CREATE TABLE data_test (
          id SERIAL PRIMARY KEY,
          description TEXT DEFAULT 'no description',
          count int DEFAULT 0
        );
      `;

      await service.apply(initialSchema, ['public'], true);

      // Insert test data
      await client.query(`
        INSERT INTO data_test (description, count) VALUES
          ('first', 10),
          (DEFAULT, DEFAULT),
          ('third', 30)
      `);

      // Change types
      const modifiedSchema = `
        CREATE TABLE data_test (
          id SERIAL PRIMARY KEY,
          description VARCHAR(500) DEFAULT 'no description',
          count INTEGER DEFAULT 0
        );
      `;

      await service.apply(modifiedSchema, ['public'], true);

      // Verify data preserved
      const result = await client.query("SELECT * FROM data_test ORDER BY id");
      expect(result.rows.length).toBe(3);
      expect(result.rows[0].description).toBe("first");
      expect(result.rows[0].count).toBe(10);
      expect(result.rows[1].description).toBe("no description");
      expect(result.rows[1].count).toBe(0);
      expect(result.rows[2].description).toBe("third");
      expect(result.rows[2].count).toBe(30);

      // Verify defaults still work
      await client.query("INSERT INTO data_test (id) VALUES (DEFAULT)");
      const newRow = await client.query("SELECT * FROM data_test WHERE id = 4");
      expect(newRow.rows[0].description).toBe("no description");
      expect(newRow.rows[0].count).toBe(0);
    });
  });

  describe("Edge Cases That Could Regress", () => {
    test("should handle multiple type changes with various default scenarios", async () => {
      const initialSchema = `
        CREATE TABLE complex (
          id SERIAL PRIMARY KEY,
          col1 TEXT DEFAULT 'keep',
          col2 int DEFAULT 100,
          col3 VARCHAR(50) DEFAULT 'change',
          col4 INTEGER
        );
      `;

      await service.apply(initialSchema, ['public'], true);

      const modifiedSchema = `
        CREATE TABLE complex (
          id SERIAL PRIMARY KEY,
          col1 VARCHAR(255) DEFAULT 'keep',
          col2 INTEGER DEFAULT 100,
          col3 TEXT DEFAULT 'changed',
          col4 int DEFAULT 50
        );
      `;

      const plan = await service.plan(modifiedSchema);

      expect(plan.hasChanges).toBe(true);

      // With batching, all operations are in a single ALTER TABLE statement
      expect(plan.transactional.length).toBe(1);
      const statement = plan.transactional[0];

      // col1: TEXT -> VARCHAR, same default -> only type change, no default ops for col1
      expect(statement).toContain('ALTER COLUMN "col1" TYPE VARCHAR(255)');
      expect(statement).not.toMatch(/col1.*DROP DEFAULT/);
      expect(statement).not.toMatch(/col1.*SET DEFAULT/);

      // col2: int -> INTEGER, same default -> no operations at all for col2
      expect(statement).not.toContain('"col2"');

      // col3: VARCHAR -> TEXT, different default -> type change + default change
      expect(statement).toContain('ALTER COLUMN "col3" TYPE TEXT');
      expect(statement).toContain('ALTER COLUMN "col3" SET DEFAULT \'changed\'');

      // col4: INTEGER -> int (equiv), add default -> only add default, no type change for col4
      expect(statement).toContain('ALTER COLUMN "col4" SET DEFAULT 50');
      expect(statement).not.toMatch(/col4.*TYPE/);
    });

    test("should remain idempotent through multiple alternating applies", async () => {
      const schema1 = `
        CREATE TABLE alternating (
          id SERIAL PRIMARY KEY,
          value TEXT DEFAULT 'test'
        );
      `;

      const schema2 = `
        CREATE TABLE alternating (
          id SERIAL PRIMARY KEY,
          value VARCHAR(255) DEFAULT 'test'
        );
      `;

      // Apply schema1
      await service.apply(schema1, ['public'], true);

      // Switch to schema2
      await service.apply(schema2, ['public'], true);
      let plan = await service.plan(schema2);
      expect(plan.hasChanges).toBe(false);

      // Back to schema1
      await service.apply(schema1, ['public'], true);
      plan = await service.plan(schema1);
      expect(plan.hasChanges).toBe(false);

      // To schema2 again
      await service.apply(schema2, ['public'], true);
      plan = await service.plan(schema2);
      expect(plan.hasChanges).toBe(false);
    });
  });
});
