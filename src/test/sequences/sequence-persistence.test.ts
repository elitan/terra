import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { DatabaseInspector } from "../../core/schema/inspector";
import { getStatementRisk } from "../../utils/statement-classifier";
import { cleanDatabase, createTestClient, createTestSchemaService } from "../utils";

const VERSION_15 = 150000;

async function getServerVersion(client: Client): Promise<number> {
  const result = await client.query(
    "SELECT current_setting('server_version_num')::integer AS version"
  );
  return Number(result.rows[0]?.version);
}

async function getRelationPersistence(
  client: Client,
  relationName: string
): Promise<{ oid: number; persistence: string } | undefined> {
  const result = await client.query(
    `SELECT relation.oid::integer AS oid, relation.relpersistence AS persistence
     FROM pg_class relation
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public' AND relation.relname = $1`,
    [relationName]
  );
  return result.rows[0];
}

describe("PostgreSQL sequence persistence and state-preserving evolution", function () {
  let client: Client;
  let postgresVersionNum: number;

  beforeEach(async function prepareDatabase() {
    client = await createTestClient();
    await cleanDatabase(client, ["public"]);
    postgresVersionNum = await getServerVersion(client);
  });

  afterEach(async function cleanUpDatabase() {
    await cleanDatabase(client, ["public"]);
    await client.end();
  });

  test("supports unlogged standalone sequences only on PostgreSQL 15+", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE UNLOGGED SEQUENCE public."Event Sequence ✓"
        AS BIGINT START WITH 20 INCREMENT BY 3 CACHE 2;
    `;

    if (postgresVersionNum < VERSION_15) {
      await expect(service.apply(desired, ["public"], true)).rejects.toThrow(
        /PostgreSQL 14 does not support unlogged sequences/i
      );
      expect(
        await getRelationPersistence(client, "Event Sequence ✓")
      ).toBeUndefined();
      return;
    }

    await service.apply(desired, ["public"], true);
    expect(await getRelationPersistence(client, "Event Sequence ✓")).toMatchObject({
      persistence: "u",
    });
    const inspected = await new DatabaseInspector().getCurrentSequences(client);
    expect(inspected).toEqual([
      expect.objectContaining({
        name: "Event Sequence ✓",
        unlogged: true,
      }),
    ]);
    expect(
      (await service.apply(desired, ["public"], true, undefined, true)).hasChanges
    ).toBe(false);
  });

  test("converges an externally created unlogged sequence", async function () {
    if (postgresVersionNum < VERSION_15) return;
    await client.query(`
      CREATE UNLOGGED SEQUENCE public.external_unlogged_seq
        START WITH 40 INCREMENT BY 4 CACHE 3;
    `);
    const service = createTestSchemaService();
    const plan = await service.apply(
      `CREATE UNLOGGED SEQUENCE public.external_unlogged_seq
        START WITH 40 INCREMENT BY 4 CACHE 3;`,
      ["public"],
      true,
      undefined,
      true
    );

    expect(plan.hasChanges).toBe(false);
  });

  test("alters sequence definitions without replacing identity or runtime state", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SEQUENCE public.stateful_seq
        AS BIGINT START WITH 10 INCREMENT BY 2 CACHE 1 NO CYCLE;
    `;
    const changed = `
      CREATE ${postgresVersionNum >= VERSION_15 ? "UNLOGGED " : ""}SEQUENCE public.stateful_seq
        AS BIGINT START WITH 100 INCREMENT BY 5 CACHE 4 CYCLE;
    `;
    await service.apply(initial, ["public"], true);
    expect((await client.query("SELECT nextval('public.stateful_seq') AS value")).rows[0]?.value)
      .toBe("10");
    expect((await client.query("SELECT nextval('public.stateful_seq') AS value")).rows[0]?.value)
      .toBe("12");
    const before = await getRelationPersistence(client, "stateful_seq");

    const plan = await service.apply(
      changed,
      ["public"],
      true,
      undefined,
      true
    );
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ALTER SEQUENCE "public"."stateful_seq"');
    expect(sql).not.toContain("DROP SEQUENCE");
    expect(sql).not.toContain("CREATE SEQUENCE");
    if (postgresVersionNum >= VERSION_15) {
      expect(sql).toContain("SET UNLOGGED");
    }

    await service.apply(changed, ["public"], true);
    const after = await getRelationPersistence(client, "stateful_seq");
    expect(after?.oid).toBe(before?.oid);
    expect((await client.query("SELECT nextval('public.stateful_seq') AS value")).rows[0]?.value)
      .toBe("17");
    expect(
      (await service.apply(changed, ["public"], true, undefined, true)).hasChanges
    ).toBe(false);

    if (postgresVersionNum >= VERSION_15) {
      const relogged = changed.replace("CREATE UNLOGGED SEQUENCE", "CREATE SEQUENCE");
      const relogPlan = await service.apply(
        relogged,
        ["public"],
        true,
        undefined,
        true
      );
      expect(relogPlan.transactional).toEqual([
        'ALTER SEQUENCE "public"."stateful_seq" SET LOGGED;',
      ]);
      await service.apply(relogged, ["public"], true);
      expect(await getRelationPersistence(client, "stateful_seq")).toEqual({
        oid: before?.oid,
        persistence: "p",
      });
      expect(
        (await service.apply(relogged, ["public"], true, undefined, true))
          .hasChanges
      ).toBe(false);
    }
  });

  test("rolls a sequence alteration back when a later routine definition fails", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SEQUENCE public.sequence_rollback_guard
        AS BIGINT START WITH 10 INCREMENT BY 1 CACHE 1 NO CYCLE;
    `;
    const failing = `
      CREATE SEQUENCE public.sequence_rollback_guard
        AS BIGINT START WITH 10 INCREMENT BY 7 CACHE 4 CYCLE;

      CREATE FUNCTION public.sequence_rollback_invalid()
      RETURNS void
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE NOTICE;
      END;
      $$;
    `;

    await service.apply(initial, ["public"], true);
    await client.query("SELECT setval('public.sequence_rollback_guard', 42, true)");
    const before = await client.query(`
      SELECT relation.oid::integer AS oid,
             sequence.seqincrement::text AS increment,
             sequence.seqcache::text AS cache,
             sequence.seqcycle AS cycle,
             state.last_value::text AS last_value,
             state.is_called
      FROM pg_sequence sequence
      JOIN pg_class relation ON relation.oid = sequence.seqrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN public.sequence_rollback_guard state
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'sequence_rollback_guard'
    `);

    const plan = await service.plan(failing, ["public"]);
    const sequencePosition = plan.transactional.findIndex(function findsSequenceAlteration(statement) {
      return statement.startsWith('ALTER SEQUENCE "public"."sequence_rollback_guard"');
    });
    const functionPosition = plan.transactional.findIndex(function findsInvalidFunction(statement) {
      return statement.includes('CREATE FUNCTION "public"."sequence_rollback_invalid"');
    });
    expect(sequencePosition).toBeGreaterThanOrEqual(0);
    expect(functionPosition).toBeGreaterThan(sequencePosition);

    await expect(service.apply(failing, ["public"], true)).rejects.toThrow();
    const after = await client.query(`
      SELECT relation.oid::integer AS oid,
             sequence.seqincrement::text AS increment,
             sequence.seqcache::text AS cache,
             sequence.seqcycle AS cycle,
             state.last_value::text AS last_value,
             state.is_called
      FROM pg_sequence sequence
      JOIN pg_class relation ON relation.oid = sequence.seqrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN public.sequence_rollback_guard state
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'sequence_rollback_guard'
    `);
    expect(after.rows).toEqual(before.rows);
    expect((await service.plan(initial, ["public"])).hasChanges).toBe(false);
  });

  test("blocks standalone sequence type changes in strict mode", async function () {
    const service = createTestSchemaService();
    const bigintSchema = `
      CREATE SEQUENCE public.sequence_type_guard_seq
        AS BIGINT
        START WITH 10
        INCREMENT BY 5
        MINVALUE 1
        MAXVALUE 1000
        CACHE 1
        NO CYCLE;
    `;
    const smallintSchema = `
      CREATE SEQUENCE public.sequence_type_guard_seq
        AS SMALLINT
        START WITH 10
        INCREMENT BY 7
        MINVALUE 1
        MAXVALUE 1000
        CACHE 2
        NO CYCLE;
    `;
    const widenedSchema = `
      CREATE SEQUENCE public.sequence_type_guard_seq
        AS BIGINT
        START WITH 10
        INCREMENT BY 7
        MINVALUE 1
        MAXVALUE 1000
        CACHE 2
        NO CYCLE;
    `;

    async function getTypeGuardState() {
      return (
        await client.query(`
          SELECT relation.oid::integer AS oid,
                 format_type(sequence.seqtypid, NULL) AS data_type,
                 sequence.seqincrement::text AS increment,
                 sequence.seqmin::text AS min_value,
                 sequence.seqmax::text AS max_value,
                 sequence.seqstart::text AS start_value,
                 sequence.seqcache::text AS cache,
                 sequence.seqcycle AS cycle,
                 state.last_value::text AS last_value,
                 state.is_called
          FROM pg_sequence sequence
          JOIN pg_class relation ON relation.oid = sequence.seqrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          CROSS JOIN public.sequence_type_guard_seq state
          WHERE namespace.nspname = 'public'
            AND relation.relname = 'sequence_type_guard_seq'
        `)
      ).rows;
    }

    await service.apply(bigintSchema, ["public"], true);
    await client.query(
      "SELECT setval('public.sequence_type_guard_seq', 25, true)"
    );
    const before = await getTypeGuardState();
    const plan = await service.plan(smallintSchema, ["public"]);
    expect(plan.transactional).toHaveLength(1);
    expect(plan.transactional[0]).toContain("AS SMALLINT");
    expect(plan.transactional[0]).toContain("CACHE 2");
    expect(getStatementRisk(plan.transactional[0]!, "transactional")).toBe(
      "destructive"
    );

    await expect(
      service.apply(
        smallintSchema,
        ["public"],
        true,
        undefined,
        false,
        true
      )
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: plan.transactional,
    });
    expect(await getTypeGuardState()).toEqual(before);

    await service.apply(smallintSchema, ["public"], true);
    const narrowed = await getTypeGuardState();
    expect(narrowed).toEqual([
      {
        oid: before[0]?.oid,
        data_type: "smallint",
        increment: "7",
        min_value: "1",
        max_value: "1000",
        start_value: "10",
        cache: "2",
        cycle: false,
        last_value: "25",
        is_called: true,
      },
    ]);
    const next = await client.query(
      "SELECT nextval('public.sequence_type_guard_seq')::text AS value"
    );
    expect(next.rows).toEqual([{ value: "32" }]);
    expect((await service.plan(smallintSchema, ["public"])).hasChanges).toBe(
      false
    );

    const widenPlan = await service.plan(widenedSchema, ["public"]);
    expect(widenPlan.transactional).toHaveLength(1);
    expect(widenPlan.transactional[0]).toContain("AS BIGINT");
    expect(
      getStatementRisk(widenPlan.transactional[0]!, "transactional")
    ).toBe("destructive");
    await service.apply(widenedSchema, ["public"], true);
    expect((await getTypeGuardState())[0]).toMatchObject({
      oid: before[0]?.oid,
      data_type: "bigint",
    });
    expect((await service.plan(widenedSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("blocks weakening sequence durability in strict mode", async function () {
    if (postgresVersionNum < VERSION_15) return;
    const service = createTestSchemaService();
    const logged = `
      CREATE SEQUENCE public.persistence_strict_seq
        AS BIGINT START WITH 10 INCREMENT BY 2 CACHE 1;
    `;
    const unlogged = logged.replace(
      "CREATE SEQUENCE",
      "CREATE UNLOGGED SEQUENCE"
    );

    await service.apply(logged, ["public"], true);
    expect(
      (
        await client.query(
          "SELECT nextval('public.persistence_strict_seq') AS value"
        )
      ).rows[0]?.value
    ).toBe("10");
    const before = await getRelationPersistence(
      client,
      "persistence_strict_seq"
    );
    expect(before).toMatchObject({ persistence: "p" });
    const plan = await service.plan(unlogged, ["public"]);
    expect(plan.transactional).toEqual([
      'ALTER SEQUENCE "public"."persistence_strict_seq" SET UNLOGGED;',
    ]);

    await expect(
      service.apply(unlogged, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: plan.transactional,
    });

    expect(
      await getRelationPersistence(client, "persistence_strict_seq")
    ).toEqual(before);
    expect(
      (
        await client.query(
          "SELECT nextval('public.persistence_strict_seq') AS value"
        )
      ).rows[0]?.value
    ).toBe("12");
    expect((await service.plan(logged, ["public"])).hasChanges).toBe(false);
  });

  test("blocks enabling sequence wraparound without applying safe definition changes", async function () {
    await client.query(`
      CREATE SEQUENCE public.cycle_guard_seq
        AS BIGINT MINVALUE 1 MAXVALUE 3 START WITH 1 INCREMENT BY 1 CACHE 1 NO CYCLE;
      SELECT setval('public.cycle_guard_seq', 2, true);
    `);
    const desired = `
      CREATE SEQUENCE public.cycle_guard_seq
        AS BIGINT MINVALUE 1 MAXVALUE 5 START WITH 1 INCREMENT BY 1 CACHE 1 CYCLE;
    `;
    const service = createTestSchemaService();
    const beforeRelation = await getRelationPersistence(
      client,
      "cycle_guard_seq"
    );
    const beforeDefinition = (
      await client.query(`
        SELECT sequence.seqmax::text AS max_value, sequence.seqcycle AS cycle
        FROM pg_sequence sequence
        JOIN pg_class relation ON relation.oid = sequence.seqrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'cycle_guard_seq'
      `)
    ).rows;
    const beforeValue = (
      await client.query(
        "SELECT last_value::text AS last_value, is_called FROM public.cycle_guard_seq"
      )
    ).rows;

    const plan = await service.plan(desired, ["public"]);
    expect(plan.transactional).toHaveLength(2);
    const cycleStatement =
      'ALTER SEQUENCE "public"."cycle_guard_seq" CYCLE;';
    expect(plan.transactional[1]).toBe(cycleStatement);
    expect(getStatementRisk(plan.transactional[0]!, "transactional")).toBe(
      "safe"
    );
    expect(getStatementRisk(cycleStatement, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(desired, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: [cycleStatement],
    });

    expect(await getRelationPersistence(client, "cycle_guard_seq")).toEqual(
      beforeRelation
    );
    expect(
      (
        await client.query(`
          SELECT sequence.seqmax::text AS max_value, sequence.seqcycle AS cycle
          FROM pg_sequence sequence
          JOIN pg_class relation ON relation.oid = sequence.seqrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = 'cycle_guard_seq'
        `)
      ).rows
    ).toEqual(beforeDefinition);
    expect(
      (
        await client.query(
          "SELECT last_value::text AS last_value, is_called FROM public.cycle_guard_seq"
        )
      ).rows
    ).toEqual(beforeValue);

    await service.apply(desired, ["public"], true);
    expect(await getRelationPersistence(client, "cycle_guard_seq")).toEqual(
      beforeRelation
    );
    expect(
      (
        await client.query(`
          SELECT sequence.seqmax::text AS max_value, sequence.seqcycle AS cycle
          FROM pg_sequence sequence
          JOIN pg_class relation ON relation.oid = sequence.seqrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = 'cycle_guard_seq'
        `)
      ).rows
    ).toEqual([{ max_value: "5", cycle: true }]);
    expect(
      (
        await client.query(
          "SELECT nextval('public.cycle_guard_seq')::text AS value FROM generate_series(1, 4)"
        )
      ).rows
    ).toEqual([
      { value: "3" },
      { value: "4" },
      { value: "5" },
      { value: "1" },
    ]);
    expect((await service.plan(desired, ["public"])).hasChanges).toBe(false);

    const noCycle = desired.replace(" CACHE 1 CYCLE", " CACHE 1 NO CYCLE");
    const noCyclePlan = await service.plan(noCycle, ["public"]);
    expect(noCyclePlan.transactional).toEqual([
      'ALTER SEQUENCE "public"."cycle_guard_seq" NO CYCLE;',
    ]);
    expect(
      getStatementRisk(noCyclePlan.transactional[0]!, "transactional")
    ).toBe("safe");
    await service.apply(
      noCycle,
      ["public"],
      true,
      undefined,
      false,
      true
    );
    expect((await service.plan(noCycle, ["public"])).hasChanges).toBe(false);
  });

  test("round-trips exact bigint bounds beyond safe JavaScript integers", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SEQUENCE public.bigint_boundary_seq
        AS BIGINT
        MINVALUE -9223372036854775808
        MAXVALUE 9223372036854775807
        START WITH 9223372036854775806
        INCREMENT BY 1
        NO CYCLE;
    `;

    await service.apply(desired, ["public"], true);
    const catalog = await client.query(`
      SELECT minimum_value::text AS minimum_value,
             maximum_value::text AS maximum_value,
             start_value::text AS start_value
      FROM information_schema.sequences
      WHERE sequence_schema = 'public'
        AND sequence_name = 'bigint_boundary_seq'
    `);
    expect(catalog.rows).toEqual([
      {
        minimum_value: "-9223372036854775808",
        maximum_value: "9223372036854775807",
        start_value: "9223372036854775806",
      },
    ]);
    expect(
      (await service.apply(desired, ["public"], true, undefined, true))
        .hasChanges
    ).toBe(false);
  });

  test("round-trips an exact bigint increment beyond safe JavaScript integers", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SEQUENCE public.bigint_increment_seq
        AS BIGINT
        INCREMENT BY 9223372036854775807
        MINVALUE -9223372036854775808
        MAXVALUE 9223372036854775807
        START WITH -9223372036854775808
        NO CYCLE;
    `;

    await service.apply(desired, ["public"], true);
    const catalog = await client.query(`
      SELECT increment_by::text AS increment_by
      FROM pg_sequences
      WHERE schemaname = 'public'
        AND sequencename = 'bigint_increment_seq'
    `);
    expect(catalog.rows).toEqual([
      { increment_by: "9223372036854775807" },
    ]);
    expect(
      (await service.apply(desired, ["public"], true, undefined, true))
        .hasChanges
    ).toBe(false);
  });

  test("tracks explicit identity-sequence persistence with version-safe behavior", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE TABLE public.identity_persistence (
        id bigint GENERATED ALWAYS AS IDENTITY (UNLOGGED),
        label text NOT NULL
      );
    `;

    if (postgresVersionNum < VERSION_15) {
      await expect(service.apply(desired, ["public"], true)).rejects.toThrow(
        /PostgreSQL 14 does not support explicit identity-sequence persistence/i
      );
      expect(
        await getRelationPersistence(client, "identity_persistence")
      ).toBeUndefined();
      return;
    }

    await service.apply(desired, ["public"], true);
    const inspected = await new DatabaseInspector().getCurrentSchema(client);
    const table = inspected.find(function findTable(candidate) {
      return candidate.name === "identity_persistence";
    });
    const id = table?.columns.find(function findId(column) {
      return column.name === "id";
    });
    expect(id?.identity?.sequencePersistence).toBe("unlogged");
    expect(
      (await service.apply(desired, ["public"], true, undefined, true)).hasChanges
    ).toBe(false);
  });

  test("repairs external identity persistence drift without replacing its sequence", async function () {
    if (postgresVersionNum < VERSION_15) return;
    const service = createTestSchemaService();
    const desired = `
      CREATE TABLE public.identity_drift (
        id bigint GENERATED ALWAYS AS IDENTITY,
        label text NOT NULL
      );
    `;
    await service.apply(desired, ["public"], true);
    const sequenceName = "identity_drift_id_seq";
    await client.query(
      'ALTER SEQUENCE public."identity_drift_id_seq" SET UNLOGGED'
    );
    const before = await getRelationPersistence(client, sequenceName);

    const plan = await service.apply(
      desired,
      ["public"],
      true,
      undefined,
      true
    );
    expect(plan.transactional.join("\n")).toContain(
      'ALTER SEQUENCE "public"."identity_drift_id_seq" SET LOGGED;'
    );
    expect(plan.transactional.join("\n")).not.toContain("DROP IDENTITY");
    await service.apply(desired, ["public"], true);

    const after = await getRelationPersistence(client, sequenceName);
    expect(after).toEqual({ oid: before?.oid, persistence: "p" });
    expect(
      (await service.apply(desired, ["public"], true, undefined, true)).hasChanges
    ).toBe(false);
  });

  test("keeps implicit identity persistence aligned with its table by version", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE TABLE public.unlogged_identity_table (
        id bigint GENERATED ALWAYS AS IDENTITY,
        label text NOT NULL
      );
    `;
    const desired = `
      CREATE UNLOGGED TABLE public.unlogged_identity_table (
        id bigint GENERATED ALWAYS AS IDENTITY,
        label text NOT NULL
      );
    `;
    await service.apply(initial, ["public"], true);
    const before = await getRelationPersistence(
      client,
      "unlogged_identity_table_id_seq"
    );
    const plan = await service.apply(
      desired,
      ["public"],
      true,
      undefined,
      true
    );
    expect(plan.transactional.join("\n")).toContain(
      'ALTER TABLE "public"."unlogged_identity_table" SET UNLOGGED;'
    );
    await service.apply(desired, ["public"], true);

    const after =
      await getRelationPersistence(client, "unlogged_identity_table_id_seq")
    expect(after).toMatchObject({
      oid: before?.oid,
      persistence: postgresVersionNum >= VERSION_15 ? "u" : "p",
    });
    expect(
      (await service.apply(desired, ["public"], true, undefined, true)).hasChanges
    ).toBe(false);
  });

  test("applies explicit identity persistence after a table persistence change", async function () {
    if (postgresVersionNum < VERSION_15) return;
    const service = createTestSchemaService();
    const initial = `
      CREATE TABLE public.explicit_identity_override (
        id bigint GENERATED ALWAYS AS IDENTITY (UNLOGGED)
      );
    `;
    const desired = `
      CREATE UNLOGGED TABLE public.explicit_identity_override (
        id bigint GENERATED ALWAYS AS IDENTITY (LOGGED)
      );
    `;
    await service.apply(initial, ["public"], true);

    const plan = await service.apply(
      desired,
      ["public"],
      true,
      undefined,
      true
    );
    const sql = plan.transactional.join("\n");
    expect(sql.indexOf("ALTER TABLE")).toBeLessThan(
      sql.indexOf("ALTER SEQUENCE")
    );
    await service.apply(desired, ["public"], true);

    expect(
      await getRelationPersistence(client, "explicit_identity_override_id_seq")
    ).toMatchObject({ persistence: "p" });
    expect(
      (await service.apply(desired, ["public"], true, undefined, true)).hasChanges
    ).toBe(false);
  });
});
