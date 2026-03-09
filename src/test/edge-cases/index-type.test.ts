import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  createTestSchemaService,
  getIndexDefinitions,
} from "../utils";

describe("Edge case: index types (btree, hash, gin, gist)", () => {
  let client: Client;
  let schemaService: ReturnType<typeof createTestSchemaService>;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    schemaService = createTestSchemaService();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client?.end();
  });

  const schemaV1 = `
    CREATE TABLE users (
      name TEXT NOT NULL,
      data JSONB
    );
    CREATE INDEX users_name ON users USING HASH (name);
    CREATE INDEX users_data ON users USING GIN (data);
  `;

  const schemaV2 = `
    CREATE TABLE users (
      name TEXT NOT NULL,
      data JSONB
    );
    CREATE INDEX users_name ON users USING BTREE (name);
    CREATE INDEX users_data ON users USING BTREE (data);
  `;

  test("v1: create and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    expect(await getIndexDefinitions(client, "users")).toEqual([
      {
        name: "users_data",
        definition: "CREATE INDEX users_data ON public.users USING gin (data)",
      },
      {
        name: "users_name",
        definition: "CREATE INDEX users_name ON public.users USING hash (name)",
      },
    ]);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("v1->v2: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV2, ["public"]);
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV2, ["public"], true);

    expect(await getIndexDefinitions(client, "users")).toEqual([
      {
        name: "users_data",
        definition: "CREATE INDEX users_data ON public.users USING btree (data)",
      },
      {
        name: "users_name",
        definition: "CREATE INDEX users_name ON public.users USING btree (name)",
      },
    ]);

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });
});
