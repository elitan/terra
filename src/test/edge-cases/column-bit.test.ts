import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  createTestSchemaService,
  getTableColumnDetails,
} from "../utils";

describe("Edge case: bit/varbit column types", () => {
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
    CREATE TABLE t (
      c1 BIT,
      c2 BIT(2),
      c3 BIT VARYING,
      c4 BIT VARYING(1)
    );
  `;

  const schemaV2 = `
    CREATE TABLE t (
      c1 BIT(1),
      c2 BIT(1),
      c3 BIT VARYING(4),
      c4 BIT VARYING(64)
    );
  `;

  async function expectBitColumnTypes(expectedTypes: string[]) {
    const columns = await getTableColumnDetails(client, "t");
    expect(columns.map(function (column) {
      return column.type;
    })).toEqual(expectedTypes);
  }

  test("v1: create and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    await expectBitColumnTypes([
      "bit(1)",
      "bit(2)",
      "bit varying",
      "bit varying(1)",
    ]);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("v1->v2: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV2, ["public"]);
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV2, ["public"], true);

    await expectBitColumnTypes([
      "bit(1)",
      "bit(1)",
      "bit varying(4)",
      "bit varying(64)",
    ]);

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });
});
