import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Edge case: check constraints and expression changes", () => {
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
    create table t1 (
      a int constraint c1 check (a > 0),
      b int constraint c2 check (b > 0),
      constraint c3 check (a < b)
    );
    create table t2 (
      a int constraint c1 check (a > 0),
      c int constraint c4 check (c > 0),
      constraint c5 check (a < c)
    );
  `;

  const schemaV2 = `
    create table t1 (
      a int constraint c1 check (a > 1),
      b int constraint c2 check (b > 1),
      constraint c3 check (a < b)
    );
    create table t2 (
      a int constraint c1 check (a > 1),
      c int constraint c4 check (c > 1),
      constraint c5 check (a < c)
    );
  `;

  const schemaV3 = `
    create table t1 (
      a int constraint c1 check (a > 1),
      b int constraint c2 check (b > 1),
      -- Rename constraint.
      constraint c4 check (a < b)
    );
    create table t2 (
      a int constraint c1 check (a > 1),
      c int constraint c4 check (c > 1),
      -- Rename constraint.
      constraint c6 check (a < c)
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

  test("v2->v3: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV2, ["public"], true);

    const plan = await schemaService.plan(schemaV3, ["public"]);
    console.log("Plan:", JSON.stringify(plan, null, 2));
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV3, ["public"], true);

    const plan2 = await schemaService.plan(schemaV3, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });
});
