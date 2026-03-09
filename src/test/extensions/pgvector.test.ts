import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseInspector } from "../../core/schema/inspector";
import { PostgresProvider } from "../../providers/postgres";

function getPgvectorConfig() {
  const connectionString =
    process.env.PGVECTOR_DATABASE_URL ||
    process.env.EXTENSIONS_DATABASE_URL ||
    process.env.REAL_WORLD_SCHEMA_DATABASE_URL ||
    "postgres://test_user:test_password@localhost:5488/sql_terraform_test";
  const url = new URL(connectionString);

  return {
    host: url.hostname,
    port: Number.parseInt(url.port || "5432", 10),
    database: url.pathname.slice(1) || "postgres",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

async function createPgvectorClient(): Promise<Client> {
  const client = new Client(getPgvectorConfig());
  await client.connect();
  return client;
}

function createPgvectorSchemaService(): SchemaService {
  const provider = new PostgresProvider();
  return new SchemaService(provider, { dialect: "postgres", ...getPgvectorConfig() });
}

async function cleanDatabase(client: Client) {
  const tables = await client.query(`
    SELECT t.tablename
    FROM pg_tables t
    JOIN pg_class c ON c.relname = t.tablename
    JOIN pg_namespace n ON c.relnamespace = n.oid AND n.nspname = t.schemaname
    LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
    WHERE t.schemaname = 'public'
      AND d.objid IS NULL
  `);

  for (const row of tables.rows) {
    await client.query(`DROP TABLE IF EXISTS ${row.tablename} CASCADE`);
  }

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
    if (client) {
      await cleanDatabase(client);
    }
    await client?.end();
  });

  describe("Extension Object Filtering", () => {
    test("should not detect pgvector types as user types", async () => {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      const extCheck = await client.query(`
        SELECT * FROM pg_extension WHERE extname = 'vector'
      `);
      expect(extCheck.rows).toHaveLength(1);

      const types = await inspector.getCurrentEnums(client, ['public']);
      expect(types).toHaveLength(0);
    });

    test("should not try to drop pgvector types on empty schema apply", async () => {
      const initialSchema = `
        CREATE EXTENSION IF NOT EXISTS vector;

        CREATE TABLE documents (
          id SERIAL PRIMARY KEY,
          content TEXT,
          embedding vector(3)
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      const tables1 = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'documents'
      `);
      expect(tables1.rows).toHaveLength(1);

      const schemaWithoutTable = `
        CREATE EXTENSION IF NOT EXISTS vector;
      `;
      await schemaService.apply(schemaWithoutTable, ['public'], true);

      const tables2 = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'documents'
      `);
      expect(tables2.rows).toHaveLength(0);

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

      const result = await client.query(`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_name = 'embeddings' AND column_name = 'vec'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].udt_name).toBe('vector');
    });

    test("should not detect pgvector functions as user functions", async () => {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      const pgFunctions = await client.query(`
        SELECT proname FROM pg_proc
        WHERE proname LIKE 'vector%'
        LIMIT 1
      `);
      expect(pgFunctions.rows.length).toBeGreaterThan(0);

      const functions = await inspector.getCurrentFunctions(client, ['public']);
      const vectorFunctions = functions.filter(f => f.name.startsWith('vector'));
      expect(vectorFunctions).toHaveLength(0);
    });

    test("should handle mix of user and extension types", async () => {
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

      const types = await inspector.getCurrentEnums(client, ['public']);
      expect(types).toHaveLength(1);
      expect(types[0].name).toBe('status');
    });
  });

  describe("Extension Installation Verification", () => {
    test("pgvector extension should be available", async () => {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      await client.query(`
        CREATE TABLE test_vectors (
          id SERIAL PRIMARY KEY,
          embedding vector(3)
        );
      `);

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

      const extResult = await client.query(`
        SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'
      `);
      expect(extResult.rows).toHaveLength(1);
      expect(extResult.rows[0].extname).toBe('vector');

      const tableResult = await client.query(`
        SELECT column_name, udt_name
        FROM information_schema.columns
        WHERE table_name = 'documents' AND column_name = 'embedding'
      `);
      expect(tableResult.rows).toHaveLength(1);
      expect(tableResult.rows[0].udt_name).toBe('vector');
    });

    test("should be idempotent when extension already exists", async () => {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      const schema = `
        CREATE EXTENSION IF NOT EXISTS vector;

        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          vec vector(768)
        );
      `;

      await schemaService.apply(schema, ['public'], true);
      await schemaService.apply(schema, ['public'], true);

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

      let extResult = await client.query(`
        SELECT extname FROM pg_extension WHERE extname = 'vector'
      `);
      expect(extResult.rows).toHaveLength(1);

      const schemaWithoutExtension = `
        CREATE TABLE docs (
          id SERIAL PRIMARY KEY,
          content TEXT
        );
      `;

      await schemaService.apply(schemaWithoutExtension, ['public'], true);

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

      await schemaService.apply(schema, ['public'], true);

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
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      const extensions = await inspector.getCurrentExtensions(client, ['public']);

      const vectorExt = extensions.find(e => e.name === 'vector');
      expect(vectorExt).toBeDefined();
      expect(vectorExt?.name).toBe('vector');
      expect(vectorExt?.schema).toBe('public');
    });
  });
});
