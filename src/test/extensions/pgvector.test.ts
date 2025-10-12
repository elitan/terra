import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { DatabaseInspector } from "../../core/schema/inspector";

/**
 * Extension Tests - pgvector
 *
 * These tests run against a PostgreSQL instance with pgvector extension.
 * Use DATABASE_URL to point to the pgvector instance (port 5488).
 */

async function createPgvectorClient(): Promise<Client> {
  const client = new Client({
    host: "localhost",
    port: 5488, // pgvector instance
    database: "sql_terraform_test",
    user: "test_user",
    password: "test_password",
  });
  await client.connect();
  return client;
}

function createPgvectorDatabaseService(): DatabaseService {
  return new DatabaseService({
    host: "localhost",
    port: 5488,
    database: "sql_terraform_test",
    user: "test_user",
    password: "test_password",
  });
}

async function cleanDatabase(client: Client) {
  // Drop all tables in public schema
  const tables = await client.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
  `);

  for (const row of tables.rows) {
    await client.query(`DROP TABLE IF EXISTS ${row.tablename} CASCADE`);
  }

  // Drop custom types (but not extension types)
  const types = await client.query(`
    SELECT t.typname
    FROM pg_type t
    JOIN pg_namespace n ON t.typnamespace = n.oid
    LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public'
      AND t.typtype = 'e'
      AND d.objid IS NULL
  `);

  for (const row of types.rows) {
    await client.query(`DROP TYPE IF EXISTS ${row.typname} CASCADE`);
  }
}

describe("Extension Support - pgvector", () => {
  let client: Client;
  let schemaService: SchemaService;
  let inspector: DatabaseInspector;

  beforeEach(async () => {
    client = await createPgvectorClient();
    await cleanDatabase(client);
    const databaseService = createPgvectorDatabaseService();
    schemaService = new SchemaService(databaseService);
    inspector = new DatabaseInspector();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("Extension Object Filtering", () => {
    test("should not detect pgvector types as user types", async () => {
      // Install pgvector extension
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      // Verify pgvector is installed
      const extCheck = await client.query(`
        SELECT * FROM pg_extension WHERE extname = 'vector'
      `);
      expect(extCheck.rows).toHaveLength(1);

      // Check that Terra does NOT detect the vector type
      const types = await inspector.getCurrentEnums(client, ['public']);

      // Should be empty - vector type is owned by extension
      expect(types).toHaveLength(0);
    });

    test("should not try to drop pgvector types on empty schema apply", async () => {
      // Install pgvector
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      // Create a user table with vector column
      const initialSchema = `
        CREATE TABLE documents (
          id SERIAL PRIMARY KEY,
          content TEXT,
          embedding vector(3)
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      // Verify table was created
      const tables1 = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'documents'
      `);
      expect(tables1.rows).toHaveLength(1);

      // Now apply empty schema (drop all user tables)
      const emptySchema = ``;
      await schemaService.apply(emptySchema, ['public'], true);

      // Verify user table was dropped
      const tables2 = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'documents'
      `);
      expect(tables2.rows).toHaveLength(0);

      // But pgvector type should still exist
      const vectorType = await client.query(`
        SELECT typname FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE n.nspname = 'public' AND t.typname = 'vector'
      `);
      expect(vectorType.rows).toHaveLength(1);
    });

    test("should allow using pgvector types in schema", async () => {
      // Install pgvector
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      const schema = `
        CREATE TABLE embeddings (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100),
          vec vector(1536)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify table and column were created
      const result = await client.query(`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_name = 'embeddings' AND column_name = 'vec'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].udt_name).toBe('vector');
    });

    test("should not detect pgvector functions as user functions", async () => {
      // Install pgvector
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      // pgvector installs functions like vector_in, vector_out, etc.
      const pgFunctions = await client.query(`
        SELECT proname FROM pg_proc
        WHERE proname LIKE 'vector%'
        LIMIT 1
      `);
      expect(pgFunctions.rows.length).toBeGreaterThan(0);

      // But Terra should not see them
      const functions = await inspector.getCurrentFunctions(client, ['public']);

      // Filter to only vector-related functions
      const vectorFunctions = functions.filter(f => f.name.startsWith('vector'));
      expect(vectorFunctions).toHaveLength(0);
    });

    test("should handle mix of user and extension types", async () => {
      // Install pgvector
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      // Create user enum type
      const schema = `
        CREATE TYPE status AS ENUM ('pending', 'active', 'archived');

        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          status status,
          embedding vector(768)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Terra should see the user enum but not the vector type
      const types = await inspector.getCurrentEnums(client, ['public']);
      expect(types).toHaveLength(1);
      expect(types[0].name).toBe('status');
    });
  });

  describe("Extension Installation Verification", () => {
    test("pgvector extension should be available", async () => {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      // Verify we can create vector columns
      await client.query(`
        CREATE TABLE test_vectors (
          id SERIAL PRIMARY KEY,
          embedding vector(3)
        );
      `);

      // Insert and query vector data
      await client.query(`
        INSERT INTO test_vectors (embedding) VALUES ('[1,2,3]')
      `);

      const result = await client.query(`
        SELECT embedding FROM test_vectors
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].embedding).toBe('[1,2,3]');
    });
  });
});
