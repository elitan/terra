import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

/**
 * Tests for distinguishing between UNIQUE constraints and UNIQUE indexes.
 *
 * Key distinction in PostgreSQL:
 * - UNIQUE constraints: Created via ALTER TABLE ADD CONSTRAINT UNIQUE
 *   - Used for data integrity
 *   - Can be batched with other ALTER TABLE operations
 *   - Represented in information_schema.table_constraints
 *
 * - UNIQUE indexes: Created via CREATE UNIQUE INDEX [CONCURRENTLY]
 *   - Used for performance optimization
 *   - Can be created concurrently without blocking writes
 *   - NOT represented in information_schema.table_constraints
 *
 * This distinction enables:
 * - Safe concurrent index creation on production
 * - Efficient migrations via batching
 * - Proper PostgreSQL semantics
 */
describe("UNIQUE Constraints vs UNIQUE Indexes", () => {
  let client: Client;
  let schemaService: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    
    schemaService = createTestSchemaService();
  });

  afterEach(async () => {
    await client.end();
  });

  describe("Constraint Creation and Handling", () => {
    test("should create UNIQUE constraint (not index) from table definition", async () => {
      const schema = `
        CREATE TABLE uc_users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          username VARCHAR(50) NOT NULL,
          CONSTRAINT unique_email UNIQUE (email)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify it's created as a constraint, not a standalone index
      const constraints = await client.query(`
        SELECT constraint_name, constraint_type
        FROM information_schema.table_constraints
        WHERE table_name = 'uc_users'
          AND table_schema = 'public'
          AND constraint_type = 'UNIQUE'
      `);

      expect(constraints.rows).toHaveLength(1);
      expect(constraints.rows[0].constraint_name).toBe('unique_email');
      expect(constraints.rows[0].constraint_type).toBe('UNIQUE');

      // Verify the backing index exists (constraints create indexes)
      const indexes = await client.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'uc_users'
          AND schemaname = 'public'
          AND indexname = 'unique_email'
      `);

      expect(indexes.rows).toHaveLength(1);
    });

    test("should create standalone UNIQUE index from CREATE INDEX statement", async () => {
      const schema = `
        CREATE TABLE uc_products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL,
          name VARCHAR(100) NOT NULL
        );

        CREATE UNIQUE INDEX unique_sku_idx ON uc_products (sku);
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify it's created as an index, NOT a constraint
      const constraints = await client.query(`
        SELECT COUNT(*) as count
        FROM information_schema.table_constraints
        WHERE table_name = 'uc_products'
          AND table_schema = 'public'
          AND constraint_type = 'UNIQUE'
      `);

      expect(constraints.rows[0].count).toBe('0');

      // Verify the index exists
      const indexes = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'uc_products'
          AND schemaname = 'public'
          AND indexname = 'unique_sku_idx'
      `);

      expect(indexes.rows).toHaveLength(1);
      expect(indexes.rows[0].indexdef).toContain('UNIQUE');
    });

    test("should handle both constraints and indexes in same table", async () => {
      const schema = `
        CREATE TABLE uc_orders (
          id SERIAL PRIMARY KEY,
          order_number VARCHAR(50) NOT NULL,
          customer_email VARCHAR(255) NOT NULL,
          tracking_code VARCHAR(100),
          CONSTRAINT unique_order_number UNIQUE (order_number)
        );

        -- Partial unique index for non-null tracking codes
        CREATE UNIQUE INDEX unique_tracking_code ON uc_orders (tracking_code) WHERE tracking_code IS NOT NULL;
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify constraint
      const constraints = await client.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'uc_orders'
          AND constraint_type = 'UNIQUE'
      `);

      expect(constraints.rows).toHaveLength(1);
      expect(constraints.rows[0].constraint_name).toBe('unique_order_number');

      // Verify standalone index
      const indexes = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'uc_orders'
          AND indexname = 'unique_tracking_code'
      `);

      expect(indexes.rows).toHaveLength(1);
      expect(indexes.rows[0].indexdef).toContain('WHERE');
    });
  });

  describe("Migration and Batching", () => {
    test("should batch UNIQUE constraint with other ALTER TABLE operations", async () => {
      const initialSchema = `
        CREATE TABLE uc_users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Add multiple things including a unique constraint
      const updatedSchema = `
        CREATE TABLE uc_users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(255) NOT NULL,
          age INTEGER,
          CONSTRAINT unique_email UNIQUE (email)
        );
      `;

      // Get the migration plan
      const plan = await schemaService.plan(updatedSchema, ['public']);

      // The transactional statements should include batched ALTER TABLE
      // (constraint addition batched with column additions)
      expect(plan.transactional.length).toBeGreaterThan(0);

      // Apply the changes
      await schemaService.apply(updatedSchema, ['public'], true);

      // Verify the constraint was created (check by name)
      const result = await client.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'uc_users'
          AND constraint_type = 'UNIQUE'
          AND constraint_name = 'unique_email'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].constraint_name).toBe('unique_email');
    });

    test("should handle indexes separately from constraints (non-batched)", async () => {
      const initialSchema = `
        CREATE TABLE uc_products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          sku VARCHAR(50) NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Add an index (should be separate statement, not batched)
      const updatedSchema = `
        CREATE TABLE uc_products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          sku VARCHAR(50) NOT NULL
        );

        CREATE INDEX idx_product_name ON uc_products (name);
      `;

      const plan = await schemaService.plan(updatedSchema, ['public']);

      // Index creation should be in concurrent statements (if useConcurrentIndexes is enabled)
      // or at least separate from table alterations
      const hasIndexCreation = plan.transactional.some(stmt => stmt.includes('CREATE INDEX')) ||
                                plan.concurrent.some(stmt => stmt.includes('CREATE INDEX'));

      expect(hasIndexCreation).toBe(true);

      await schemaService.apply(updatedSchema, ['public'], true);

      // Verify index was created
      const result = await client.query(`
        SELECT COUNT(*) as count
        FROM pg_indexes
        WHERE tablename = 'uc_products'
          AND indexname = 'idx_product_name'
      `);

      expect(result.rows[0].count).toBe('1');
    });
  });

  describe("Constraint and Index Modifications", () => {
    test("should drop UNIQUE constraint using ALTER TABLE", async () => {
      const initialSchema = `
        CREATE TABLE uc_users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          CONSTRAINT unique_email UNIQUE (email)
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Verify constraint exists
      const beforeResult = await client.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'uc_users'
          AND constraint_type = 'UNIQUE'
          AND constraint_name = 'unique_email'
      `);

      expect(beforeResult.rows).toHaveLength(1);

      // Remove the constraint
      const updatedSchema = `
        CREATE TABLE uc_users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );
      `;

      const plan = await schemaService.plan(updatedSchema, ['public']);

      // Should generate ALTER TABLE DROP CONSTRAINT
      const hasDropConstraint = plan.transactional.some(stmt =>
        stmt.includes('DROP CONSTRAINT') && stmt.includes('unique_email')
      );

      expect(hasDropConstraint).toBe(true);

      await schemaService.apply(updatedSchema, ['public'], true);

      // Verify constraint was dropped (check by specific name)
      const result = await client.query(`
        SELECT COUNT(*) as count
        FROM information_schema.table_constraints
        WHERE table_name = 'uc_users'
          AND constraint_type = 'UNIQUE'
          AND constraint_name = 'unique_email'
      `);

      expect(result.rows[0].count).toBe('0');
    });

    test("should drop standalone UNIQUE index using DROP INDEX", async () => {
      const initialSchema = `
        CREATE TABLE uc_products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL
        );

        CREATE UNIQUE INDEX unique_sku_idx ON uc_products (sku);
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Remove the index
      const updatedSchema = `
        CREATE TABLE uc_products (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) NOT NULL
        );
      `;

      const plan = await schemaService.plan(updatedSchema, ['public']);

      // Should generate DROP INDEX (not DROP CONSTRAINT)
      const hasDropIndex = plan.transactional.some(stmt =>
        stmt.includes('DROP INDEX') && stmt.includes('unique_sku_idx')
      ) || plan.concurrent.some(stmt =>
        stmt.includes('DROP INDEX') && stmt.includes('unique_sku_idx')
      );

      expect(hasDropIndex).toBe(true);

      await schemaService.apply(updatedSchema, ['public'], true);

      // Verify index was dropped
      const result = await client.query(`
        SELECT COUNT(*) as count
        FROM pg_indexes
        WHERE tablename = 'uc_products'
          AND indexname = 'unique_sku_idx'
      `);

      expect(result.rows[0].count).toBe('0');
    });
  });

  describe("Use Cases: When to Use Each", () => {
    test("UNIQUE constraint: for enforcing data integrity", async () => {
      // Use UNIQUE constraint when the uniqueness is a business rule
      const schema = `
        CREATE TABLE uc_users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          username VARCHAR(50) NOT NULL,
          CONSTRAINT unique_email UNIQUE (email),
          CONSTRAINT unique_username UNIQUE (username)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // These constraints ensure data integrity at the database level
      await client.query("INSERT INTO uc_users (email, username) VALUES ('test@example.com', 'testuser')");

      await expect(
        client.query("INSERT INTO uc_users (email, username) VALUES ('test@example.com', 'otheruser')")
      ).rejects.toThrow(/unique_email/);

      await expect(
        client.query("INSERT INTO uc_users (email, username) VALUES ('other@example.com', 'testuser')")
      ).rejects.toThrow(/unique_username/);
    });

    test("UNIQUE index: for partial uniqueness and performance", async () => {
      // Use UNIQUE index when you need:
      // - Partial uniqueness (WHERE clause)
      // - Expression-based uniqueness
      // - Performance optimization that happens to be unique
      const schema = `
        CREATE TABLE uc_documents (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          status VARCHAR(20) NOT NULL,
          published_at TIMESTAMP,
          deleted_at TIMESTAMP
        );

        -- Partial unique: title must be unique only for published, non-deleted documents
        CREATE UNIQUE INDEX unique_published_title
          ON uc_documents (LOWER(title))
          WHERE status = 'published' AND deleted_at IS NULL;
      `;

      await schemaService.apply(schema, ['public'], true);

      // Can have duplicate titles for drafts
      await client.query("INSERT INTO uc_documents (title, status) VALUES ('My Document', 'draft')");
      await client.query("INSERT INTO uc_documents (title, status) VALUES ('My Document', 'draft')");

      // Can have duplicate titles for deleted documents
      await client.query("INSERT INTO uc_documents (title, status, published_at, deleted_at) VALUES ('Deleted Doc', 'published', NOW(), NOW())");
      await client.query("INSERT INTO uc_documents (title, status, published_at, deleted_at) VALUES ('Deleted Doc', 'published', NOW(), NOW())");

      // But published, non-deleted titles must be unique (case-insensitive)
      await client.query("INSERT INTO uc_documents (title, status, published_at) VALUES ('Unique Title', 'published', NOW())");

      await expect(
        client.query("INSERT INTO uc_documents (title, status, published_at) VALUES ('unique title', 'published', NOW())")
      ).rejects.toThrow(/unique_published_title/);
    });
  });

  describe("Concurrent Index Creation", () => {
    test("should support CONCURRENTLY for standalone indexes", async () => {
      const schema = `
        CREATE TABLE uc_large_table (
          id SERIAL PRIMARY KEY,
          data VARCHAR(255)
        );

        CREATE INDEX CONCURRENTLY idx_data ON uc_large_table (data);
      `;

      // This should work without issues - concurrent indexes don't block writes
      await schemaService.apply(schema, ['public'], true);

      const result = await client.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'uc_large_table'
          AND indexname = 'idx_data'
      `);

      expect(result.rows).toHaveLength(1);
    });

    test("UNIQUE constraints cannot use CONCURRENTLY (batched with ALTER TABLE)", async () => {
      // UNIQUE constraints are added via ALTER TABLE ADD CONSTRAINT
      // which cannot use CONCURRENTLY, but can be batched with other operations
      const schema = `
        CREATE TABLE uc_users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          CONSTRAINT unique_email UNIQUE (email)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify it was created as a constraint (not a concurrent index)
      const result = await client.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'uc_users'
          AND constraint_type = 'UNIQUE'
          AND constraint_name = 'unique_email'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].constraint_name).toBe('unique_email');
    });
  });
});
