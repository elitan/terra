import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { DatabaseInspector } from "../../core/schema/inspector";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

const EVENT_TRIGGER_NAME = "terradb_trigger_mode_event";

describe("PostgreSQL trigger semantics", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await client.query(
      `DROP EVENT TRIGGER IF EXISTS ${client.escapeIdentifier(EVENT_TRIGGER_NAME)}`
    );
    await cleanDatabase(client);
  });

  afterEach(async function () {
    try {
      await client.query("SET session_replication_role = origin");
      await client.query(
        `DROP EVENT TRIGGER IF EXISTS ${client.escapeIdentifier(EVENT_TRIGGER_NAME)}`
      );
      await cleanDatabase(client);
    } finally {
      await client.end();
    }
  });

  test("preserves update columns, transition tables, firing behavior, and native mode changes", async function () {
    const service = createTestSchemaService();
    const replicaSchema = `
      CREATE TABLE public.trigger_events (
        trigger_name text NOT NULL
      );

      CREATE TABLE public.trigger_subject (
        id integer PRIMARY KEY,
        name text,
        status text
      );

      CREATE FUNCTION public.capture_trigger_event()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        INSERT INTO public.trigger_events(trigger_name) VALUES (TG_NAME);
        RETURN NULL;
      END;
      $$;

      CREATE TRIGGER column_audit
        AFTER UPDATE OF name, status ON public.trigger_subject
        FOR EACH ROW
        EXECUTE FUNCTION public.capture_trigger_event();
      ALTER TABLE public.trigger_subject
        ENABLE REPLICA TRIGGER column_audit;

      CREATE TRIGGER transition_audit
        AFTER UPDATE ON public.trigger_subject
        REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
        FOR EACH STATEMENT
        EXECUTE FUNCTION public.capture_trigger_event();
    `;

    await service.apply(replicaSchema, ["public"], true);

    const inspected = await new DatabaseInspector().getCurrentTriggers(
      client,
      ["public"]
    );
    expect(inspected.find(function findColumnAudit(trigger) {
      return trigger.name === "column_audit";
    })).toMatchObject({
      updateColumns: ["name", "status"],
      enabled: "replica",
    });
    expect(inspected.find(function findTransitionAudit(trigger) {
      return trigger.name === "transition_audit";
    })).toMatchObject({
      oldTransitionTable: "old_rows",
      newTransitionTable: "new_rows",
    });
    expect((await service.plan(replicaSchema, ["public"])).hasChanges).toBe(
      false
    );

    await client.query(
      "INSERT INTO public.trigger_subject(id, name, status) VALUES (1, 'a', 'new')"
    );
    await client.query(
      "UPDATE public.trigger_subject SET name = 'origin' WHERE id = 1"
    );
    expect(
      await triggerFireCount(client, "column_audit")
    ).toBe(0);

    await client.query("SET session_replication_role = replica");
    await client.query(
      "UPDATE public.trigger_subject SET status = 'replica' WHERE id = 1"
    );
    await client.query("SET session_replication_role = origin");
    expect(
      await triggerFireCount(client, "column_audit")
    ).toBe(1);

    const alwaysSchema = replicaSchema.replace(
      "ENABLE REPLICA TRIGGER column_audit",
      "ENABLE ALWAYS TRIGGER column_audit"
    );
    const alwaysPlan = await service.plan(alwaysSchema, ["public"]);
    expect(alwaysPlan.transactional).toEqual([
      'ALTER TABLE "public"."trigger_subject" ENABLE ALWAYS TRIGGER "column_audit";',
    ]);
    await service.apply(alwaysSchema, ["public"], true);

    const originSchema = alwaysSchema.replace(
      /\s*ALTER TABLE public\.trigger_subject\s+ENABLE ALWAYS TRIGGER column_audit;/,
      ""
    );
    const originPlan = await service.plan(originSchema, ["public"]);
    expect(originPlan.transactional).toEqual([
      'ALTER TABLE "public"."trigger_subject" ENABLE TRIGGER "column_audit";',
    ]);
    await service.apply(originSchema, ["public"], true);
    expect((await service.plan(originSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("blocks trigger enforcement weakening in strict mode", async function () {
    const service = createTestSchemaService();
    const baseline = `
      CREATE TABLE public.trigger_strict_events (
        kind text NOT NULL
      );

      CREATE TABLE public.trigger_strict_subject (
        id integer PRIMARY KEY
      );

      CREATE FUNCTION public.capture_trigger_strict_row()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        INSERT INTO public.trigger_strict_events(kind) VALUES ('row');
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trigger_strict_audit
        AFTER INSERT ON public.trigger_strict_subject
        FOR EACH ROW
        EXECUTE FUNCTION public.capture_trigger_strict_row();

      CREATE FUNCTION public.capture_trigger_strict_ddl()
      RETURNS event_trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        INSERT INTO public.trigger_strict_events(kind) VALUES ('event');
      END;
      $$;

      CREATE EVENT TRIGGER ${EVENT_TRIGGER_NAME}
        ON ddl_command_end
        EXECUTE FUNCTION public.capture_trigger_strict_ddl();
    `;
    const weakeningCases = [
      {
        tableMode: "DISABLE TRIGGER trigger_strict_audit",
        eventMode: `ALTER EVENT TRIGGER ${EVENT_TRIGGER_NAME} ENABLE REPLICA`,
        statements: [
          'ALTER TABLE "public"."trigger_strict_subject" DISABLE TRIGGER "trigger_strict_audit";',
          `ALTER EVENT TRIGGER "${EVENT_TRIGGER_NAME}" ENABLE REPLICA;`,
        ],
      },
      {
        tableMode: "ENABLE REPLICA TRIGGER trigger_strict_audit",
        eventMode: `ALTER EVENT TRIGGER ${EVENT_TRIGGER_NAME} DISABLE`,
        statements: [
          'ALTER TABLE "public"."trigger_strict_subject" ENABLE REPLICA TRIGGER "trigger_strict_audit";',
          `ALTER EVENT TRIGGER "${EVENT_TRIGGER_NAME}" DISABLE;`,
        ],
      },
    ];

    await service.apply(baseline, ["public"], true);
    await client.query("DELETE FROM public.trigger_strict_events");

    for (const weakening of weakeningCases) {
      const desired = `${baseline}
        ALTER TABLE public.trigger_strict_subject
          ${weakening.tableMode};
        ${weakening.eventMode};
      `;
      const plan = await service.plan(desired, ["public"]);
      expect(plan.transactional).toEqual(weakening.statements);
      await expect(
        service.apply(desired, ["public"], true, undefined, false, true)
      ).rejects.toMatchObject({
        code: "STRICT_MODE_ERROR",
        statements: weakening.statements,
      });
    }

    const tableMode = await client.query(`
      SELECT t.tgenabled
      FROM pg_trigger t
      WHERE t.tgname = 'trigger_strict_audit'
        AND NOT t.tgisinternal
    `);
    const eventMode = await client.query(
      "SELECT evtenabled FROM pg_event_trigger WHERE evtname = $1",
      [EVENT_TRIGGER_NAME]
    );
    expect(tableMode.rows).toEqual([{ tgenabled: "O" }]);
    expect(eventMode.rows).toEqual([{ evtenabled: "O" }]);

    await client.query(
      "INSERT INTO public.trigger_strict_subject(id) VALUES (1)"
    );
    await client.query("CREATE TABLE public.trigger_strict_probe (id integer)");
    const events = await client.query(`
      SELECT kind, count(*)::integer AS count
      FROM public.trigger_strict_events
      GROUP BY kind
      ORDER BY kind
    `);
    expect(events.rows).toEqual([
      { kind: "event", count: 1 },
      { kind: "row", count: 1 },
    ]);
    await client.query("DROP TABLE public.trigger_strict_probe");
    expect((await service.plan(baseline, ["public"])).hasChanges).toBe(false);
  });

  test("ignores implementation-owned partition trigger clones", async function () {
    const service = createTestSchemaService();
    const schema = `
      CREATE TABLE public.trigger_partitioned (id integer)
        PARTITION BY RANGE (id);
      CREATE TABLE public.trigger_partitioned_low
        PARTITION OF public.trigger_partitioned
        FOR VALUES FROM (0) TO (100);

      CREATE FUNCTION public.partition_trigger_function()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER partition_audit
        BEFORE INSERT ON public.trigger_partitioned
        FOR EACH ROW
        EXECUTE FUNCTION public.partition_trigger_function();
    `;

    await service.apply(schema, ["public"], true);

    const catalog = await client.query(`
      SELECT t.tgparentid
      FROM pg_trigger t
      WHERE t.tgname = 'partition_audit'
      ORDER BY t.tgparentid
    `);
    expect(catalog.rows).toHaveLength(2);
    expect(catalog.rows.some(function isClone(row) {
      return String(row.tgparentid) !== "0";
    })).toBe(true);

    const inspected = await new DatabaseInspector().getCurrentTriggers(
      client,
      ["public"]
    );
    expect(inspected.filter(function isPartitionAudit(trigger) {
      return trigger.name === "partition_audit";
    })).toHaveLength(1);
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);

    await client.query(`
      ALTER TABLE ONLY public.trigger_partitioned_low
        DISABLE TRIGGER partition_audit
    `);
    await expect(service.plan(schema, ["public"])).rejects.toThrow(
      /partition trigger clones.*differ from their parent/i
    );
  });

  test("distinguishes whitespace inside constraint trigger arguments", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE TABLE public.trigger_argument_events (value text NOT NULL);
      CREATE TABLE public.trigger_argument_subject (id integer PRIMARY KEY);

      CREATE FUNCTION public.capture_constraint_argument()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        INSERT INTO public.trigger_argument_events(value)
        VALUES (TG_ARGV[0] || '|' || TG_ARGV[1]);
        RETURN NULL;
      END;
      $$;

      CREATE CONSTRAINT TRIGGER argument_audit
        AFTER INSERT ON public.trigger_argument_subject
        FOR EACH ROW
        EXECUTE FUNCTION public.capture_constraint_argument(
          'alpha beta', 'EXECUTE PROCEDURE'
        );
    `;
    const changed = initial
      .replace("alpha beta", "alpha  beta")
      .replace("'EXECUTE PROCEDURE'", "'EXECUTE FUNCTION'");

    await service.apply(initial, ["public"], true);
    await client.query(
      "INSERT INTO public.trigger_argument_subject(id) VALUES (1)"
    );
    expect(
      (await client.query(
        "SELECT value FROM public.trigger_argument_events ORDER BY ctid"
      )).rows
    ).toEqual([{ value: "alpha beta|EXECUTE PROCEDURE" }]);

    const plan = await service.plan(changed, ["public"]);
    expect(plan.transactional).toContain(
      'DROP TRIGGER IF EXISTS "argument_audit" ON "public"."trigger_argument_subject";'
    );
    expect(plan.transactional.some(function createsChangedTrigger(statement) {
      return (
        statement.includes("CREATE CONSTRAINT TRIGGER argument_audit") &&
        statement.includes("'alpha  beta'") &&
        statement.includes("'EXECUTE FUNCTION'")
      );
    })).toBe(true);

    await service.apply(changed, ["public"], true);
    await client.query(
      "INSERT INTO public.trigger_argument_subject(id) VALUES (2)"
    );
    expect(
      (await client.query(
        "SELECT value FROM public.trigger_argument_events ORDER BY ctid"
      )).rows
    ).toEqual([
      { value: "alpha beta|EXECUTE PROCEDURE" },
      { value: "alpha  beta|EXECUTE FUNCTION" },
    ]);
    expect((await service.plan(changed, ["public"])).hasChanges).toBe(false);
  });

  test("preserves constraint and event trigger firing modes", async function () {
    const service = createTestSchemaService();
    const schema = `
      CREATE TABLE public.trigger_mode_subject (id integer);

      CREATE FUNCTION public.constraint_trigger_function()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN NULL;
      END;
      $$;

      CREATE CONSTRAINT TRIGGER constraint_audit
        AFTER INSERT ON public.trigger_mode_subject
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION public.constraint_trigger_function();
      ALTER TABLE public.trigger_mode_subject
        DISABLE TRIGGER constraint_audit;

      CREATE FUNCTION public.event_trigger_function()
      RETURNS event_trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN;
      END;
      $$;

      CREATE EVENT TRIGGER ${EVENT_TRIGGER_NAME}
        ON ddl_command_end
        EXECUTE FUNCTION public.event_trigger_function();
      ALTER EVENT TRIGGER ${EVENT_TRIGGER_NAME} ENABLE REPLICA;
    `;

    await service.apply(schema, ["public"], true);

    const constraintMode = await client.query(`
      SELECT t.tgenabled
      FROM pg_trigger t
      WHERE t.tgname = 'constraint_audit'
        AND NOT t.tgisinternal
    `);
    const eventMode = await client.query(
      "SELECT evtenabled FROM pg_event_trigger WHERE evtname = $1",
      [EVENT_TRIGGER_NAME]
    );
    expect(constraintMode.rows).toEqual([{ tgenabled: "D" }]);
    expect(eventMode.rows).toEqual([{ evtenabled: "R" }]);
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);

    const changedSchema = schema
      .replace(
        "DISABLE TRIGGER constraint_audit",
        "ENABLE ALWAYS TRIGGER constraint_audit"
      )
      .replace(
        `ALTER EVENT TRIGGER ${EVENT_TRIGGER_NAME} ENABLE REPLICA`,
        `ALTER EVENT TRIGGER ${EVENT_TRIGGER_NAME} DISABLE`
      );
    const changedPlan = await service.plan(changedSchema, ["public"]);
    expect(changedPlan.transactional).toEqual([
      'ALTER TABLE "public"."trigger_mode_subject" ENABLE ALWAYS TRIGGER "constraint_audit";',
      `ALTER EVENT TRIGGER "${EVENT_TRIGGER_NAME}" DISABLE;`,
    ]);
    await service.apply(changedSchema, ["public"], true);

    const changedConstraintMode = await client.query(`
      SELECT t.tgenabled
      FROM pg_trigger t
      WHERE t.tgname = 'constraint_audit'
        AND NOT t.tgisinternal
    `);
    const changedEventMode = await client.query(
      "SELECT evtenabled FROM pg_event_trigger WHERE evtname = $1",
      [EVENT_TRIGGER_NAME]
    );
    expect(changedConstraintMode.rows).toEqual([{ tgenabled: "A" }]);
    expect(changedEventMode.rows).toEqual([{ evtenabled: "D" }]);
    expect((await service.plan(changedSchema, ["public"])).hasChanges).toBe(
      false
    );
  });
});

async function triggerFireCount(
  client: Client,
  triggerName: string
): Promise<number> {
  const result = await client.query(
    `SELECT count(*)::integer AS count
     FROM public.trigger_events
     WHERE trigger_name = $1`,
    [triggerName]
  );
  return result.rows[0]?.count || 0;
}
