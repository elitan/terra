import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Edge case: array of enum types", () => {
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
    CREATE TYPE status AS ENUM ('active', 'inactive');
    CREATE TABLE enums (
      statuses status[]
    );
  `;

  const schemaV2 = `
    CREATE TABLE enums (
      a INTEGER
    );
  `;

  const schemaV3 = `
    CREATE TYPE status AS ENUM ('active', 'inactive');
    CREATE TABLE enums (
      a INTEGER,
      statuses status[]
    );
  `;

  const schemaV4 = `
    CREATE TYPE status AS ENUM ('active', 'inactive');
    CREATE TABLE enums (
      a INTEGER,
      statuses status[],
      status status
    );
  `;

  const schemaV5 = `
    CREATE TYPE status AS ENUM ('active', 'inactive', 'unknown');
    CREATE TABLE enums (
      a INTEGER,
      statuses status[],
      status status
    );
  `;

  test("v1: create enum array and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("v1->v2: drop enum and array column", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV2, ["public"]);
    console.log("Plan v1->v2:", JSON.stringify(plan, null, 2));
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV2, ["public"], true);

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });

  test("v2->v3: add enum and array column", async () => {
    await schemaService.apply(schemaV2, ["public"], true);

    const plan = await schemaService.plan(schemaV3, ["public"]);
    console.log("Plan v2->v3:", JSON.stringify(plan, null, 2));
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV3, ["public"], true);

    const plan2 = await schemaService.plan(schemaV3, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });

  test("v3->v4: add single enum column", async () => {
    await schemaService.apply(schemaV3, ["public"], true);

    const plan = await schemaService.plan(schemaV4, ["public"]);
    console.log("Plan v3->v4:", JSON.stringify(plan, null, 2));
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV4, ["public"], true);

    const plan2 = await schemaService.plan(schemaV4, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });

  test("v4->v5: add enum value and verify idempotency", async () => {
    await schemaService.apply(schemaV4, ["public"], true);
    await schemaService.apply(schemaV5, ["public"], true);

    const plan = await schemaService.plan(schemaV5, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });
});
