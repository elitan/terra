import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Edge case: descending index columns (asc/desc)", () => {
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
      rank INTEGER
    );
    CREATE INDEX rank_idx ON users (rank DESC);
  `;

  const schemaV2 = `
    CREATE TABLE users (
      rank INTEGER
    );
    CREATE INDEX rank_idx ON users (rank);
  `;

  const schemaV3 = `
    CREATE TABLE users (
      rank INTEGER,
      score INTEGER
    );
    CREATE INDEX rank_score_idx ON users (rank, score DESC);
  `;

  const schemaV4 = `
    CREATE TABLE users (
      rank INTEGER,
      score INTEGER
    );
    CREATE INDEX double_rank_desc_idx ON users ((rank * 2) DESC);
    CREATE INDEX double_score_desc_idx ON users ((score * 2) DESC);
    CREATE INDEX double_rank_idx ON users ((rank * 2));
    CREATE INDEX double_score_idx ON users ((score * 2));
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

  test("v2->v3: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV2, ["public"], true);

    const plan = await schemaService.plan(schemaV3, ["public"]);
    console.log("Plan:", JSON.stringify(plan, null, 2));
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV3, ["public"], true);

    const plan2 = await schemaService.plan(schemaV3, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });

  test("v3->v4: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV3, ["public"], true);

    const plan = await schemaService.plan(schemaV4, ["public"]);
    console.log("Plan:", JSON.stringify(plan, null, 2));
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV4, ["public"], true);

    const plan2 = await schemaService.plan(schemaV4, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });
});
