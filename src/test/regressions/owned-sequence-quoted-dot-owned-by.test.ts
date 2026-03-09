import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: owned sequence supports dots inside quoted identifiers", function () {
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

  test("applies owned sequence when table identifier contains dot", async function () {
    const schema = `
      CREATE TABLE "User.Data" (
        id integer
      );

      CREATE SEQUENCE seq_dot
        OWNED BY "User.Data".id;
    `;

    await service.apply(schema, ["public"], true);

    const result = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.relname = 'seq_dot'
    `);

    expect(result.rows[0].count).toBe(1);
  });
});
