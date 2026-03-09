import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  createTestSchemaService,
  getTableColumnDetails,
} from "../utils";

describe("Edge case: time/timestamp precision", () => {
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
    CREATE TABLE tbl (
      precision_default TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      timestamp_4 TIMESTAMP(4) NOT NULL DEFAULT CURRENT_TIMESTAMP(4),
      timestamptz_4 TIMESTAMPTZ(4) NOT NULL DEFAULT CURRENT_TIMESTAMP(4)
    );
  `;

  const schemaV2 = `
    CREATE TABLE tbl (
      c1 TIMESTAMPTZ(1),
      c2 TIMESTAMPTZ,
      c3 TIMESTAMPTZ(0),
      c4 TIME,
      c5 TIME(1),
      c6 TIMESTAMP,
      c7 TIMESTAMP(5),
      c8 TIMETZ(0),
      c9 TIMETZ,
      c10 TIMETZ(6)
    );
  `;

  async function expectTimeColumns(expectedColumns: Array<{ name: string; type: string }>) {
    const columns = await getTableColumnDetails(client, "tbl");
    expect(columns.map(function (column) {
      return {
        name: column.name,
        type: column.type,
      };
    })).toEqual(expectedColumns);
  }

  test("v1: create and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    await expectTimeColumns([
      { name: "precision_default", type: "timestamp without time zone" },
      { name: "timestamp_4", type: "timestamp(4) without time zone" },
      { name: "timestamptz_4", type: "timestamp(4) with time zone" },
    ]);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("v1->v2: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV2, ["public"]);
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV2, ["public"], true);

    await expectTimeColumns([
      { name: "c1", type: "timestamp(1) with time zone" },
      { name: "c10", type: "time(6) with time zone" },
      { name: "c2", type: "timestamp with time zone" },
      { name: "c3", type: "timestamp with time zone" },
      { name: "c4", type: "time without time zone" },
      { name: "c5", type: "time(1) without time zone" },
      { name: "c6", type: "timestamp without time zone" },
      { name: "c7", type: "timestamp(5) without time zone" },
      { name: "c8", type: "time with time zone" },
      { name: "c9", type: "time with time zone" },
    ]);

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });
});
