import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { loadConfig } from "../../core/database/config";
import { cleanDatabase, createTestSchemaService } from "../utils";

describe("Functions", () => {
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

  test("should create a simple function", async () => {
    const schema = `
      CREATE FUNCTION add_numbers(a INT, b INT)
      RETURNS INT
      AS $$
        SELECT a + b
      $$
      LANGUAGE SQL;
    `;

    await schemaService.apply(schema, ['public'], true);

    const client = await databaseService.createClient();
    try {
      const result = await client.query("SELECT add_numbers(2, 3) as result");
      expect(result.rows[0].result).toBe(5);
    } finally {
      await client?.end();
    }
  });

  test("should update function body when changed", async () => {
    const schema1 = `
      CREATE FUNCTION multiply(a INT, b INT)
      RETURNS INT
      AS $$
        SELECT a * b
      $$
      LANGUAGE SQL;
    `;

    await schemaService.apply(schema1, ['public'], true);

    const schema2 = `
      CREATE FUNCTION multiply(a INT, b INT)
      RETURNS INT
      AS $$
        SELECT a * b * 2
      $$
      LANGUAGE SQL;
    `;

    await schemaService.apply(schema2, ['public'], true);

    const client = await databaseService.createClient();
    try {
      const result = await client.query("SELECT multiply(2, 3) as result");
      expect(result.rows[0].result).toBe(12);
    } finally {
      await client?.end();
    }
  });

  test("should drop function when removed from schema", async () => {
    const schema1 = `
      CREATE FUNCTION test_function()
      RETURNS INT
      AS $$
        SELECT 42
      $$
      LANGUAGE SQL;
    `;

    await schemaService.apply(schema1, ['public'], true);

    const schema2 = ``;

    await schemaService.apply(schema2, ['public'], true);

    const client = await databaseService.createClient();
    try {
      await expect(
        client.query("SELECT test_function() as result")
      ).rejects.toThrow();
    } finally {
      await client?.end();
    }
  });

  test("should handle same function name across managed schemas", async () => {
    const client = await databaseService.createClient();
    try {
      await client.query("DROP SCHEMA IF EXISTS tenant_a CASCADE");
      await client.query("CREATE SCHEMA tenant_a");

      const initialSchema = `
        CREATE FUNCTION public.compute_total()
        RETURNS INT
        AS $$
          SELECT 1
        $$
        LANGUAGE SQL;

        CREATE FUNCTION tenant_a.compute_total()
        RETURNS INT
        AS $$
          SELECT 2
        $$
        LANGUAGE SQL;
      `;

      await schemaService.apply(initialSchema, ["public", "tenant_a"], true);

      const desiredSchema = `
        CREATE FUNCTION public.compute_total()
        RETURNS INT
        AS $$
          SELECT 1
        $$
        LANGUAGE SQL;
      `;

      await schemaService.apply(desiredSchema, ["public", "tenant_a"], true);

      const publicResult = await client.query("SELECT public.compute_total() AS result");
      expect(publicResult.rows[0].result).toBe(1);
      await expect(
        client.query("SELECT tenant_a.compute_total() AS result")
      ).rejects.toThrow();
    } finally {
      await client.query("DROP SCHEMA IF EXISTS tenant_a CASCADE");
      await client.end();
    }
  });

  test("should apply function and procedure with schema-qualified custom types", async () => {
    const schema = `
      CREATE SCHEMA tenant_a;

      CREATE TYPE tenant_a."StateType" AS ENUM ('a', 'b');

      CREATE FUNCTION tenant_a.fn_state(i tenant_a."StateType")
      RETURNS tenant_a."StateType"
      AS $$
        SELECT i
      $$
      LANGUAGE SQL;

      CREATE PROCEDURE tenant_a.sync_state(IN p_state tenant_a."StateType")
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NULL;
      END;
      $$;
    `;

    await schemaService.apply(schema, ["public", "tenant_a"], true);

    const client = await databaseService.createClient();
    try {
      const functionResult = await client.query(
        "SELECT tenant_a.fn_state('a'::tenant_a.\"StateType\")::text AS value"
      );
      expect(functionResult.rows[0].value).toBe("a");

      const procedureResult = await client.query(`
        SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'tenant_a'
          AND p.proname = 'sync_state'
          AND p.prokind = 'p'
      `);
      expect(procedureResult.rows).toHaveLength(1);
    } finally {
      await client.query("DROP SCHEMA IF EXISTS tenant_a CASCADE");
      await client.end();
    }
  });

  test("should handle overloaded function and procedure lifecycle by signature", async () => {
    const initialSchema = `
      CREATE FUNCTION public.calc(v INTEGER)
      RETURNS INTEGER
      AS $$
        SELECT v + 1
      $$
      LANGUAGE SQL;

      CREATE FUNCTION public.calc(v TEXT)
      RETURNS TEXT
      AS $$
        SELECT v || '_x'
      $$
      LANGUAGE SQL;

      CREATE PROCEDURE public.sync_item(v INTEGER)
      LANGUAGE SQL
      AS $$
        SELECT 1
      $$;

      CREATE PROCEDURE public.sync_item(v TEXT)
      LANGUAGE SQL
      AS $$
        SELECT 1
      $$;
    `;

    await schemaService.apply(initialSchema, ["public"], true);

    const desiredSchema = `
      CREATE FUNCTION public.calc(v INTEGER)
      RETURNS INTEGER
      AS $$
        SELECT v + 1
      $$
      LANGUAGE SQL;

      CREATE PROCEDURE public.sync_item(v INTEGER)
      LANGUAGE SQL
      AS $$
        SELECT 1
      $$;
    `;

    await schemaService.apply(desiredSchema, ["public"], true);
    await schemaService.apply(desiredSchema, ["public"], true);

    const client = await databaseService.createClient();
    try {
      const functionRows = await client.query(`
        SELECT pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'calc'
          AND p.prokind = 'f'
        ORDER BY args
      `);
      expect(functionRows.rows).toEqual([{ args: "v integer" }]);

      const procedureRows = await client.query(`
        SELECT pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'sync_item'
          AND p.prokind = 'p'
        ORDER BY args
      `);
      expect(procedureRows.rows).toEqual([{ args: "IN v integer" }]);
    } finally {
      await client.end();
    }
  });
});
