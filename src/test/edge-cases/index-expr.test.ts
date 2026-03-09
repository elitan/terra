import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  createTestSchemaService,
  getIndexDefinitions,
} from "../utils";

describe("Edge case: expression indexes", () => {
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
      first_name VARCHAR(128) NOT NULL,
      last_name VARCHAR(128) NOT NULL
    );
    CREATE INDEX full_name ON users ((first_name || ' ' || last_name));
  `;

  const schemaV2 = `
    CREATE TABLE users (
      first_name VARCHAR(128) NOT NULL,
      last_name VARCHAR(128) NOT NULL
    );
    CREATE INDEX full_name ON users ((first_name || '''s first name'));
  `;

  async function getUserIndexDefinition() {
    const indexes = await getIndexDefinitions(client, "users");
    expect(indexes).toHaveLength(1);
    return indexes[0]!;
  }

  test("v1: create and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const index = await getUserIndexDefinition();
    expect(index.name).toBe("full_name");
    expect(index.definition).toContain("first_name");
    expect(index.definition).toContain("last_name");
    expect(index.definition).toContain("' '");

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("v1->v2: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV2, ["public"]);
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV2, ["public"], true);

    const index = await getUserIndexDefinition();
    expect(index.name).toBe("full_name");
    expect(index.definition).toContain("first_name");
    expect(index.definition).toContain("'s first name");

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });
});
