import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { DatabaseInspector } from "../../core/schema/inspector";
import { PostgresProvider } from "../../providers/postgres";

/**
 * Extension Tests - pgvector
 *
 * These tests run against a PostgreSQL instance with pgvector extension.
 * Use DATABASE_URL to point to the pgvector instance (port 5488).
 */

const PGVECTOR_CONFIG = {
  host: "localhost",
  port: 5488,
  database: "sql_terraform_test",
  user: "test_user",
  password: "test_password",
};

async function createPgvectorClient(): Promise<Client> {
  const client = new Client(PGVECTOR_CONFIG);
  await client.connect();
  return client;
}

function createPgvectorDatabaseService(): DatabaseService {
  return new DatabaseService(PGVECTOR_CONFIG);
}

function createPgvectorSchemaService(): SchemaService {
  const provider = new PostgresProvider();
  return new SchemaService(provider, { dialect: "postgres", ...PGVECTOR_CONFIG });
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
    schemaService = createPgvectorSchemaService();
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
      // Install pgvector via schema
      // Create a user table with vector column
      const initialSchema = `
        CREATE EXTENSION IF NOT EXISTS vector;

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

      // Now apply schema without table but keep extension
      const schemaWithoutTable = `
        CREATE EXTENSION IF NOT EXISTS vector;
      `;
      await schemaService.apply(schemaWithoutTable, ['public'], true);

      // Verify user table was dropped
      const tables2 = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'documents'
      `);
      expect(tables2.rows).toHaveLength(0);

      // But pgvector extension should still exist
      const vectorType = await client.query(`
        SELECT typname FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE n.nspname = 'public' AND t.typname = 'vector'
      `);
      expect(vectorType.rows).toHaveLength(1);
    });

    test("should allow using pgvector types in schema", async () => {
      const schema = `
        CREATE EXTENSION IF NOT EXISTS vector;

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
      // Create user enum type and install extension
      const schema = `
        CREATE EXTENSION IF NOT EXISTS vector;

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

  describe("CREATE EXTENSION Support", () => {
    test("should create extension when specified in schema", async () => {
      const schema = `
        CREATE EXTENSION IF NOT EXISTS vector;

        CREATE TABLE documents (
          id SERIAL PRIMARY KEY,
          content TEXT,
          embedding vector(1536)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify extension was created
      const extResult = await client.query(`
        SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'
      `);
      expect(extResult.rows).toHaveLength(1);
      expect(extResult.rows[0].extname).toBe('vector');

      // Verify table was created with vector column
      const tableResult = await client.query(`
        SELECT column_name, udt_name
        FROM information_schema.columns
        WHERE table_name = 'documents' AND column_name = 'embedding'
      `);
      expect(tableResult.rows).toHaveLength(1);
      expect(tableResult.rows[0].udt_name).toBe('vector');
    });

    test("should be idempotent when extension already exists", async () => {
      // Manually create extension first
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      const schema = `
        CREATE EXTENSION IF NOT EXISTS vector;

        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          vec vector(768)
        );
      `;

      // Apply schema twice
      await schemaService.apply(schema, ['public'], true);
      await schemaService.apply(schema, ['public'], true);

      // Extension should still exist once
      const extResult = await client.query(`
        SELECT COUNT(*) as count FROM pg_extension WHERE extname = 'vector'
      `);
      expect(parseInt(extResult.rows[0].count)).toBe(1);
    });

    test("should drop extension when removed from schema", async () => {
      const schemaWithExtension = `
        CREATE EXTENSION IF NOT EXISTS vector;

        CREATE TABLE docs (
          id SERIAL PRIMARY KEY,
          content TEXT
        );
      `;

      await schemaService.apply(schemaWithExtension, ['public'], true);

      // Verify extension exists
      let extResult = await client.query(`
        SELECT extname FROM pg_extension WHERE extname = 'vector'
      `);
      expect(extResult.rows).toHaveLength(1);

      // Apply schema without extension - Terra should drop it with CASCADE
      const schemaWithoutExtension = `
        CREATE TABLE docs (
          id SERIAL PRIMARY KEY,
          content TEXT
        );
      `;

      await schemaService.apply(schemaWithoutExtension, ['public'], true);

      // Extension should be dropped
      extResult = await client.query(`
        SELECT extname FROM pg_extension WHERE extname = 'vector'
      `);
      expect(extResult.rows).toHaveLength(0);
    });

    test("should handle multiple extensions", async () => {
      const schema = `
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;

        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name TEXT,
          embedding vector(512)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify both extensions exist
      const extResult = await client.query(`
        SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')
        ORDER BY extname
      `);
      expect(extResult.rows).toHaveLength(2);
      expect(extResult.rows[0].extname).toBe('pg_trgm');
      expect(extResult.rows[1].extname).toBe('vector');
    });

    test("should create extensions before tables that use them", async () => {
      const schema = `
        CREATE EXTENSION IF NOT EXISTS vector;

        CREATE TABLE embeddings (
          id SERIAL PRIMARY KEY,
          vec vector(256)
        );
      `;

      // This should not fail - extension should be created first
      await schemaService.apply(schema, ['public'], true);

      // Verify both extension and table exist
      const extResult = await client.query(`
        SELECT extname FROM pg_extension WHERE extname = 'vector'
      `);
      expect(extResult.rows).toHaveLength(1);

      const tableResult = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_name = 'embeddings'
      `);
      expect(tableResult.rows).toHaveLength(1);
    });

    test("should detect and report existing extensions", async () => {
      // Manually install extension
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      // Get current extensions
      const extensions = await inspector.getCurrentExtensions(client, ['public']);

      const vectorExt = extensions.find(e => e.name === 'vector');
      expect(vectorExt).toBeDefined();
      expect(vectorExt?.name).toBe('vector');
      expect(vectorExt?.schema).toBe('public');
    });
  });
});
