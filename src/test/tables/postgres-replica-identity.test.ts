import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { DatabaseInspector } from "../../core/schema/inspector";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

describe("PostgreSQL replica identity lifecycle", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    try {
      await cleanDatabase(client);
    } finally {
      await client.end();
    }
  });

  test("creates, inspects, changes, removes, and reapplies table identities", async function () {
    const service = createTestSchemaService();
    const selectedSchema = `
      CREATE TABLE public.replica_records (
        id integer NOT NULL,
        value text
      );
      CREATE UNIQUE INDEX CONCURRENTLY replica_records_identity
        ON public.replica_records (id);
      ALTER TABLE public.replica_records
        REPLICA IDENTITY USING INDEX replica_records_identity;
    `;

    const createPlan = await service.plan(selectedSchema, ["public"]);
    expect(createPlan.concurrent).toEqual([
      'CREATE UNIQUE INDEX CONCURRENTLY "replica_records_identity" ON "public"."replica_records" ("id");',
    ]);
    expect(createPlan.deferred).toEqual([
      'ALTER TABLE "public"."replica_records" REPLICA IDENTITY USING INDEX "replica_records_identity";',
    ]);
    await service.apply(selectedSchema, ["public"], true);

    const inspected = await new DatabaseInspector().getCurrentSchema(
      client,
      ["public"]
    );
    expect(inspected.find(function findRecords(table) {
      return table.name === "replica_records";
    })).toHaveProperty("replicaIdentity", {
      mode: "index",
      indexName: "replica_records_identity",
    });
    expect((await service.plan(selectedSchema, ["public"])).hasChanges).toBe(
      false
    );

    const fullSchema = selectedSchema
      .replace(/CREATE UNIQUE INDEX[\s\S]*?\(id\);/, "")
      .replace(
        /REPLICA IDENTITY USING INDEX replica_records_identity/,
        "REPLICA IDENTITY FULL"
      );
    const fullPlan = await service.plan(fullSchema, ["public"]);
    expect(fullPlan.transactional).toContain(
      'ALTER TABLE "public"."replica_records" REPLICA IDENTITY FULL;'
    );
    expect(fullPlan.concurrent).toEqual([
      'DROP INDEX CONCURRENTLY "public"."replica_records_identity";',
    ]);
    await service.apply(fullSchema, ["public"], true);
    expect(await relationReplicaIdentity(client, "replica_records")).toBe(
      "f"
    );
    expect((await service.plan(fullSchema, ["public"])).hasChanges).toBe(
      false
    );

    const defaultSchema = fullSchema.replace(
      /\s*ALTER TABLE public\.replica_records\s+REPLICA IDENTITY FULL;/,
      ""
    );
    await service.apply(defaultSchema, ["public"], true);
    expect(await relationReplicaIdentity(client, "replica_records")).toBe(
      "d"
    );
    expect((await service.plan(defaultSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("resets and restores a selected identity around index replacement", async function () {
    const service = createTestSchemaService();
    const original = `
      CREATE TABLE public.replica_replace (
        id integer NOT NULL,
        value text
      );
      CREATE UNIQUE INDEX replica_replace_identity
        ON public.replica_replace (id) WITH (fillfactor = 90);
      ALTER TABLE public.replica_replace
        REPLICA IDENTITY USING INDEX replica_replace_identity;
    `;
    await service.apply(original, ["public"], true);

    const changed = original.replace("fillfactor = 90", "fillfactor = 80");
    const plan = await service.plan(changed, ["public"]);
    expect(plan.transactional[0]).toBe(
      'ALTER TABLE "public"."replica_replace" REPLICA IDENTITY DEFAULT;'
    );
    expect(plan.transactional).toContain(
      'DROP INDEX "public"."replica_replace_identity";'
    );
    expect(plan.deferred).toEqual([
      'ALTER TABLE "public"."replica_replace" REPLICA IDENTITY USING INDEX "replica_replace_identity";',
    ]);

    await service.apply(changed, ["public"], true);
    expect(await relationReplicaIdentity(client, "replica_replace")).toBe(
      "i"
    );
    expect((await service.plan(changed, ["public"])).hasChanges).toBe(false);
  });

  test("supports named constraint indexes, covering payloads, and quoted names", async function () {
    const service = createTestSchemaService();
    const schema = `
      CREATE TABLE public."Replica Constraint" (
        "Key" integer NOT NULL,
        payload text,
        CONSTRAINT "Replica Constraint Key"
          UNIQUE ("Key") INCLUDE (payload)
      );
      ALTER TABLE public."Replica Constraint"
        REPLICA IDENTITY USING INDEX "Replica Constraint Key";

      CREATE TABLE public.replica_nothing (id integer);
      ALTER TABLE public.replica_nothing REPLICA IDENTITY NOTHING;
    `;

    const plan = await service.plan(schema, ["public"]);
    expect(plan.transactional).toContain(
      'ALTER TABLE "public"."Replica Constraint" REPLICA IDENTITY USING INDEX "Replica Constraint Key";'
    );
    expect(plan.transactional).toContain(
      'ALTER TABLE "public"."replica_nothing" REPLICA IDENTITY NOTHING;'
    );
    expect(plan.deferred).toEqual([]);

    await service.apply(schema, ["public"], true);
    const inspected = await new DatabaseInspector().getCurrentSchema(
      client,
      ["public"]
    );
    expect(inspected.find(function findConstraintTable(table) {
      return table.name === "Replica Constraint";
    })).toHaveProperty("replicaIdentity", {
      mode: "index",
      indexName: "Replica Constraint Key",
    });
    expect(inspected.find(function findNothingTable(table) {
      return table.name === "replica_nothing";
    })).toHaveProperty("replicaIdentity", { mode: "nothing" });
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);
  });

  test("renames a selected constraint index without breaking its identity", async function () {
    const service = createTestSchemaService();
    const original = `
      CREATE TABLE public.replica_constraint_rename (
        id integer NOT NULL,
        CONSTRAINT replica_constraint_old UNIQUE (id)
      );
      ALTER TABLE public.replica_constraint_rename
        REPLICA IDENTITY USING INDEX replica_constraint_old;
    `;
    await service.apply(original, ["public"], true);

    const changed = original.replaceAll(
      "replica_constraint_old",
      "replica_constraint_new"
    );
    const plan = await service.plan(changed, ["public"]);
    expect(plan.transactional).toContain(
      'ALTER TABLE "public"."replica_constraint_rename" RENAME CONSTRAINT "replica_constraint_old" TO "replica_constraint_new";'
    );
    expect(plan.transactional).toContain(
      'ALTER TABLE "public"."replica_constraint_rename" REPLICA IDENTITY USING INDEX "replica_constraint_new";'
    );
    expect(plan.deferred).toEqual([]);

    await service.apply(changed, ["public"], true);
    expect(await selectedReplicaIdentityIndex(
      client,
      "replica_constraint_rename"
    )).toBe("replica_constraint_new");
    expect((await service.plan(changed, ["public"])).hasChanges).toBe(false);

    const rebuilt = changed.replace(
      "UNIQUE (id)",
      "UNIQUE (id) WITH (fillfactor = 80)"
    );
    const rebuildPlan = await service.plan(rebuilt, ["public"]);
    expect(rebuildPlan.transactional[0]).toBe(
      'ALTER TABLE "public"."replica_constraint_rename" REPLICA IDENTITY DEFAULT;'
    );
    expect(rebuildPlan.transactional.some(function dropsConstraint(statement) {
      return statement.includes(
        'DROP CONSTRAINT "replica_constraint_new"'
      );
    })).toBe(true);
    expect(rebuildPlan.transactional.at(-1)).toBe(
      'ALTER TABLE "public"."replica_constraint_rename" REPLICA IDENTITY USING INDEX "replica_constraint_new";'
    );
    expect(rebuildPlan.deferred).toEqual([]);

    await service.apply(rebuilt, ["public"], true);
    expect(await selectedReplicaIdentityIndex(
      client,
      "replica_constraint_rename"
    )).toBe("replica_constraint_new");
    expect((await service.plan(rebuilt, ["public"])).hasChanges).toBe(false);
  });

  test("repairs a selected identity whose index was dropped externally", async function () {
    const service = createTestSchemaService();
    await client.query(`
      CREATE TABLE public.replica_missing (id integer NOT NULL);
      CREATE UNIQUE INDEX replica_missing_identity
        ON public.replica_missing (id);
      ALTER TABLE public.replica_missing
        REPLICA IDENTITY USING INDEX replica_missing_identity;
      DROP INDEX public.replica_missing_identity;
    `);

    expect(await relationReplicaIdentity(client, "replica_missing")).toBe(
      "i"
    );
    const inspected = await new DatabaseInspector().getCurrentSchema(
      client,
      ["public"]
    );
    expect(inspected[0]).toHaveProperty("replicaIdentity", {
      mode: "index-missing",
    });

    const schema = "CREATE TABLE public.replica_missing (id integer NOT NULL);";
    const plan = await service.plan(schema, ["public"]);
    expect(plan.transactional).toEqual([
      'ALTER TABLE "public"."replica_missing" REPLICA IDENTITY DEFAULT;',
    ]);
    await service.apply(schema, ["public"], true);
    expect(await relationReplicaIdentity(client, "replica_missing")).toBe(
      "d"
    );
  });

  test("preserves relation-local identities on partition parents and leaves", async function () {
    const service = createTestSchemaService();
    const schema = `
      CREATE TABLE public.replica_partitioned (
        id integer NOT NULL,
        CONSTRAINT replica_partitioned_identity UNIQUE (id)
      ) PARTITION BY RANGE (id);
      CREATE TABLE public.replica_partitioned_low
        PARTITION OF public.replica_partitioned
        FOR VALUES FROM (0) TO (100);
      ALTER TABLE public.replica_partitioned
        REPLICA IDENTITY USING INDEX replica_partitioned_identity;
      ALTER TABLE ONLY public.replica_partitioned_low
        REPLICA IDENTITY FULL;
    `;

    await service.apply(schema, ["public"], true);
    expect(await relationReplicaIdentity(client, "replica_partitioned")).toBe(
      "i"
    );
    expect(await relationReplicaIdentity(
      client,
      "replica_partitioned_low"
    )).toBe("f");
    const objects = await new DatabaseInspector().getCurrentSqlObjects(
      client,
      ["public"]
    );
    expect(objects.find(function findParent(object) {
      return object.key === "partition:public.replica_partitioned";
    })).toHaveProperty("replicaIdentity", {
      mode: "index",
      indexName: "replica_partitioned_identity",
    });
    expect(objects.find(function findLeaf(object) {
      return object.key === "partition:public.replica_partitioned_low";
    })).toHaveProperty("replicaIdentity", { mode: "full" });
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);

    const changed = schema
      .replace(
        /\s*ALTER TABLE public\.replica_partitioned\s+REPLICA IDENTITY USING INDEX replica_partitioned_identity;/,
        ""
      )
      .replace("REPLICA IDENTITY FULL", "REPLICA IDENTITY NOTHING");
    const changedPlan = await service.plan(changed, ["public"]);
    expect(changedPlan.transactional).toContain(
      'ALTER TABLE "public"."replica_partitioned" REPLICA IDENTITY DEFAULT;'
    );
    expect(changedPlan.transactional).toContain(
      'ALTER TABLE "public"."replica_partitioned_low" REPLICA IDENTITY NOTHING;'
    );

    await service.apply(changed, ["public"], true);
    expect(await relationReplicaIdentity(client, "replica_partitioned")).toBe(
      "d"
    );
    expect(await relationReplicaIdentity(
      client,
      "replica_partitioned_low"
    )).toBe("n");
    expect((await service.plan(changed, ["public"])).hasChanges).toBe(false);
  });

  test("rejects invalid selected-index candidates before mutation", async function () {
    const service = createTestSchemaService();
    const invalidSchemas = [
      `
        CREATE TABLE public.invalid_replica (id integer NOT NULL);
        CREATE INDEX invalid_replica_identity ON public.invalid_replica (id);
      `,
      `
        CREATE TABLE public.invalid_replica (id integer);
        CREATE UNIQUE INDEX invalid_replica_identity ON public.invalid_replica (id);
      `,
      `
        CREATE TABLE public.invalid_replica (id integer NOT NULL);
        CREATE UNIQUE INDEX invalid_replica_identity
          ON public.invalid_replica (id) WHERE id > 0;
      `,
      `
        CREATE TABLE public.invalid_replica (id integer NOT NULL);
        CREATE UNIQUE INDEX invalid_replica_identity
          ON public.invalid_replica ((id + 1));
      `,
      `
        CREATE TABLE public.invalid_replica (
          id integer NOT NULL,
          CONSTRAINT invalid_replica_identity
            UNIQUE (id) DEFERRABLE
        );
      `,
      `
        CREATE TABLE public.invalid_replica (id integer NOT NULL);
      `,
      `
        CREATE TABLE public.invalid_replica (
          id integer NOT NULL,
          CONSTRAINT invalid_replica_identity
            UNIQUE (id) DEFERRABLE
        ) PARTITION BY RANGE (id);
      `,
      `
        CREATE TABLE public.invalid_replica (
          id integer NOT NULL
        ) PARTITION BY RANGE (id);
      `,
      `
        CREATE TABLE public.invalid_replica (
          id integer,
          CONSTRAINT invalid_replica_identity UNIQUE (id)
        ) PARTITION BY RANGE (id);
      `,
      `
        CREATE TABLE public.invalid_replica (
          id integer NOT NULL,
          CONSTRAINT invalid_replica_identity
            PRIMARY KEY (id) DEFERRABLE
        ) PARTITION BY RANGE (id);
      `,
    ];

    for (const definition of invalidSchemas) {
      await expect(service.plan(`${definition}
        ALTER TABLE public.invalid_replica
          REPLICA IDENTITY USING INDEX invalid_replica_identity;
      `, ["public"])).rejects.toThrow(/replica identity index/i);
    }
    expect(await tableExists(client, "invalid_replica")).toBe(false);
  });
});

async function relationReplicaIdentity(
  client: Client,
  tableName: string
): Promise<string | undefined> {
  const result = await client.query(
    `SELECT relation.relreplident
     FROM pg_class relation
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = $1`,
    [tableName]
  );
  return result.rows[0]?.relreplident;
}

async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const result = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${tableName}`]
  );
  return result.rows[0]?.exists === true;
}

async function selectedReplicaIdentityIndex(
  client: Client,
  tableName: string
): Promise<string | undefined> {
  const result = await client.query(
    `SELECT index_relation.relname AS index_name
     FROM pg_index index_catalog
     JOIN pg_class relation ON relation.oid = index_catalog.indrelid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     JOIN pg_class index_relation
       ON index_relation.oid = index_catalog.indexrelid
     WHERE namespace.nspname = 'public'
       AND relation.relname = $1
       AND index_catalog.indisreplident`,
    [tableName]
  );
  return result.rows[0]?.index_name;
}
