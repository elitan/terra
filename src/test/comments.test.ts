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
    schemaService = createTestSchemaService();
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

  test("should add comment on column", async () => {
    const schema = `
      CREATE TABLE test_column_comment (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(100)
      );

      COMMENT ON COLUMN test_column_comment.email IS 'User email address';
      COMMENT ON COLUMN test_column_comment.name IS 'User full name';
    `;

    await schemaService.apply(schema, ['public'], true);

    const client = await databaseService.createClient();
    try {
      const result = await client.query(`
        SELECT
          a.attname as column_name,
          d.description as comment
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid
        JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = a.attnum
        WHERE c.relname = 'test_column_comment'
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attname
      `);

      expect(result.rows.length).toBe(2);

      const emailComment = result.rows.find(r => r.column_name === 'email');
      const nameComment = result.rows.find(r => r.column_name === 'name');

      expect(emailComment?.comment).toBe('User email address');
      expect(nameComment?.comment).toBe('User full name');
    } finally {
      await client.query('DROP TABLE IF EXISTS test_column_comment CASCADE');
      await client.end();
    }
  });

  test("should update existing column comment", async () => {
    const client = await databaseService.createClient();
    try {
      await client.query(`
        CREATE TABLE test_column_update (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        )
      `);
      await client.query(`COMMENT ON COLUMN test_column_update.email IS 'Old email comment'`);

      const schema = `
        CREATE TABLE test_column_update (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );

        COMMENT ON COLUMN test_column_update.email IS 'Updated email comment';
      `;

      await schemaService.apply(schema, ['public'], true);

      const result = await client.query(`
        SELECT d.description
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid
        JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = a.attnum
        WHERE c.relname = 'test_column_update' AND a.attname = 'email'
      `);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].description).toBe('Updated email comment');
    } finally {
      await client.query('DROP TABLE IF EXISTS test_column_update CASCADE');
      await client.end();
    }
  });

  test("should handle comment-only changes without triggering ALTER TABLE", async () => {
    const client = await databaseService.createClient();
    try {
      // First, create table with a column
      const initialSchema = `
        CREATE TABLE test_comment_only (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );
      `;
      await schemaService.apply(initialSchema, ['public'], true);

      // Now add a comment without changing the column structure
      const schemaWithComment = `
        CREATE TABLE test_comment_only (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );

        COMMENT ON COLUMN test_comment_only.email IS 'Email address';
      `;
      await schemaService.apply(schemaWithComment, ['public'], true);

      // Verify comment was added
      const result = await client.query(`
        SELECT d.description
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid
        JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = a.attnum
        WHERE c.relname = 'test_comment_only' AND a.attname = 'email'
      `);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].description).toBe('Email address');
    } finally {
      await client.query('DROP TABLE IF EXISTS test_comment_only CASCADE');
      await client.end();
    }
  });

  test("should handle both column type change and comment change", async () => {
    const client = await databaseService.createClient();
    try {
      // First, create table with a column and comment
      await client.query(`
        CREATE TABLE test_type_and_comment (
          id SERIAL PRIMARY KEY,
          status VARCHAR(50) NOT NULL
        )
      `);
      await client.query(`COMMENT ON COLUMN test_type_and_comment.status IS 'Old status comment'`);

      // Now change both type and comment
      const schema = `
        CREATE TABLE test_type_and_comment (
          id SERIAL PRIMARY KEY,
          status VARCHAR(100) NOT NULL
        );

        COMMENT ON COLUMN test_type_and_comment.status IS 'Updated status comment';
      `;
      await schemaService.apply(schema, ['public'], true);

      // Verify both changes were applied
      const typeResult = await client.query(`
        SELECT format_type(a.atttypid, a.atttypmod) as data_type
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE c.relname = 'test_type_and_comment' AND a.attname = 'status'
      `);

      const commentResult = await client.query(`
        SELECT d.description
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid
        JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = a.attnum
        WHERE c.relname = 'test_type_and_comment' AND a.attname = 'status'
      `);

      expect(typeResult.rows[0].data_type).toBe('character varying(100)');
      expect(commentResult.rows[0].description).toBe('Updated status comment');
    } finally {
      await client.query('DROP TABLE IF EXISTS test_type_and_comment CASCADE');
      await client.end();
    }
  });
});
