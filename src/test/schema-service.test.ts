import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../core/schema/service";
import { StrictModeError } from "../types/errors";
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
    await client?.end();
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

    test("should treat lowercase single-line sql as schema input", async () => {
      const schema =
        "create table lower_case_schema_input (id serial primary key, name text)";

      await schemaService.apply(schema, ["public"], true);

      const tables = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'lower_case_schema_input'
      `);

      expect(tables.rows).toHaveLength(1);
      expect(tables.rows[0].table_name).toBe("lower_case_schema_input");
    });

    test("should keep missing sql file as file error", async () => {
      await expect(
        schemaService.apply("missing-core-schema.sql", ["public"], true)
      ).rejects.toThrow("ENOENT");
    });
  });

  describe("Transactional rollback integration", () => {
    test("should rollback all statements when a later statement fails", async () => {
      await expect(
        schemaService.apply(
          `
            CREATE TABLE tx_rollback_ok (
              id SERIAL PRIMARY KEY
            );

            CREATE TABLE tx_rollback_fail (
              id SERIAL PRIMARY KEY,
              user_id INTEGER REFERENCES tx_rollback_missing(id)
            );
          `,
          ["public"],
          true
        )
      ).rejects.toThrow();

      const tables = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('tx_rollback_ok', 'tx_rollback_fail')
      `);

      expect(tables.rows).toEqual([]);
    });

    test("should not execute concurrent statements when transactional execution fails", async () => {
      await schemaService.apply(
        `
          CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            email TEXT
          );
        `,
        ["public"],
        true
      );

      await client.query(`
        INSERT INTO users (id, email)
        VALUES (1, 'not-a-number')
      `);

      await expect(
        schemaService.apply(
          `
            CREATE TABLE users (
              id SERIAL PRIMARY KEY,
              email INTEGER
            );

            CREATE INDEX CONCURRENTLY idx_users_email_concurrent
            ON users (email);
          `,
          ["public"],
          true
        )
      ).rejects.toThrow();

      const indexes = await client.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_users_email_concurrent'
      `);

      const columns = await client.query(`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'email'
      `);

      expect(indexes.rows).toEqual([]);
      expect(columns.rows).toEqual([{ data_type: "text" }]);
    });

    test("should release advisory lock after mixed transactional failure before concurrent execution", async () => {
      const lockName = "schema-service-mixed-failure-lock-release";

      await schemaService.apply(
        `
          CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            email TEXT
          );
        `,
        ["public"],
        true
      );

      await client.query(`
        INSERT INTO users (id, email)
        VALUES (1, 'not-a-number')
      `);

      await expect(
        schemaService.apply(
          `
            CREATE TABLE users (
              id SERIAL PRIMARY KEY,
              email INTEGER
            );

            CREATE INDEX CONCURRENTLY idx_users_email_lock_release
            ON users (email);
          `,
          ["public"],
          true,
          {
            lockName,
            lockTimeout: 500,
          }
        )
      ).rejects.toThrow();

      const probeClient = await createTestClient();
      const probeLock = await probeClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked",
        [lockName]
      );
      expect(probeLock.rows[0].locked).toBe(true);
      await probeClient.query(
        "SELECT pg_advisory_unlock(hashtext($1)::bigint)",
        [lockName]
      );
      await probeClient.end();

      const indexes = await client.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_users_email_lock_release'
      `);

      expect(indexes.rows).toEqual([]);
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
      await client.query("DROP SCHEMA IF EXISTS ext_schema CASCADE");
      await client.query("CREATE SCHEMA ext_schema");
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

      await client.query("DROP TABLE IF EXISTS fk_test_posts CASCADE");
      await client.query("DROP SCHEMA IF EXISTS ext_schema CASCADE");
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

    test("should not create schema when all its objects are unmanaged", async () => {
      await client.query("DROP SCHEMA IF EXISTS finance CASCADE");

      const schema = `
        CREATE SCHEMA IF NOT EXISTS finance;

        CREATE TABLE finance.transactions (
          id SERIAL PRIMARY KEY,
          amount DECIMAL
        );

        CREATE TABLE public.users (
          id SERIAL PRIMARY KEY
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      const schemaResult = await client.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'finance'
      `);

      expect(schemaResult.rows).toHaveLength(0);

      const tableResult = await client.query(`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_name IN ('transactions', 'users')
        AND table_schema IN ('public', 'finance')
      `);

      expect(tableResult.rows).toHaveLength(1);
      expect(tableResult.rows[0].table_name).toBe('users');
      expect(tableResult.rows[0].table_schema).toBe('public');

      await client.query("DROP SCHEMA IF EXISTS finance CASCADE");
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

    test("should handle same table name across managed schemas", async () => {
      await cleanDatabase(client, ["public", "tenant_a"]);
      await client.query("CREATE SCHEMA IF NOT EXISTS tenant_a");

      const initialSchema = `
        CREATE TABLE public.users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );

        CREATE TABLE tenant_a.users (
          id SERIAL PRIMARY KEY,
          display_name VARCHAR(255) NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ["public", "tenant_a"], true);

      const desiredSchema = `
        CREATE TABLE public.users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );
      `;

      await schemaService.apply(desiredSchema, ["public", "tenant_a"], true);

      const publicUsers = await client.query(`
        SELECT COUNT(*)::text AS count
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'users'
      `);
      const tenantUsers = await client.query(`
        SELECT COUNT(*)::text AS count
        FROM information_schema.tables
        WHERE table_schema = 'tenant_a'
          AND table_name = 'users'
      `);

      expect(publicUsers.rows[0].count).toBe("1");
      expect(tenantUsers.rows[0].count).toBe("0");

      await cleanDatabase(client, ["public", "tenant_a"]);
    });

    test("should remove only tenant same-name sequence procedure and view across managed schemas", async () => {
      await cleanDatabase(client, ["public", "tenant_a"]);
      await client.query("CREATE SCHEMA IF NOT EXISTS tenant_a");

      const initialSchema = `
        CREATE TABLE public.shared_base (
          id SERIAL PRIMARY KEY
        );

        CREATE TABLE tenant_a.shared_base (
          id SERIAL PRIMARY KEY
        );

        CREATE SEQUENCE public.shared_seq START WITH 1;
        CREATE SEQUENCE tenant_a.shared_seq START WITH 10;

        CREATE PROCEDURE public.shared_proc()
        LANGUAGE SQL
        AS $$ SELECT 1; $$;

        CREATE PROCEDURE tenant_a.shared_proc()
        LANGUAGE SQL
        AS $$ SELECT 2; $$;

        CREATE VIEW public.shared_view AS
        SELECT id FROM public.shared_base;

        CREATE VIEW tenant_a.shared_view AS
        SELECT id FROM tenant_a.shared_base;
      `;

      await schemaService.apply(initialSchema, ["public", "tenant_a"], true);

      const desiredSchema = `
        CREATE TABLE public.shared_base (
          id SERIAL PRIMARY KEY
        );

        CREATE TABLE tenant_a.shared_base (
          id SERIAL PRIMARY KEY
        );

        CREATE SEQUENCE public.shared_seq START WITH 1;

        CREATE PROCEDURE public.shared_proc()
        LANGUAGE SQL
        AS $$ SELECT 1; $$;

        CREATE VIEW public.shared_view AS
        SELECT id FROM public.shared_base;
      `;

      const dryRunPlan = await schemaService.apply(
        desiredSchema,
        ["public", "tenant_a"],
        true,
        undefined,
        true
      );
      const dryRunSql = dryRunPlan.transactional.join("\n");

      expect(dryRunSql).toContain('DROP SEQUENCE IF EXISTS "tenant_a"."shared_seq";');
      expect(dryRunSql).toContain('DROP PROCEDURE IF EXISTS "tenant_a"."shared_proc"();');
      expect(dryRunSql).toContain('DROP VIEW IF EXISTS "tenant_a"."shared_view";');
      expect(dryRunSql).not.toContain('DROP SEQUENCE IF EXISTS "public"."shared_seq";');
      expect(dryRunSql).not.toContain('DROP PROCEDURE IF EXISTS "public"."shared_proc"();');
      expect(dryRunSql).not.toContain('DROP VIEW IF EXISTS "public"."shared_view";');

      await schemaService.apply(desiredSchema, ["public", "tenant_a"], true);

      const sequences = await client.query(`
        SELECT sequence_schema, sequence_name
        FROM information_schema.sequences
        WHERE sequence_name = 'shared_seq'
          AND sequence_schema IN ('public', 'tenant_a')
        ORDER BY sequence_schema
      `);
      const procedures = await client.query(`
        SELECT routine_schema, routine_name
        FROM information_schema.routines
        WHERE routine_type = 'PROCEDURE'
          AND routine_name = 'shared_proc'
          AND routine_schema IN ('public', 'tenant_a')
        ORDER BY routine_schema
      `);
      const views = await client.query(`
        SELECT table_schema, table_name
        FROM information_schema.views
        WHERE table_name = 'shared_view'
          AND table_schema IN ('public', 'tenant_a')
        ORDER BY table_schema
      `);

      expect(sequences.rows).toEqual([{ sequence_schema: "public", sequence_name: "shared_seq" }]);
      expect(procedures.rows).toEqual([{ routine_schema: "public", routine_name: "shared_proc" }]);
      expect(views.rows).toEqual([{ table_schema: "public", table_name: "shared_view" }]);

      const idempotentPlan = await schemaService.apply(
        desiredSchema,
        ["public", "tenant_a"],
        true,
        undefined,
        true
      );
      expect(idempotentPlan.hasChanges).toBe(false);

      await cleanDatabase(client, ["public", "tenant_a"]);
    });

    test("should keep quoted local-schema view references idempotent in public and tenant schemas", async () => {
      await cleanDatabase(client, ["public", "tenant_a"]);
      await client.query("CREATE SCHEMA IF NOT EXISTS tenant_a");

      const schema = `
        CREATE TABLE public.shared_base (
          id SERIAL PRIMARY KEY
        );

        CREATE TABLE tenant_a.shared_base (
          id SERIAL PRIMARY KEY
        );

        CREATE VIEW public.shared_view AS
        SELECT id FROM "public"."shared_base";

        CREATE VIEW tenant_a.shared_view AS
        SELECT id FROM "tenant_a"."shared_base";
      `;

      await schemaService.apply(schema, ["public", "tenant_a"], true);
      const idempotentPlan = await schemaService.apply(
        schema,
        ["public", "tenant_a"],
        true,
        undefined,
        true
      );

      expect(idempotentPlan.hasChanges).toBe(false);
      expect(idempotentPlan.transactional).toEqual([]);

      await cleanDatabase(client, ["public", "tenant_a"]);
    });

    test("should keep postgres-canonicalized views idempotent on reapply", async () => {
      await cleanDatabase(client, ["public"]);

      const schema = `
        CREATE TABLE people (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          changes JSONB NOT NULL DEFAULT '[]'::jsonb
        );

        CREATE VIEW people_all AS
        SELECT
          people.*,
          lower(name) AS normalized_name
        FROM people;

        CREATE VIEW people_updates AS
        SELECT
          p.id,
          EXISTS (
            SELECT
              1
            FROM
              jsonb_array_elements(p.changes) AS change
            WHERE
              change ->> 'fieldName' = 'email'
          ) AS has_email_change
        FROM people AS p;
      `;

      await schemaService.apply(schema, ["public"], true);
      const idempotentPlan = await schemaService.apply(
        schema,
        ["public"],
        true,
        undefined,
        true
      );

      expect(idempotentPlan.hasChanges).toBe(false);
      expect(idempotentPlan.transactional).toEqual([]);

      await cleanDatabase(client, ["public"]);
    });
  });

  describe("Strict mode integration", () => {
    test("should block destructive changes in strict mode even during dry run", async () => {
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ["public"], true);

      await expect(
        schemaService.apply("", ["public"], true, undefined, true, true)
      ).rejects.toBeInstanceOf(StrictModeError);

      const tables = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'users'
      `);

      expect(tables.rows).toHaveLength(1);
    });

    test("should release advisory lock when strict mode rejects destructive apply", async function () {
      const lockName = "schema-service-strict-lock-release";
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ["public"], true);

      await expect(
        schemaService.apply(
          "",
          ["public"],
          true,
          {
            lockName,
            lockTimeout: 500,
          },
          false,
          true
        )
      ).rejects.toBeInstanceOf(StrictModeError);

      const probeClient = await createTestClient();
      const probeLock = await probeClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked",
        [lockName]
      );
      expect(probeLock.rows[0].locked).toBe(true);
      await probeClient.query(
        "SELECT pg_advisory_unlock(hashtext($1)::bigint)",
        [lockName]
      );
      await probeClient.end();
    });

    test("should allow additive changes in strict mode", async () => {
      const initialSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY
        );
      `;

      const updatedSchema = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        );
      `;

      await schemaService.apply(initialSchema, ["public"], true);
      await schemaService.apply(updatedSchema, ["public"], true, undefined, false, true);

      const columns = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
        ORDER BY ordinal_position
      `);

      expect(columns.rows.map(function (row) { return row.column_name; })).toEqual(["id", "email"]);
    });

    test("should allow enum create and enum value append in strict mode", async () => {
      const initialSchema = `
        CREATE TYPE mood AS ENUM ('sad');

        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          state mood NOT NULL DEFAULT 'sad'
        );
      `;

      const updatedSchema = `
        CREATE TYPE mood AS ENUM ('sad', 'happy');

        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          state mood NOT NULL DEFAULT 'sad'
        );
      `;

      await schemaService.apply(initialSchema, ["public"], true, undefined, false, true);
      await schemaService.apply(updatedSchema, ["public"], true, undefined, false, true);

      const enumValues = await client.query(`
        SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'mood'
        ORDER BY e.enumsortorder
      `);

      expect(enumValues.rows.map(function (row) { return row.enumlabel; })).toEqual(["sad", "happy"]);
    });
  });

  describe("Advisory lock integration", () => {
    test("should fail on lock timeout when advisory lock is held", async () => {
      const lockName = "schema-service-integration-lock-timeout";
      const lockClient = await createTestClient();

      try {
        await lockClient.query(
          "SELECT pg_advisory_lock(hashtext($1)::bigint)",
          [lockName]
        );

        await expect(
          schemaService.apply(
            `
              CREATE TABLE lock_timeout_test (
                id SERIAL PRIMARY KEY
              );
            `,
            ["public"],
            true,
            {
              lockName,
              lockTimeout: 300,
            }
          )
        ).rejects.toThrow("Failed to acquire advisory lock");
      } finally {
        await lockClient.query(
          "SELECT pg_advisory_unlock(hashtext($1)::bigint)",
          [lockName]
        );
        await lockClient.end();
      }
    });

    test("should apply successfully after advisory lock is released", async () => {
      const lockName = "schema-service-integration-lock-release";
      const lockClient = await createTestClient();

      await lockClient.query(
        "SELECT pg_advisory_lock(hashtext($1)::bigint)",
        [lockName]
      );
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtext($1)::bigint)",
        [lockName]
      );
      await lockClient.end();

      await schemaService.apply(
        `
          CREATE TABLE lock_release_test (
            id SERIAL PRIMARY KEY
          );
        `,
        ["public"],
        true,
        {
          lockName,
          lockTimeout: 1000,
        }
      );

      const tables = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'lock_release_test'
      `);

      expect(tables.rows).toHaveLength(1);
    });

    test("should release advisory lock after failed apply and allow retry", async () => {
      const lockName = "schema-service-integration-lock-recovery";

      await expect(
        schemaService.apply(
          `
            CREATE TABLE lock_recovery_test (
              id SERIAL PRIMARY KEY,
              id INTEGER
            );
          `,
          ["public"],
          true,
          {
            lockName,
            lockTimeout: 500,
          }
        )
      ).rejects.toThrow();

      const probeClient = await createTestClient();
      const probeLock = await probeClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked",
        [lockName]
      );
      expect(probeLock.rows[0].locked).toBe(true);
      await probeClient.query(
        "SELECT pg_advisory_unlock(hashtext($1)::bigint)",
        [lockName]
      );
      await probeClient.end();

      await schemaService.apply(
        `
          CREATE TABLE lock_recovery_test (
            id SERIAL PRIMARY KEY
          );
        `,
        ["public"],
        true,
        {
          lockName,
          lockTimeout: 500,
        }
      );

      const tables = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'lock_recovery_test'
      `);
      expect(tables.rows).toHaveLength(1);
    });

    test("should release advisory lock when schema parsing fails", async function () {
      const lockName = "schema-service-integration-lock-parse-failure";

      await expect(
        schemaService.apply(
          `
            CREATE TABLE lock_parse_failure_test (
              id SERIAL PRIMARY KEY,
              broken ???
            );
          `,
          ["public"],
          true,
          {
            lockName,
            lockTimeout: 500,
          }
        )
      ).rejects.toThrow();

      const probeClient = await createTestClient();
      const probeLock = await probeClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked",
        [lockName]
      );
      expect(probeLock.rows[0].locked).toBe(true);
      await probeClient.query(
        "SELECT pg_advisory_unlock(hashtext($1)::bigint)",
        [lockName]
      );
      await probeClient.end();
    });
  });
});
