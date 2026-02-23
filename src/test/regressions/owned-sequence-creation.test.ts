import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: explicit owned sequences are created", function () {
  let client: Client;
  let service: SchemaService;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    service = createTestSchemaService();
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client?.end();
  });

  test("creates sequence declared with OWNED BY", async function () {
    const schema = `
      CREATE TABLE users (
        id integer
      );

      CREATE SEQUENCE users_id_seq
        OWNED BY users.id;
    `;

    await service.apply(schema, ["public"], true);

    const result = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'S'
        AND c.relname = 'users_id_seq'
    `);

    expect(result.rows[0].count).toBe(1);
  });
});
