import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Edge case: array column types and modifications", () => {
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
    CREATE TABLE logs (
      records VARCHAR(255)[] NOT NULL
    );
  `;

  const schemaV2 = `
    CREATE TABLE logs (
      a INTEGER[] NOT NULL,
      b INTEGER[] NOT NULL,
      c VARCHAR(100)[] NOT NULL,
      d POINT[] NOT NULL
    );
  `;

  test("v1: create and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("v1->v2: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV2, ["public"]);
    console.log("Plan:", JSON.stringify(plan, null, 2));
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV2, ["public"], true);

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });
});
