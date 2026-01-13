import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Edge case: foreign key constraints", () => {
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
    CREATE TABLE t1 (
      c1 INTEGER NOT NULL PRIMARY KEY,
      c2 INTEGER,
      c3 INTEGER
    );
    CREATE UNIQUE INDEX t1_c2_c3_idx ON t1 (c2, c3);

    CREATE TABLE t2 (
      c1 INTEGER NOT NULL PRIMARY KEY,
      c2 INTEGER,
      c3 INTEGER,
      CONSTRAINT c2_c3_1 FOREIGN KEY (c2, c3) REFERENCES t1 (c2, c3),
      CONSTRAINT c2_c3_2 FOREIGN KEY (c2, c3) REFERENCES t1 (c2, c3)
    );
  `;

  test("v1: create and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });
});
