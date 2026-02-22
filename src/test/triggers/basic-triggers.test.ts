import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { loadConfig } from "../../core/database/config";
import { cleanDatabase, createTestSchemaService } from "../utils";

describe("Triggers", () => {
  let schemaService: SchemaService;
  let databaseService: DatabaseService;
  let config: ReturnType<typeof loadConfig>;

  async function resetDatabase() {
    const client = await databaseService.createClient();
    try {
      await cleanDatabase(client);
    } finally {
      await client?.end();
    }
  }

  beforeEach(async () => {
    config = loadConfig();
    databaseService = new DatabaseService(config);
    schemaService = createTestSchemaService();
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
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
      await client?.end();
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
      await client?.end();
    }
  });

  test("should update trigger when when clause and function args change", async () => {
    const schema1 = `
      CREATE TABLE audit_logs (
        id SERIAL PRIMARY KEY,
        status TEXT
      );

      CREATE FUNCTION validate_log()
      RETURNS TRIGGER
      AS $$
      BEGIN
        RETURN NEW;
      END;
      $$
      LANGUAGE plpgsql;

      CREATE TRIGGER validate_log_trigger
      BEFORE INSERT ON audit_logs
      FOR EACH ROW
      WHEN (NEW.id > 0)
      EXECUTE FUNCTION validate_log('alpha');
    `;

    await schemaService.apply(schema1, ["public"], true);

    const schema2 = `
      CREATE TABLE audit_logs (
        id SERIAL PRIMARY KEY,
        status TEXT
      );

      CREATE FUNCTION validate_log()
      RETURNS TRIGGER
      AS $$
      BEGIN
        RETURN NEW;
      END;
      $$
      LANGUAGE plpgsql;

      CREATE TRIGGER validate_log_trigger
      BEFORE INSERT ON audit_logs
      FOR EACH ROW
      WHEN (NEW.id > 10)
      EXECUTE FUNCTION validate_log('beta');
    `;

    await schemaService.apply(schema2, ["public"], true);

    const client = await databaseService.createClient();
    try {
      const result = await client.query(`
        SELECT pg_get_triggerdef(t.oid) AS trigger_def
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE t.tgname = 'validate_log_trigger'
          AND n.nspname = 'public'
          AND c.relname = 'audit_logs'
          AND NOT t.tgisinternal
      `);

      expect(result.rows).toHaveLength(1);
      const triggerDef = result.rows[0]?.trigger_def as string;
      expect(triggerDef).toContain("WHEN ((new.id > 10))");
      expect(triggerDef).toContain("validate_log('beta')");
    } finally {
      await client?.end();
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
      await client?.end();
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
      await client?.end();
    }
  });

  test("should handle same trigger name across managed schemas", async () => {
    const client = await databaseService.createClient();
    try {
      await client.query("DROP SCHEMA IF EXISTS tenant_a CASCADE");
      await client.query("CREATE SCHEMA tenant_a");

      const initialSchema = `
        CREATE TABLE public.orders (
          id SERIAL PRIMARY KEY
        );

        CREATE TABLE tenant_a.orders (
          id SERIAL PRIMARY KEY
        );

        CREATE FUNCTION public.sync_order_state()
        RETURNS TRIGGER
        AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
        LANGUAGE plpgsql;

        CREATE FUNCTION tenant_a.sync_order_state()
        RETURNS TRIGGER
        AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
        LANGUAGE plpgsql;

        CREATE TRIGGER sync_order_state
        BEFORE INSERT ON public.orders
        FOR EACH ROW
        EXECUTE FUNCTION public.sync_order_state();

        CREATE TRIGGER sync_order_state
        BEFORE INSERT ON tenant_a.orders
        FOR EACH ROW
        EXECUTE FUNCTION tenant_a.sync_order_state();
      `;

      await schemaService.apply(initialSchema, ["public", "tenant_a"], true);

      const initialResult = await client.query(`
        SELECT n.nspname AS table_schema, fn.nspname AS function_schema
        FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        JOIN pg_proc p ON t.tgfoid = p.oid
        JOIN pg_namespace fn ON p.pronamespace = fn.oid
        WHERE t.tgname = 'sync_order_state' AND NOT t.tgisinternal
        ORDER BY n.nspname
      `);
      expect(initialResult.rows).toEqual([
        { table_schema: "public", function_schema: "public" },
        { table_schema: "tenant_a", function_schema: "tenant_a" },
      ]);

      const desiredSchema = `
        CREATE TABLE public.orders (
          id SERIAL PRIMARY KEY
        );

        CREATE FUNCTION public.sync_order_state()
        RETURNS TRIGGER
        AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
        LANGUAGE plpgsql;

        CREATE TRIGGER sync_order_state
        BEFORE INSERT ON public.orders
        FOR EACH ROW
        EXECUTE FUNCTION public.sync_order_state();
      `;

      await schemaService.apply(desiredSchema, ["public", "tenant_a"], true);

      const finalResult = await client.query(`
        SELECT n.nspname AS table_schema, fn.nspname AS function_schema
        FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        JOIN pg_proc p ON t.tgfoid = p.oid
        JOIN pg_namespace fn ON p.pronamespace = fn.oid
        WHERE t.tgname = 'sync_order_state' AND NOT t.tgisinternal
        ORDER BY n.nspname
      `);
      expect(finalResult.rows).toEqual([{ table_schema: "public", function_schema: "public" }]);
    } finally {
      await client.query("DROP SCHEMA IF EXISTS tenant_a CASCADE");
      await client.end();
    }
  });
});
