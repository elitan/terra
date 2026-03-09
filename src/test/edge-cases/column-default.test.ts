import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  createTestSchemaService,
  getTableColumnDetails,
} from "../utils";

describe("Edge case: column default values and changes", () => {
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
      name VARCHAR DEFAULT 'unknown',
      age INTEGER DEFAULT 1,
      active BOOLEAN DEFAULT true,
      bpchar CHAR DEFAULT 'foo'
    );
  `;

  const schemaV2 = `
    CREATE TABLE users (
      name VARCHAR DEFAULT 'anonymous',
      age INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT false
    );
  `;

  test("v1: create and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    expect(await getTableColumnDetails(client, "users")).toEqual([
      {
        name: "name",
        type: "character varying",
        nullable: true,
        default: "'unknown'::character varying",
        comment: null,
      },
      {
        name: "age",
        type: "integer",
        nullable: true,
        default: "1",
        comment: null,
      },
      {
        name: "active",
        type: "boolean",
        nullable: true,
        default: "true",
        comment: null,
      },
      {
        name: "bpchar",
        type: "character(1)",
        nullable: true,
        default: "'foo'::bpchar",
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

    expect(await getTableColumnDetails(client, "users")).toEqual([
      {
        name: "name",
        type: "character varying",
        nullable: true,
        default: "'anonymous'::character varying",
        comment: null,
      },
      {
        name: "age",
        type: "integer",
        nullable: true,
        default: "0",
        comment: null,
      },
      {
        name: "active",
        type: "boolean",
        nullable: true,
        default: "false",
        comment: null,
      },
    ]);

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });
});
