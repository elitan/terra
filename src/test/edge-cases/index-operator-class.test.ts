import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Edge case: index operator classes", () => {
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
    CREATE TABLE pets (
      name TEXT NOT NULL
    );
    CREATE INDEX name_idx ON pets (name text_pattern_ops);
  `;

  const schemaV2 = `
    CREATE TABLE pets (
      name TEXT NOT NULL
    );
    CREATE INDEX name_idx ON pets (name);
  `;

  const schemaV3 = `
    CREATE TABLE logs (
      j JSONB NOT NULL
    );
    CREATE INDEX j_idx ON logs USING GIN (j jsonb_path_ops);
  `;

  test("v1: create non-default opclass and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("v1->v2: change opclass and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV2, ["public"]);
    console.log("Plan v1->v2:", JSON.stringify(plan, null, 2));
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV2, ["public"], true);

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });

  test("v3: GIN index with jsonb_path_ops idempotency", async () => {
    await schemaService.apply(schemaV3, ["public"], true);

    const plan = await schemaService.plan(schemaV3, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });
});
