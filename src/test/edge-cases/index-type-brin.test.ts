import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Edge case: BRIN indexes", () => {
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
    CREATE TABLE users (
      c INTEGER NOT NULL
    );
    CREATE INDEX users_c ON users USING BRIN (c);
  `;

  const schemaV2 = `
    CREATE TABLE users (
      c INTEGER NOT NULL
    );
    CREATE INDEX users_c ON users USING BRIN (c) WITH (pages_per_range = 2);
  `;

  const schemaV3 = `
    CREATE TABLE users (
      c INTEGER NOT NULL
    );
    CREATE INDEX users_c ON users USING BRIN (c) WITH (pages_per_range = 3);
  `;

  test("v1: create and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("v1->v2: add storage parameter and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV2, ["public"]);
    console.log("Plan v1->v2:", JSON.stringify(plan, null, 2));
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV2, ["public"], true);

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });

  test("v2->v3: change storage parameter and verify idempotency", async () => {
    await schemaService.apply(schemaV2, ["public"], true);

    const plan = await schemaService.plan(schemaV3, ["public"]);
    console.log("Plan v2->v3:", JSON.stringify(plan, null, 2));
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV3, ["public"], true);

    const plan2 = await schemaService.plan(schemaV3, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });
});
