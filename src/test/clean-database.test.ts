import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import {
  assertPublicSchemaClean,
  cleanDatabase,
  createTestClient,
  getPublicSchemaObjectSnapshot,
} from "./utils";

describe("cleanDatabase", () => {
  let client: Client;

  async function setupClient() {
    client = await createTestClient();
    await cleanDatabase(client);
  }

  async function teardownClient() {
    await cleanDatabase(client);
    await client?.end();
  }

  beforeEach(setupClient);
  afterEach(teardownClient);

  test("should remove routines types views and tables from public schema", async function () {
    await client.query(`
      CREATE TABLE cleanup_base (
        id SERIAL PRIMARY KEY,
        value TEXT
      );
      CREATE VIEW cleanup_view AS SELECT id, value FROM cleanup_base;
      CREATE MATERIALIZED VIEW cleanup_mv AS SELECT id FROM cleanup_base;
      CREATE SEQUENCE cleanup_seq;
      CREATE TYPE cleanup_enum AS ENUM ('a', 'b');
      CREATE DOMAIN cleanup_domain AS INTEGER;
      CREATE FUNCTION cleanup_fn(v INTEGER) RETURNS INTEGER
      LANGUAGE SQL
      AS $$ SELECT v + 1 $$;
    `);

    await cleanDatabase(client);
    await assertPublicSchemaClean(client);

    const snapshot = await getPublicSchemaObjectSnapshot(client);
    expect(snapshot.tables.some((name) => name.startsWith("cleanup_"))).toBe(false);
    expect(snapshot.views.some((name) => name.startsWith("cleanup_"))).toBe(false);
    expect(snapshot.materializedViews.some((name) => name.startsWith("cleanup_"))).toBe(false);
    expect(snapshot.sequences.some((name) => name.startsWith("cleanup_"))).toBe(false);
    expect(snapshot.routines.some((name) => name.startsWith("cleanup_"))).toBe(false);
    expect(snapshot.enums.some((name) => name.startsWith("cleanup_"))).toBe(false);
    expect(snapshot.domains.some((name) => name.startsWith("cleanup_"))).toBe(false);
  });
});
