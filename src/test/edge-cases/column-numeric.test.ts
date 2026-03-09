import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  createTestSchemaService,
  getTableColumnDetails,
} from "../utils";

describe("Edge case: numeric/decimal precision and scale", () => {
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
      a NUMERIC NOT NULL,
      b NUMERIC(10) NOT NULL,
      c NUMERIC(10,2) NOT NULL,
      d DECIMAL NOT NULL,
      e DECIMAL(10) NOT NULL,
      f DECIMAL(10,2) NOT NULL
    );
  `;

  const schemaV2 = `
    CREATE TABLE users (
      a NUMERIC(5) NOT NULL,
      b NUMERIC(10,2) NOT NULL,
      c NUMERIC NOT NULL,
      d DECIMAL(4) NOT NULL,
      e DECIMAL NOT NULL,
      f DECIMAL(10,3) NOT NULL
    );
  `;

  async function expectNumericColumnTypes(expectedTypes: string[]) {
    const columns = await getTableColumnDetails(client, "users");
    expect(columns.map(function (column) {
      return column.type;
    })).toEqual(expectedTypes);
  }

  test("v1: create and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    await expectNumericColumnTypes([
      "numeric",
      "numeric(10,0)",
      "numeric(10,2)",
      "numeric",
      "numeric(10,0)",
      "numeric(10,2)",
    ]);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("v1->v2: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV2, ["public"]);
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV2, ["public"], true);

    await expectNumericColumnTypes([
      "numeric(5,0)",
      "numeric(10,2)",
      "numeric",
      "numeric(4,0)",
      "numeric",
      "numeric(10,3)",
    ]);

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });
});
