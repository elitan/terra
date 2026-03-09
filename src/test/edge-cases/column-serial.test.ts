import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  createTestSchemaService,
  getTableColumnDetails,
} from "../utils";

describe("Edge case: serial/bigserial columns", () => {
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
      x SMALLSERIAL,
      y SERIAL,
      z BIGSERIAL
    );
  `;

  const schemaV2 = `
    CREATE TABLE t (
      x SMALLINT,
      y BIGINT,
      z SERIAL
    );
  `;

  const schemaV3 = `
    CREATE TABLE t (
      x SMALLSERIAL,
      y SERIAL
    );
  `;

  async function getSerialColumns() {
    return getTableColumnDetails(client, "t");
  }

  test("v1: create and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const columns = await getSerialColumns();
    expect(columns.map(function (column) {
      return column.type;
    })).toEqual(["smallint", "integer", "bigint"]);
    expect(columns.map(function (column) {
      return column.default;
    })).toEqual([
      expect.stringMatching(/^nextval/),
      expect.stringMatching(/^nextval/),
      expect.stringMatching(/^nextval/),
    ]);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("v1->v2: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV2, ["public"]);
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV2, ["public"], true);

    const columns = await getSerialColumns();
    expect(columns.map(function (column) {
      return column.type;
    })).toEqual(["smallint", "bigint", "integer"]);
    expect(columns[0]?.default).toBeNull();
    expect(columns[1]?.default).toBeNull();
    expect(columns[2]?.default).toBeNull();

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });

  test("v2->v3: apply changes and verify idempotency", async () => {
    await schemaService.apply(schemaV2, ["public"], true);

    const plan = await schemaService.plan(schemaV3, ["public"]);
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV3, ["public"], true);

    const columns = await getSerialColumns();
    expect(columns.map(function (column) {
      return column.type;
    })).toEqual(["smallint", "integer"]);
    expect(columns.map(function (column) {
      return column.default;
    })).toEqual([
      null,
      null,
    ]);

    const plan2 = await schemaService.plan(schemaV3, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });
});
