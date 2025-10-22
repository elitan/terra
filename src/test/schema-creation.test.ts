import { describe, test, expect, beforeEach } from "bun:test";
import { SchemaService } from "../core/schema/service";
import { DatabaseService } from "../core/database/client";
import { loadConfig } from "../core/database/config";

describe("CREATE SCHEMA", () => {
  let schemaService: SchemaService;
  let databaseService: DatabaseService;
  let config: ReturnType<typeof loadConfig>;

  beforeEach(() => {
    config = loadConfig();
    databaseService = new DatabaseService(config);
    schemaService = new SchemaService(databaseService);
  });

  test("should create a new schema and table", async () => {
    const client = await databaseService.createClient();
    try {
      // Clean up first
      await client.query('DROP SCHEMA IF EXISTS test_schema CASCADE');

      const schema = `
        CREATE SCHEMA IF NOT EXISTS test_schema;

        CREATE TABLE test_schema.users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      await schemaService.apply(schema, ['public', 'test_schema'], true);

      const result = await client.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'test_schema'
      `);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].schema_name).toBe('test_schema');

      const tableResult = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'test_schema' AND table_name = 'users'
      `);
      expect(tableResult.rows.length).toBe(1);
    } finally {
      await client.query('DROP SCHEMA IF EXISTS test_schema CASCADE');
      await client.end();
    }
  });

  test("should not recreate existing schema", async () => {
    const client = await databaseService.createClient();
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS test_existing');

      const schema = `
        CREATE SCHEMA IF NOT EXISTS test_existing;
      `;

      await schemaService.apply(schema, ['public', 'test_existing'], true);

      const result = await client.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'test_existing'
      `);
      expect(result.rows.length).toBe(1);
    } finally {
      await client.query('DROP SCHEMA IF EXISTS test_existing CASCADE');
      await client.end();
    }
  });
});
