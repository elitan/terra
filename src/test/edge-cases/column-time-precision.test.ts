import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Client } from "pg";
import {
  createTestClient,
  cleanDatabase,
  createTestSchemaService,
  getTableColumnDetails,
} from "../utils";

describe("Edge case: time/timestamp precision", function () {
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

  test("v1: create and verify idempotency", async function () {
    await schemaService.apply(schemaV1, ["public"], true);

    await expectTimeColumns([
      { name: "precision_default", type: "timestamp without time zone" },
      { name: "timestamp_4", type: "timestamp(4) without time zone" },
      { name: "timestamptz_4", type: "timestamp(4) with time zone" },
    ]);

    const plan = await schemaService.plan(schemaV1, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("v1->v2: apply changes and verify idempotency", async function () {
    await schemaService.apply(schemaV1, ["public"], true);

    const plan = await schemaService.plan(schemaV2, ["public"]);
    expect(plan.hasChanges).toBe(true);

    await schemaService.apply(schemaV2, ["public"], true);

    await expectTimeColumns([
      { name: "c1", type: "timestamp(1) with time zone" },
      { name: "c10", type: "time(6) with time zone" },
      { name: "c2", type: "timestamp with time zone" },
      { name: "c3", type: "timestamp(0) with time zone" },
      { name: "c4", type: "time without time zone" },
      { name: "c5", type: "time(1) without time zone" },
      { name: "c6", type: "timestamp without time zone" },
      { name: "c7", type: "timestamp(5) without time zone" },
      { name: "c8", type: "time(0) with time zone" },
      { name: "c9", type: "time with time zone" },
    ]);

    const plan2 = await schemaService.plan(schemaV2, ["public"]);
    expect(plan2.hasChanges).toBe(false);
  });

  test("preserves documented temporal boundaries and interval fields", async function () {
    const schema = `
      CREATE TYPE temporal_precision_pair AS (
        local_time TIME(0),
        zoned_time TIMETZ(6),
        local_timestamp TIMESTAMP(0),
        zoned_timestamp TIMESTAMPTZ(6),
        duration INTERVAL DAY TO SECOND(6)
      );
      CREATE DOMAIN temporal_precision_domain AS INTERVAL SECOND(0);
      CREATE TABLE temporal_precision_partitions (
        recorded_at TIMESTAMP(0),
        duration INTERVAL SECOND(0)
      ) PARTITION BY RANGE (recorded_at);
      CREATE TABLE temporal_precision_records (
        id INTEGER PRIMARY KEY,
        time_min TIME(0),
        time_max TIME(6),
        timetz_min TIMETZ(0),
        timetz_max TIMETZ(6),
        timestamp_min TIMESTAMP(0),
        timestamp_max TIMESTAMP(6),
        timestamptz_min TIMESTAMPTZ(0),
        timestamptz_max TIMESTAMPTZ(6),
        interval_min INTERVAL(0),
        interval_max INTERVAL(6),
        year_only INTERVAL YEAR,
        month_only INTERVAL MONTH,
        day_only INTERVAL DAY,
        hour_only INTERVAL HOUR,
        minute_only INTERVAL MINUTE,
        second_only INTERVAL SECOND,
        year_month INTERVAL YEAR TO MONTH,
        day_hour INTERVAL DAY TO HOUR,
        day_minute INTERVAL DAY TO MINUTE,
        day_second INTERVAL DAY TO SECOND(6),
        hour_minute INTERVAL HOUR TO MINUTE,
        hour_second INTERVAL HOUR TO SECOND(3),
        minute_second INTERVAL MINUTE TO SECOND(0),
        duration_values INTERVAL DAY TO SECOND(6)[2][3],
        pair_value temporal_precision_pair,
        domain_value temporal_precision_domain
      );
    `;

    await schemaService.apply(schema, ["public"], true);
    await client.query(`
      INSERT INTO temporal_precision_records (
        id,
        time_min,
        timestamp_max,
        interval_min,
        day_second,
        duration_values
      ) VALUES (
        1,
        TIME '12:34:56.789',
        TIMESTAMP '2026-08-04 12:34:56.123456',
        INTERVAL '1.6 seconds',
        INTERVAL '2 days 03:04:05.123456',
        ARRAY[INTERVAL '1 day 00:00:00.123456']
      )
    `);

    const columns = await getTableColumnDetails(
      client,
      "temporal_precision_records"
    );
    expect(columns.map(function getType(column) {
      return column.type;
    })).toEqual([
      "integer",
      "time(0) without time zone",
      "time(6) without time zone",
      "time(0) with time zone",
      "time(6) with time zone",
      "timestamp(0) without time zone",
      "timestamp(6) without time zone",
      "timestamp(0) with time zone",
      "timestamp(6) with time zone",
      "interval(0)",
      "interval(6)",
      "interval year",
      "interval month",
      "interval day",
      "interval hour",
      "interval minute",
      "interval second",
      "interval year to month",
      "interval day to hour",
      "interval day to minute",
      "interval day to second(6)",
      "interval hour to minute",
      "interval hour to second(3)",
      "interval minute to second(0)",
      "interval day to second(6)[]",
      "temporal_precision_pair",
      "temporal_precision_domain",
    ]);

    const dependentTypes = await client.query(`
      SELECT 'composite' AS kind,
             attribute.attname AS name,
             format_type(attribute.atttypid, attribute.atttypmod) AS type
      FROM pg_attribute attribute
      WHERE attribute.attrelid = 'public.temporal_precision_pair'::regclass
        AND attribute.attnum > 0
      UNION ALL
      SELECT 'domain', type.typname,
             format_type(type.typbasetype, type.typtypmod)
      FROM pg_type type
      WHERE type.typnamespace = 'public'::regnamespace
        AND type.typname = 'temporal_precision_domain'
      ORDER BY kind, name
    `);
    expect(dependentTypes.rows).toEqual([
      { kind: "composite", name: "duration", type: "interval day to second(6)" },
      { kind: "composite", name: "local_time", type: "time(0) without time zone" },
      { kind: "composite", name: "local_timestamp", type: "timestamp(0) without time zone" },
      { kind: "composite", name: "zoned_time", type: "time(6) with time zone" },
      { kind: "composite", name: "zoned_timestamp", type: "timestamp(6) with time zone" },
      { kind: "domain", name: "temporal_precision_domain", type: "interval second(0)" },
    ]);

    expect((await schemaService.plan(schema, ["public"])).hasChanges).toBe(false);
    await schemaService.apply(schema, ["public"], true);
    expect((await client.query(`
      SELECT id,
             time_min::text,
             timestamp_max::text,
             interval_min::text,
             day_second::text,
             duration_values::text
      FROM temporal_precision_records
    `)).rows).toEqual([{
      id: 1,
      time_min: "12:34:57",
      timestamp_max: "2026-08-04 12:34:56.123456",
      interval_min: "00:00:02",
      day_second: "2 days 03:04:05.123456",
      duration_values: '{"1 day 00:00:00.123456"}',
    }]);
  });

  test("rejects lossy temporal modifiers before mutation", async function () {
    const baseline = `
      CREATE TABLE temporal_precision_guard (
        id INTEGER
      );
    `;
    await schemaService.apply(baseline, ["public"], true);

    for (const definition of [
      "TIME(7)",
      "TIMETZ(7)",
      "TIMESTAMP(7)",
      "TIMESTAMPTZ(7)",
      "INTERVAL(7)",
      "INTERVAL DAY TO SECOND(7)",
    ]) {
      await expect(schemaService.plan(`
        CREATE TABLE temporal_precision_guard (
          id INTEGER,
          pending TEXT
        );
        CREATE TABLE invalid_temporal_precision (
          value ${definition}
        );
      `, ["public"])).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(/temporal precision.*between 0 and 6/i),
      });
    }

    const guardColumns = await getTableColumnDetails(
      client,
      "temporal_precision_guard"
    );
    expect(guardColumns.map(function getColumnName(column) {
      return column.name;
    })).toEqual(["id"]);
  });

  test("rejects temporal range modifiers that PostgreSQL does not retain", async function () {
    for (const definition of [
      "TIMESTAMP(3)",
      "INTERVAL(3)",
      "INTERVAL DAY TO SECOND",
    ]) {
      await expect(schemaService.plan(`
        CREATE TYPE temporal_modifier_range AS RANGE (
          subtype = ${definition}
        );
      `, ["public"])).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(/range subtype.*temporal modifier.*not retain/i),
      });
    }
  });
});
