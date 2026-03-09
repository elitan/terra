import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  createTestSchemaService,
  getEnumValues,
  getTableColumnDetails,
} from "../utils";

describe("Edge case: enum types and modifications", () => {
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
    CREATE TYPE status AS ENUM ('active', 'inactive');

    CREATE TABLE users (
      type status DEFAULT 'active'
    );
  `;

  const schemaV2 = `
    CREATE TYPE status AS ENUM ('active', 'inactive');

    CREATE TABLE users (
      type status DEFAULT 'inactive'
    );
  `;

  const schemaV3 = `
    CREATE TABLE users (
      int_col INTEGER DEFAULT 1
    );
  `;

  const schemaV4 = `
    CREATE TYPE status AS ENUM ('active', 'inactive');

    CREATE TABLE users (
      renamed status DEFAULT 'inactive'
    );
  `;

  test("v1: create and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    expect(await getEnumValues(client, "status")).toEqual(["active", "inactive"]);
    expect(await getTableColumnDetails(client, "users")).toEqual([
      {
        name: "type",
        type: "status",
        nullable: true,
        default: "'active'::status",
        comment: null,
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

    expect(await getEnumValues(client, "status")).toEqual(["active", "inactive"]);
    expect(await getTableColumnDetails(client, "users")).toEqual([
      {
        name: "type",
        type: "status",
        nullable: true,
        default: "'inactive'::status",
        comment: null,
      },
    ]);

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });

  test("v2->v3: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV2, ["public"], true);

    const plan = await schemaService.plan(schemaV3, ["public"]);
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV3, ["public"], true);

    expect(await getTableColumnDetails(client, "users")).toEqual([
      {
        name: "int_col",
        type: "integer",
        nullable: true,
        default: "1",
        comment: null,
      },
    ]);
    expect(await getEnumValues(client, "status")).toEqual([]);

    const plan2 = await schemaService.plan(schemaV3, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });

  test("v3->v4: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV3, ["public"], true);

    const plan = await schemaService.plan(schemaV4, ["public"]);
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV4, ["public"], true);

    expect(await getEnumValues(client, "status")).toEqual(["active", "inactive"]);
    expect(await getTableColumnDetails(client, "users")).toEqual([
      {
        name: "renamed",
        type: "status",
        nullable: true,
        default: "'inactive'::status",
        comment: null,
      },
    ]);

    const plan2 = await schemaService.plan(schemaV4, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });
});
