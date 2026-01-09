import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "./utils";

describe("SchemaService - MigrationPlanner Removal", () => {
  let client: Client;
  let schemaService: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    
    schemaService = createTestSchemaService();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("plan() method", () => {
    test("should generate migration plan using SchemaDiffer directly", async () => {
      // Create initial schema
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Define desired schema with changes
      const desiredSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(255) NOT NULL
        );

        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          title VARCHAR(200) NOT NULL,
          user_id INTEGER,
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `;

      // Generate plan
      const plan = await schemaService.plan(desiredSchema);

      // Verify plan has changes
      expect(plan.hasChanges).toBe(true);
      expect(plan.transactional.length).toBeGreaterThan(0);

      // Check that it includes adding email column
      const hasEmailColumn = plan.transactional.some(stmt =>
        stmt.includes('ADD COLUMN "email"')
      );
      expect(hasEmailColumn).toBe(true);

      // Check that it includes creating posts table (quoted)
      const hasPostsTable = plan.transactional.some(stmt =>
        stmt.includes('CREATE TABLE "posts"')
      );
      expect(hasPostsTable).toBe(true);
    });

    test("should return no changes when schema is up to date", async () => {
      const schema = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description TEXT
        );
      `;

      // Apply schema
      await schemaService.apply(schema, ['public'], true);

      // Plan with same schema
      const plan = await schemaService.plan(schema);

      // Note: DECIMAL/NUMERIC type normalization is a known issue
      // For this test, use simple types that don't have normalization problems
      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional).toHaveLength(0);
      expect(plan.concurrent).toHaveLength(0);
    });

    test("should handle table drops in migration plan", async () => {
      // Create initial schema with two tables
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        CREATE TABLE temp_data (
          id SERIAL PRIMARY KEY,
          data TEXT
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Desired schema removes temp_data
      const desiredSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      const plan = await schemaService.plan(desiredSchema);

      expect(plan.hasChanges).toBe(true);

      // Should include DROP TABLE statement (may include schema prefix and CASCADE)
      const hasDropTable = plan.transactional.some(stmt =>
        stmt.toUpperCase().includes("DROP TABLE") && stmt.includes("temp_data")
      );
      expect(hasDropTable).toBe(true);
    });
  });

  describe("apply() method", () => {
    test("should apply schema changes using SchemaDiffer directly", async () => {
      const schema = `
        CREATE TABLE categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify table was created
      const tables = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'categories'
      `);

      expect(tables.rows).toHaveLength(1);
      expect(tables.rows[0].table_name).toBe("categories");

      // Verify columns
      const columns = await client.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'categories'
        ORDER BY ordinal_position
      `);

      expect(columns.rows).toHaveLength(2);
      expect(columns.rows[0].column_name).toBe("id");
      expect(columns.rows[1].column_name).toBe("name");
      expect(columns.rows[1].is_nullable).toBe("NO");
    });

    test("should handle multiple schema changes in sequence", async () => {
      // Step 1: Create initial table
      const schema1 = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          total DECIMAL(10,2) NOT NULL
        );
      `;

      await schemaService.apply(schema1, ['public'], true);

      // Step 2: Add column
      const schema2 = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          total DECIMAL(10,2) NOT NULL,
          status VARCHAR(20)
        );
      `;

      await schemaService.apply(schema2, ['public'], true);

      // Step 3: Add another table with foreign key
      const schema3 = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          total DECIMAL(10,2) NOT NULL,
          status VARCHAR(20)
        );

        CREATE TABLE order_items (
          id SERIAL PRIMARY KEY,
          order_id INTEGER,
          quantity INTEGER NOT NULL,
          CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders(id)
        );
      `;

      await schemaService.apply(schema3, ['public'], true);

      // Verify final state
      const tables = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      const tableNames = tables.rows.map(r => r.table_name);
      expect(tableNames).toContain("orders");
      expect(tableNames).toContain("order_items");

      // Verify foreign key constraint exists
      const constraints = await client.query(`
        SELECT constraint_name, constraint_type
        FROM information_schema.table_constraints
        WHERE table_name = 'order_items'
        AND constraint_type = 'FOREIGN KEY'
      `);

      expect(constraints.rows).toHaveLength(1);
    });

    test("should apply schema from empty database", async () => {
      // Start with clean database
      const schema = `
        CREATE TABLE companies (
          id SERIAL PRIMARY KEY,
          name VARCHAR(200) NOT NULL,
          founded_year INTEGER
        );

        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          company_id INTEGER,
          name VARCHAR(100) NOT NULL,
          CONSTRAINT fk_company FOREIGN KEY (company_id) REFERENCES companies(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify both tables exist
      const tables = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      const tableNames = tables.rows.map(r => r.table_name);
      expect(tableNames).toContain("companies");
      expect(tableNames).toContain("employees");
    });
  });

  describe("Unmanaged schema filtering", () => {
    test("should ignore tables from unmanaged schemas", async () => {
      await client.query("CREATE SCHEMA IF NOT EXISTS other_schema");

      const schema = `
        CREATE TABLE public.filter_test_users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100)
        );
        CREATE TABLE other_schema.filter_test_data (
          id SERIAL PRIMARY KEY,
          value TEXT
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      const result = await client.query(`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_name IN ('filter_test_users', 'filter_test_data')
        AND table_schema IN ('public', 'other_schema')
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].table_name).toBe('filter_test_users');
      expect(result.rows[0].table_schema).toBe('public');

      await client.query("DROP SCHEMA IF EXISTS other_schema CASCADE");
    });

    test("should preserve FKs referencing external schemas", async () => {
      await client.query("CREATE SCHEMA IF NOT EXISTS ext_schema");
      await client.query(`
        CREATE TABLE ext_schema.ext_users (id SERIAL PRIMARY KEY)
      `);

      const schema = `
        CREATE TABLE fk_test_posts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES ext_schema.ext_users(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      const fks = await client.query(`
        SELECT
          ccu.table_schema as ref_schema,
          ccu.table_name as ref_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'fk_test_posts'
          AND tc.constraint_type = 'FOREIGN KEY'
      `);

      expect(fks.rows).toHaveLength(1);
      expect(fks.rows[0].ref_schema).toBe('ext_schema');

      await client.query("DROP TABLE fk_test_posts CASCADE");
      await client.query("DROP SCHEMA ext_schema CASCADE");
    });

    test("should ignore views from unmanaged schemas", async () => {
      await client.query("CREATE SCHEMA IF NOT EXISTS view_test_schema");

      const schema = `
        CREATE TABLE public.view_test_users (id SERIAL PRIMARY KEY);
        CREATE VIEW view_test_schema.ignored_view AS SELECT * FROM public.view_test_users;
      `;

      await schemaService.apply(schema, ['public'], true);

      const views = await client.query(`
        SELECT table_schema, table_name
        FROM information_schema.views
        WHERE table_name = 'ignored_view'
      `);

      expect(views.rows).toHaveLength(0);

      await client.query("DROP SCHEMA IF EXISTS view_test_schema CASCADE");
    });
  });

  describe("Integration with SchemaDiffer", () => {
    test("should correctly diff complex schema changes", async () => {
      // Initial schema
      const initialSchema = `
        CREATE TABLE authors (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          bio TEXT
        );

        CREATE TABLE books (
          id SERIAL PRIMARY KEY,
          author_id INTEGER,
          title VARCHAR(200) NOT NULL,
          published_year INTEGER,
          CONSTRAINT fk_author FOREIGN KEY (author_id) REFERENCES authors(id)
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Modified schema - remove bio, add email, change books structure
      const modifiedSchema = `
        CREATE TABLE authors (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(255)
        );

        CREATE TABLE books (
          id SERIAL PRIMARY KEY,
          author_id INTEGER,
          title VARCHAR(200) NOT NULL,
          published_year INTEGER,
          isbn VARCHAR(20),
          CONSTRAINT fk_author FOREIGN KEY (author_id) REFERENCES authors(id)
        );
      `;

      const plan = await schemaService.plan(modifiedSchema);

      expect(plan.hasChanges).toBe(true);

      // Check for expected changes
      const hasBioRemoval = plan.transactional.some(stmt =>
        stmt.includes('DROP COLUMN "bio"')
      );
      const hasEmailAddition = plan.transactional.some(stmt =>
        stmt.includes('ADD COLUMN "email"')
      );
      const hasIsbnAddition = plan.transactional.some(stmt =>
        stmt.includes('ADD COLUMN "isbn"')
      );

      expect(hasBioRemoval).toBe(true);
      expect(hasEmailAddition).toBe(true);
      expect(hasIsbnAddition).toBe(true);
    });
  });
});
