import { describe, test, expect, beforeEach } from "bun:test";
import { SchemaService } from "../core/schema/service";
import { DatabaseService } from "../core/database/client";
import { loadConfig } from "../core/database/config";

describe("COMMENT ON", () => {
  let schemaService: SchemaService;
  let databaseService: DatabaseService;
  let config: ReturnType<typeof loadConfig>;

  beforeEach(() => {
    config = loadConfig();
    databaseService = new DatabaseService(config);
    schemaService = new SchemaService(databaseService);
  });

  test("should add comment on schema", async () => {
    const client = await databaseService.createClient();
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS test_comments');

      const schema = `
        CREATE SCHEMA IF NOT EXISTS test_comments;
        COMMENT ON SCHEMA test_comments IS 'Test schema for comments';
      `;

      await schemaService.apply(schema, ['public', 'test_comments'], true);

      const result = await client.query(`
        SELECT d.description
        FROM pg_namespace n
        JOIN pg_description d ON d.objoid = n.oid
        WHERE n.nspname = 'test_comments'
      `);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].description).toBe('Test schema for comments');
    } finally {
      await client.query('DROP SCHEMA IF EXISTS test_comments CASCADE');
      await client.end();
    }
  });

  test("should add comment on table", async () => {
    const schema = `
      CREATE TABLE test_table (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL
      );

      COMMENT ON TABLE test_table IS 'Test table for users';
    `;

    await schemaService.apply(schema, ['public'], true);

    const client = await databaseService.createClient();
    try {
      const result = await client.query(`
        SELECT d.description
        FROM pg_class c
        JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
        WHERE c.relname = 'test_table' AND c.relkind = 'r'
      `);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].description).toBe('Test table for users');
    } finally {
      await client.query('DROP TABLE IF EXISTS test_table CASCADE');
      await client.end();
    }
  });

  test("should update existing comment", async () => {
    const client = await databaseService.createClient();
    try {
      await client.query(`
        CREATE TABLE test_update_comment (
          id SERIAL PRIMARY KEY
        )
      `);
      await client.query(`COMMENT ON TABLE test_update_comment IS 'Old comment'`);

      const schema = `
        CREATE TABLE test_update_comment (
          id SERIAL PRIMARY KEY
        );

        COMMENT ON TABLE test_update_comment IS 'New comment';
      `;

      await schemaService.apply(schema, ['public'], true);

      const result = await client.query(`
        SELECT d.description
        FROM pg_class c
        JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
        WHERE c.relname = 'test_update_comment'
      `);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].description).toBe('New comment');
    } finally {
      await client.query('DROP TABLE IF EXISTS test_update_comment CASCADE');
      await client.end();
    }
  });
});
