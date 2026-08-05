import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  createTestSchemaService,
  getTableColumnDetails,
} from "../utils";

describe("Edge case: numeric/decimal precision and scale", function () {
  let client: Client;
  let schemaService: ReturnType<typeof createTestSchemaService>;

  beforeEach(async function prepareDatabase() {
    client = await createTestClient();
    await cleanDatabase(client);
    schemaService = createTestSchemaService();
  });

  afterEach(async function cleanUpDatabase() {
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

  async function expectNumericColumnTypes(
    expectedTypes: string[],
    tableName: string = "users"
  ) {
    const columns = await getTableColumnDetails(client, tableName);
    expect(columns.map(function (column) {
      return column.type;
    })).toEqual(expectedTypes);
  }

  async function getServerVersionNum(): Promise<number> {
    const result = await client.query(
      "SELECT current_setting('server_version_num')::integer AS version_num"
    );
    return result.rows[0].version_num;
  }

  test("v1: create and verify idempotency", async function () {
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

  test("v1->v2: apply changes and verify idempotency", async function () {
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

  test("supports extended numeric scales only on PostgreSQL 15 and newer", async function () {
    const advancedSchema = `
      CREATE TYPE numeric_scale_pair AS (
        negative_scale NUMERIC(2,-3),
        scale_above_precision NUMERIC(3,5)
      );
      CREATE DOMAIN numeric_scale_domain AS DECIMAL(4,-2);
      CREATE TABLE numeric_scale_partitions (
        id INTEGER,
        negative_scale NUMERIC(2,-3)
      ) PARTITION BY RANGE (id);
      CREATE TABLE numeric_scale_partitions_low
        PARTITION OF numeric_scale_partitions FOR VALUES FROM (0) TO (10);
      CREATE TABLE numeric_scale_records (
        id INTEGER PRIMARY KEY,
        negative_scale NUMERIC(2,-3),
        scale_above_precision DECIMAL(3,5),
        negative_scale_values NUMERIC(2,-3)[],
        pair_value numeric_scale_pair,
        domain_value numeric_scale_domain
      );
    `;
    const versionNum = await getServerVersionNum();

    if (versionNum < 150000) {
      const baseline = `
        CREATE TABLE numeric_scale_guard (
          id INTEGER
        );
      `;
      await schemaService.apply(baseline, ["public"], true);
      const invalid = `
        CREATE TABLE numeric_scale_guard (
          id INTEGER,
          pending TEXT
        );
        ${advancedSchema}
      `;

      await expect(
        schemaService.apply(invalid, ["public"], true)
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(/PostgreSQL 14.*numeric scale/i),
      });
      const guardColumns = await getTableColumnDetails(
        client,
        "numeric_scale_guard"
      );
      expect(guardColumns.map(function getColumnName(column) {
        return column.name;
      })).toEqual(["id"]);
      return;
    }

    await schemaService.apply(advancedSchema, ["public"], true);
    await client.query(`
      INSERT INTO numeric_scale_records (
        id,
        negative_scale,
        scale_above_precision,
        negative_scale_values
      ) VALUES (1, 1234, 0.00123, ARRAY[1234]::numeric(2,-3)[])
    `);
    await expectNumericColumnTypes([
      "integer",
      "numeric(2,-3)",
      "numeric(3,5)",
      "numeric(2,-3)[]",
      "numeric_scale_pair",
      "numeric_scale_domain",
    ], "numeric_scale_records");
    expect((await schemaService.plan(advancedSchema, ["public"])).hasChanges)
      .toBe(false);
    await schemaService.apply(advancedSchema, ["public"], true);
    expect(
      (await client.query(`
        SELECT id,
               negative_scale::text,
               scale_above_precision::text,
               negative_scale_values::text
        FROM numeric_scale_records
      `)).rows
    ).toEqual([{
      id: 1,
      negative_scale: "1000",
      scale_above_precision: "0.00123",
      negative_scale_values: "{1000}",
    }]);
  });

  test("rejects numeric modifiers outside server limits before mutation", async function () {
    const versionNum = await getServerVersionNum();
    const invalidDefinitions = [
      "NUMERIC(0)",
      "NUMERIC(1001)",
      "NUMERIC(foo)",
      "NUMERIC(2,1,3)",
      "NUMERIC(+2,+1)",
    ];
    if (versionNum >= 150000) {
      invalidDefinitions.push("NUMERIC(2,-1001)", "NUMERIC(2,1001)");
    }

    for (const definition of invalidDefinitions) {
      await expect(
        schemaService.plan(`
          CREATE TABLE invalid_numeric_modifier (
            value ${definition}
          );
        `, ["public"])
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(/numeric (modifier|precision|scale)/i),
      });
    }
  });

  test("rejects uninspectable numeric modifiers on range subtypes", async function () {
    await expect(
      schemaService.plan(`
        CREATE TYPE numeric_modifier_range AS RANGE (
          subtype = NUMERIC(2,1)
        );
      `, ["public"])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/range subtype.*numeric modifier.*not retain/i),
    });
  });
});
