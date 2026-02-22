import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: owned sequence creation handles table default dependency", function () {
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

  test("applies schema when table default references owned sequence", async function () {
    const schema = `
      CREATE TABLE users (
        id integer DEFAULT nextval('user_seq')
      );

      CREATE SEQUENCE user_seq OWNED BY users.id;
    `;

    await service.apply(schema, ["public"], true);

    const seq = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'user_seq' AND c.relkind = 'S'
    `);

    expect(seq.rows[0].count).toBe(1);
  });
});
