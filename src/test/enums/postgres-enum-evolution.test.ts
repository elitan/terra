import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { createTestClient, createTestSchemaService } from "../utils";

const SCHEMA = "enum_lifecycle";

async function readEnumLabels(
  client: Client,
  typeName: string
): Promise<string[]> {
  const result = await client.query<{ enumlabel: string }>(`
    SELECT enum.enumlabel
    FROM pg_enum enum
    JOIN pg_type type ON type.oid = enum.enumtypid
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = '${SCHEMA}' AND type.typname = '${typeName}'
    ORDER BY enum.enumsortorder
  `);
  return result.rows.map(function getLabel(row) {
    return row.enumlabel;
  });
}

describe("PostgreSQL enum evolution", function () {
  let client: Client;

  beforeEach(async function prepareSchema() {
    client = await createTestClient();
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  });

  afterEach(async function removeSchema() {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.end();
  });

  test("creates and converges empty enum types", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."empty_state" AS ENUM ();
    `;

    await service.apply(desired, [SCHEMA], true);
    const types = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_type type
      JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = '${SCHEMA}'
        AND type.typname = 'empty_state'
        AND type.typtype = 'e'
    `);
    expect(types.rows).toEqual([{ count: "1" }]);
    expect(await readEnumLabels(client, "empty_state")).toEqual([]);

    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("preserves empty, quoted, backslash, and Unicode labels", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."exact_label" AS ENUM (
        '',
        'can''t',
        E'C:\\\\temp',
        'snö ☃'
      );
    `;

    await service.apply(desired, [SCHEMA], true);
    expect(await readEnumLabels(client, "exact_label")).toEqual([
      "",
      "can't",
      "C:\\temp",
      "snö ☃",
    ]);

    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("inserts a quoted label in order before using it as a default", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."priority" AS ENUM ('low', 'high');
      CREATE TABLE "${SCHEMA}"."tasks" (
        id integer PRIMARY KEY,
        priority "${SCHEMA}"."priority" NOT NULL DEFAULT 'low'
      );
    `;
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."priority" AS ENUM ('low', 'can''t wait', 'high');
      CREATE TABLE "${SCHEMA}"."tasks" (
        id integer PRIMARY KEY,
        priority "${SCHEMA}"."priority" NOT NULL DEFAULT 'can''t wait'
      );
    `;

    await service.apply(initial, [SCHEMA], true);
    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );

    expect(plan.preTransactional).toEqual([
      `ALTER TYPE "${SCHEMA}"."priority" ADD VALUE 'can''t wait' BEFORE 'high';`,
    ]);
    expect(plan.transactional.join("\n")).toContain("SET DEFAULT 'can''t wait'");

    await service.apply(desired, [SCHEMA], true);
    expect(await readEnumLabels(client, "priority")).toEqual([
      "low",
      "can't wait",
      "high",
    ]);
    await client.query(`INSERT INTO "${SCHEMA}"."tasks" (id) VALUES (1)`);
    const rows = await client.query<{ priority: string }>(
      `SELECT priority FROM "${SCHEMA}"."tasks"`
    );
    expect(rows.rows).toEqual([{ priority: "can't wait" }]);

    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });
});
