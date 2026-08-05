import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { getStatementRisk } from "../../utils/statement-classifier";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: owned sequence ownership changes are detected", function () {
  let client: Client;
  let service: SchemaService;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    service = createTestSchemaService();
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client?.end();
  });

  test("updates sequence when OWNED BY target changes", async function () {
    const initialSchema = `
      CREATE TABLE users (id integer);
      CREATE TABLE accounts (id integer);
      CREATE SEQUENCE user_seq OWNED BY users.id;
    `;

    const updatedSchema = `
      CREATE TABLE users (id integer);
      CREATE TABLE accounts (id integer);
      CREATE SEQUENCE user_seq OWNED BY accounts.id;
    `;

    await service.apply(initialSchema, ["public"], true);
    const before = await client.query(
      "SELECT 'public.user_seq'::regclass::oid::integer AS oid, nextval('public.user_seq') AS value"
    );

    const plan = await service.apply(updatedSchema, ["public"], true, undefined, true);

    expect(plan.hasChanges).toBe(true);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain("ALTER SEQUENCE");
    expect(sql).toContain("OWNED BY NONE");
    expect(sql).toContain("OWNED BY public.accounts.id");
    expect(sql).not.toContain("DROP SEQUENCE");
    expect(sql).not.toContain("CREATE SEQUENCE");

    const attachedToUsers = await inspectSequenceState(client);
    await expect(
      service.apply(updatedSchema, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: expect.arrayContaining([
        'ALTER SEQUENCE "user_seq" OWNED BY NONE;',
      ]),
    });
    expect(await inspectSequenceState(client)).toEqual(attachedToUsers);

    await service.apply(updatedSchema, ["public"], true);
    const after = await client.query(
      "SELECT 'public.user_seq'::regclass::oid::integer AS oid, nextval('public.user_seq') AS value"
    );
    expect(after.rows[0]).toEqual({
      oid: before.rows[0]?.oid,
      value: "2",
    });
    expect(
      (await service.apply(updatedSchema, ["public"], true, undefined, true))
        .hasChanges
    ).toBe(false);

    const standaloneSchema = `
      CREATE TABLE users (id integer);
      CREATE TABLE accounts (id integer);
      CREATE SEQUENCE user_seq;
    `;
    const standalonePlan = await service.plan(standaloneSchema, ["public"]);
    const removalStatement =
      'ALTER SEQUENCE "user_seq" OWNED BY NONE;';
    expect(standalonePlan.transactional).toContain(removalStatement);
    expect(getStatementRisk(removalStatement, "transactional")).toBe(
      "destructive"
    );
    const attachedState = await inspectSequenceState(client);
    expect(attachedState.ownerTarget).toBe("public.accounts.id");
    await expect(
      service.apply(
        standaloneSchema,
        ["public"],
        true,
        undefined,
        false,
        true
      )
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: expect.arrayContaining([removalStatement]),
    });
    expect(await inspectSequenceState(client)).toEqual(attachedState);

    await service.apply(standaloneSchema, ["public"], true);
    expect(await inspectSequenceState(client)).toEqual({
      oid: attachedState.oid,
      ownerTarget: null,
      lastValue: "2",
      isCalled: true,
    });
    expect(
      (await service.plan(standaloneSchema, ["public"])).hasChanges
    ).toBe(false);
  });
});

async function inspectSequenceState(client: Client): Promise<{
  oid: number;
  ownerTarget: string | null;
  lastValue: string;
  isCalled: boolean;
}> {
  const result = await client.query(`
    SELECT
      sequence.oid::integer AS oid,
      owner_namespace.nspname || '.' || owner_table.relname || '.' ||
        owner_attribute.attname AS "ownerTarget",
      state.last_value::text AS "lastValue",
      state.is_called AS "isCalled"
    FROM pg_class sequence
    JOIN pg_namespace sequence_namespace
      ON sequence_namespace.oid = sequence.relnamespace
    CROSS JOIN public.user_seq state
    LEFT JOIN pg_depend dependency
      ON dependency.classid = 'pg_class'::regclass
      AND dependency.objid = sequence.oid
      AND dependency.deptype = 'a'
    LEFT JOIN pg_class owner_table ON owner_table.oid = dependency.refobjid
    LEFT JOIN pg_namespace owner_namespace
      ON owner_namespace.oid = owner_table.relnamespace
    LEFT JOIN pg_attribute owner_attribute
      ON owner_attribute.attrelid = owner_table.oid
      AND owner_attribute.attnum = dependency.refobjsubid
    WHERE sequence_namespace.nspname = 'public'
      AND sequence.relname = 'user_seq'
  `);
  return result.rows[0];
}
