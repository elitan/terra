import { describe, test, expect, beforeEach } from "bun:test";
import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import { loadConfig } from "../../core/database/config";

describe("Functions", () => {
  let schemaService: SchemaService;
  let databaseService: DatabaseService;
  let config: ReturnType<typeof loadConfig>;

  beforeEach(() => {
    config = loadConfig();
    databaseService = new DatabaseService(config);
    schemaService = new SchemaService(databaseService);
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

    await schemaService.apply(schema, true);

    const client = await databaseService.createClient();
    try {
      const result = await client.query("SELECT add_numbers(2, 3) as result");
      expect(result.rows[0].result).toBe(5);
    } finally {
      await client.end();
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

    await schemaService.apply(schema1, true);

    const schema2 = `
      CREATE FUNCTION multiply(a INT, b INT)
      RETURNS INT
      AS $$
        SELECT a * b * 2
      $$
      LANGUAGE SQL;
    `;

    await schemaService.apply(schema2, true);

    const client = await databaseService.createClient();
    try {
      const result = await client.query("SELECT multiply(2, 3) as result");
      expect(result.rows[0].result).toBe(12);
    } finally {
      await client.end();
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

    await schemaService.apply(schema1, true);

    const schema2 = ``;

    await schemaService.apply(schema2, true);

    const client = await databaseService.createClient();
    try {
      await expect(
        client.query("SELECT test_function() as result")
      ).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});
