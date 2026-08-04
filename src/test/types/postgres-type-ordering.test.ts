import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { createTestClient, createTestSchemaService } from "../utils";

const SCHEMA = "postgres_type_ordering";
const OTHER_SCHEMA = "postgres_type_ordering_other";

function getTypeStatements(statements: string[]): string[] {
  return statements.filter(function isTypeStatement(statement) {
    return /^(?:CREATE|ALTER|DROP)\s+(?:TYPE|DOMAIN)\b/i.test(
      statement.trim()
    );
  });
}

function findStatement(
  statements: string[],
  pattern: RegExp
): number {
  return statements.findIndex(function matches(statement) {
    return pattern.test(statement);
  });
}

describe("PostgreSQL cross-family type ordering", function () {
  let client: Client;

  beforeEach(async function prepareSchema() {
    client = await createTestClient();
    await client.query(`DROP SCHEMA IF EXISTS "${OTHER_SCHEMA}" CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  });

  afterEach(async function removeSchema() {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS "${OTHER_SCHEMA}" CASCADE`);
    await client.end();
  });

  const chainedTypes = `
    CREATE SCHEMA "${SCHEMA}";
    CREATE TYPE "${SCHEMA}"."envelope" AS (
      active_window "${SCHEMA}"."score_range",
      payload "${SCHEMA}"."constrained_payload"
    );
    CREATE DOMAIN "${SCHEMA}"."constrained_payload"
      AS "${SCHEMA}"."payload";
    CREATE TYPE "${SCHEMA}"."score_range" AS RANGE (
      subtype = "${SCHEMA}"."score"
    );
    CREATE TYPE "${SCHEMA}"."payload" AS (
      mood "${SCHEMA}"."mood",
      score "${SCHEMA}"."score"
    );
    CREATE DOMAIN "${SCHEMA}"."score" AS integer;
    CREATE TYPE "${SCHEMA}"."mood" AS ENUM ('calm', 'busy');
  `;

  test("creates enums, composites, domains, and ranges in dependency order", async function () {
    const service = createTestSchemaService();
    const plan = await service.apply(
      chainedTypes,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const statements = getTypeStatements(plan.transactional);
    const mood = findStatement(statements, /CREATE TYPE .*"mood" AS ENUM/i);
    const score = findStatement(
      statements,
      /CREATE DOMAIN .*\.?"?score"? AS/i
    );
    const payload = findStatement(
      statements,
      /CREATE TYPE .*"payload" AS\s*\(/i
    );
    const constrainedPayload = findStatement(
      statements,
      /CREATE DOMAIN .*\.?"?constrained_payload"?/i
    );
    const scoreRange = findStatement(
      statements,
      /CREATE TYPE .*\.?"?score_range"? AS RANGE/i
    );
    const envelope = findStatement(
      statements,
      /CREATE TYPE .*"envelope" AS\s*\(/i
    );

    expect(
      Math.min(
        mood,
        score,
        payload,
        constrainedPayload,
        scoreRange,
        envelope
      )
    ).toBeGreaterThanOrEqual(0);
    expect(mood).toBeLessThan(payload);
    expect(score).toBeLessThan(payload);
    expect(score).toBeLessThan(scoreRange);
    expect(payload).toBeLessThan(constrainedPayload);
    expect(constrainedPayload).toBeLessThan(envelope);
    expect(scoreRange).toBeLessThan(envelope);

    await service.apply(chainedTypes, [SCHEMA], true);
    const secondPlan = await service.apply(
      chainedTypes,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("orders composite alteration around a newly added and removed domain", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."packet" AS (id integer);
    `;
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."packet" AS (
        id integer,
        code "${SCHEMA}"."code"
      );
      CREATE DOMAIN "${SCHEMA}"."code" AS text;
    `;
    await service.apply(initial, [SCHEMA], true);

    const addPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const addStatements = getTypeStatements(addPlan.transactional);
    expect(findStatement(addStatements, /CREATE DOMAIN .*"code"/i)).toBeLessThan(
      findStatement(addStatements, /ALTER TYPE .*"packet" ADD ATTRIBUTE/i)
    );
    await service.apply(desired, [SCHEMA], true);

    const removePlan = await service.apply(
      initial,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const removeStatements = getTypeStatements(removePlan.transactional);
    expect(
      findStatement(removeStatements, /ALTER TYPE .*"packet" DROP ATTRIBUTE/i)
    ).toBeLessThan(findStatement(removeStatements, /DROP DOMAIN .*"code"/i));
    await service.apply(initial, [SCHEMA], true);
  });

  test("drops a complete cross-family graph in reverse dependency order", async function () {
    const service = createTestSchemaService();
    await service.apply(chainedTypes, [SCHEMA], true);

    const plan = await service.apply(
      `CREATE SCHEMA "${SCHEMA}";`,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const statements = getTypeStatements(plan.transactional);
    const mood = findStatement(statements, /DROP TYPE .*"mood"/i);
    const score = findStatement(statements, /DROP DOMAIN .*"score"/i);
    const payload = findStatement(statements, /DROP TYPE .*"payload"/i);
    const constrainedPayload = findStatement(
      statements,
      /DROP DOMAIN .*"constrained_payload"/i
    );
    const scoreRange = findStatement(
      statements,
      /DROP TYPE .*"score_range"/i
    );
    const envelope = findStatement(statements, /DROP TYPE .*"envelope"/i);

    expect(envelope).toBeLessThan(constrainedPayload);
    expect(envelope).toBeLessThan(scoreRange);
    expect(constrainedPayload).toBeLessThan(payload);
    expect(payload).toBeLessThan(mood);
    expect(payload).toBeLessThan(score);
    expect(scoreRange).toBeLessThan(score);
    await service.apply(`CREATE SCHEMA "${SCHEMA}";`, [SCHEMA], true);
  });

  test("rejects a cross-family dependency cycle before mutation", async function () {
    const service = createTestSchemaService();
    const cyclic = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."loop_record" AS (
        value "${SCHEMA}"."loop_domain"
      );
      CREATE DOMAIN "${SCHEMA}"."loop_domain"
        AS "${SCHEMA}"."loop_record";
    `;

    await expect(
      service.apply(cyclic, [SCHEMA], true)
    ).rejects.toThrow(/manual shell-type migration/i);
    const schema = await client.query(
      "SELECT 1 FROM pg_namespace WHERE nspname = $1",
      [SCHEMA]
    );
    expect(schema.rowCount).toBe(0);
  });

  test("rejects generated multirange name collisions before mutation", async function () {
    const service = createTestSchemaService();
    const collision = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."score_range" AS RANGE (subtype = integer);
      CREATE TYPE "${SCHEMA}"."score_multirange" AS ENUM ('reserved');
    `;

    await expect(
      service.apply(collision, [SCHEMA], true)
    ).rejects.toThrow(/generated multirange names/i);
    const schema = await client.query(
      "SELECT 1 FROM pg_namespace WHERE nspname = $1",
      [SCHEMA]
    );
    expect(schema.rowCount).toBe(0);
  });

  test("rejects cross-family physical name collisions before mutation", async function () {
    const service = createTestSchemaService();
    const collision = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."shared_name" AS integer;
      CREATE TYPE "${SCHEMA}"."shared_name" AS ENUM ('duplicate');
    `;

    await expect(
      service.apply(collision, [SCHEMA], true)
    ).rejects.toThrow(/more than one type with the same schema-qualified name/i);
    const schema = await client.query(
      "SELECT 1 FROM pg_namespace WHERE nspname = $1",
      [SCHEMA]
    );
    expect(schema.rowCount).toBe(0);
  });

  test("rejects ambiguous unqualified cross-schema references", async function () {
    const service = createTestSchemaService();
    const ambiguous = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE SCHEMA "${OTHER_SCHEMA}";
      CREATE TYPE "${SCHEMA}"."holder" AS (value shared_name);
      CREATE TYPE "${SCHEMA}"."shared_name" AS ENUM ('first');
      CREATE TYPE "${OTHER_SCHEMA}"."shared_name" AS ENUM ('second');
    `;

    await expect(
      service.apply(ambiguous, [SCHEMA, OTHER_SCHEMA], true)
    ).rejects.toThrow(/ambiguous across desired schemas/i);
    const schemas = await client.query(
      "SELECT 1 FROM pg_namespace WHERE nspname = ANY($1::text[])",
      [[SCHEMA, OTHER_SCHEMA]]
    );
    expect(schemas.rowCount).toBe(0);
  });
});
