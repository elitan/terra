import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Edge case: foreign key on delete/update actions", () => {
  let client: Client;
  let schemaService: ReturnType<typeof createTestSchemaService>;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    schemaService = createTestSchemaService();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  const schemaV1 = `
    CREATE TABLE table_a (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE table_b (
      id TEXT PRIMARY KEY,
      table_a_id TEXT,
      CONSTRAINT table_a_fk FOREIGN KEY (table_a_id) REFERENCES table_a (id)
        ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE TABLE table_c (
      id TEXT PRIMARY KEY,
      table_a_id TEXT,
      CONSTRAINT table_a_fk FOREIGN KEY (table_a_id) REFERENCES table_a (id)
    );
  `;

  test("v1: create and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });
});
