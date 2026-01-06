import { describe, test, expect, beforeEach } from "bun:test";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { loadConfig } from "../../core/database/config";
import { createTestSchemaService } from "../utils";

describe("Triggers", () => {
  let schemaService: SchemaService;
  let databaseService: DatabaseService;
  let config: ReturnType<typeof loadConfig>;

  beforeEach(() => {
    config = loadConfig();
    databaseService = new DatabaseService(config);
    schemaService = createTestSchemaService();
  });

  test("should create a simple trigger with trigger function", async () => {
    const schema = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        updated_at TIMESTAMP
      );

      CREATE FUNCTION update_timestamp()
      RETURNS TRIGGER
      AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$
      LANGUAGE plpgsql;

      CREATE TRIGGER update_users_timestamp
      BEFORE UPDATE ON users
      FOR EACH ROW
      EXECUTE FUNCTION update_timestamp();
    `;

    await schemaService.apply(schema, ['public'], true);

    const client = await databaseService.createClient();
    try {
      // Verify trigger exists
      const result = await client.query(`
        SELECT tgname, tgrelid::regclass, tgtype
        FROM pg_trigger
        WHERE tgname = 'update_users_timestamp'
      `);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].tgname).toBe('update_users_timestamp');
    } finally {
      await client.end();
    }
  });

  test("should update trigger when definition changes", async () => {
    const schema1 = `
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        message TEXT
      );

      CREATE FUNCTION log_insert()
      RETURNS TRIGGER
      AS $$
      BEGIN
        RAISE NOTICE 'Insert occurred';
        RETURN NEW;
      END;
      $$
      LANGUAGE plpgsql;

      CREATE TRIGGER log_trigger
      AFTER INSERT ON logs
      FOR EACH ROW
      EXECUTE FUNCTION log_insert();
    `;

    await schemaService.apply(schema1, ['public'], true);

    // Change trigger timing from AFTER to BEFORE
    const schema2 = `
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        message TEXT
      );

      CREATE FUNCTION log_insert()
      RETURNS TRIGGER
      AS $$
      BEGIN
        RAISE NOTICE 'Insert occurred';
        RETURN NEW;
      END;
      $$
      LANGUAGE plpgsql;

      CREATE TRIGGER log_trigger
      BEFORE INSERT ON logs
      FOR EACH ROW
      EXECUTE FUNCTION log_insert();
    `;

    await schemaService.apply(schema2, ['public'], true);

    const client = await databaseService.createClient();
    try {
      // Verify trigger was updated (BEFORE = bit 2 set)
      const result = await client.query(`
        SELECT tgname, tgtype
        FROM pg_trigger
        WHERE tgname = 'log_trigger' AND NOT tgisinternal
      `);
      expect(result.rows.length).toBe(1);
      // BEFORE trigger should have bit 2 set
      expect(result.rows[0].tgtype & 2).toBe(2);
    } finally {
      await client.end();
    }
  });

  test("should drop trigger when removed from schema", async () => {
    const schema1 = `
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        total DECIMAL
      );

      CREATE FUNCTION check_order()
      RETURNS TRIGGER
      AS $$
BEGIN
RETURN NEW;
END;
$$
      LANGUAGE plpgsql;

      CREATE TRIGGER validate_order
      BEFORE INSERT ON orders
      FOR EACH ROW
      EXECUTE FUNCTION check_order();
    `;

    await schemaService.apply(schema1, ['public'], true);

    // Remove trigger but keep function and table (with same whitespace)
    const schema2 = `
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        total DECIMAL
      );

      CREATE FUNCTION check_order()
      RETURNS TRIGGER
      AS $$
BEGIN
RETURN NEW;
END;
$$
      LANGUAGE plpgsql;
    `;

    await schemaService.apply(schema2, ['public'], true);

    const client = await databaseService.createClient();
    try {
      // Verify trigger was dropped
      const result = await client.query(`
        SELECT tgname
        FROM pg_trigger
        WHERE tgname = 'validate_order' AND NOT tgisinternal
      `);
      expect(result.rows.length).toBe(0);
    } finally {
      await client.end();
    }
  });

  test("should handle trigger with multiple events", async () => {
    const schema = `
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        modified_at TIMESTAMP
      );

      CREATE FUNCTION track_modification()
      RETURNS TRIGGER
      AS $$
      BEGIN
        NEW.modified_at = NOW();
        RETURN NEW;
      END;
      $$
      LANGUAGE plpgsql;

      CREATE TRIGGER track_product_changes
      BEFORE INSERT OR UPDATE ON products
      FOR EACH ROW
      EXECUTE FUNCTION track_modification();
    `;

    await schemaService.apply(schema, ['public'], true);

    const client = await databaseService.createClient();
    try {
      // Verify trigger has both INSERT and UPDATE events
      const result = await client.query(`
        SELECT tgname, tgtype
        FROM pg_trigger
        WHERE tgname = 'track_product_changes' AND NOT tgisinternal
      `);
      expect(result.rows.length).toBe(1);
      // Should have both INSERT (bit 4) and UPDATE (bit 16) set
      const tgtype = result.rows[0].tgtype;
      expect(tgtype & 4).toBe(4);  // INSERT
      expect(tgtype & 16).toBe(16); // UPDATE
    } finally {
      await client.end();
    }
  });
});
