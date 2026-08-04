import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { DatabaseInspector } from "../../core/schema/inspector";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

describe("PostgreSQL persistent clustering lifecycle", function () {
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

  test("creates, inspects, clears, and reapplies a table clustering choice", async function () {
    const service = createTestSchemaService();
    const selectedSchema = `
      CREATE TABLE public.cluster_records (
        id integer NOT NULL,
        value text
      );
      CREATE INDEX CONCURRENTLY cluster_records_order
        ON public.cluster_records ((lower(value)));
      ALTER TABLE public.cluster_records
        CLUSTER ON cluster_records_order;
    `;

    const createPlan = await service.plan(selectedSchema, ["public"]);
    expect(createPlan.concurrent).toEqual([
      'CREATE INDEX CONCURRENTLY "cluster_records_order" ON "public"."cluster_records" (lower(value));',
    ]);
    expect(createPlan.deferred).toEqual([
      'ALTER TABLE "public"."cluster_records" CLUSTER ON "cluster_records_order";',
    ]);
    await service.apply(selectedSchema, ["public"], true);

    const inspected = await new DatabaseInspector().getCurrentSchema(
      client,
      ["public"]
    );
    expect(inspected.find(function findRecords(table) {
      return table.name === "cluster_records";
    })).toHaveProperty("clusterIndex", "cluster_records_order");
    expect((await service.plan(selectedSchema, ["public"])).hasChanges).toBe(
      false
    );

    const clearedSchema = selectedSchema.replace(
      /\s*ALTER TABLE public\.cluster_records\s+CLUSTER ON cluster_records_order;/,
      ""
    );
    const clearPlan = await service.plan(clearedSchema, ["public"]);
    expect(clearPlan.transactional).toContain(
      'ALTER TABLE "public"."cluster_records" SET WITHOUT CLUSTER;'
    );
    await service.apply(clearedSchema, ["public"], true);
    expect(await selectedClusterIndex(client, "cluster_records")).toBe(
      undefined
    );
    expect((await service.plan(clearedSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("orders resets and assignments around an index shared with replica identity", async function () {
    const service = createTestSchemaService();
    const original = `
      CREATE TABLE public.cluster_replace (
        id integer NOT NULL,
        value text
      );
      CREATE UNIQUE INDEX cluster_replace_order
        ON public.cluster_replace (id) WITH (fillfactor = 90);
      ALTER TABLE public.cluster_replace
        REPLICA IDENTITY USING INDEX cluster_replace_order;
      ALTER TABLE public.cluster_replace
        CLUSTER ON cluster_replace_order;
    `;
    await service.apply(original, ["public"], true);

    const changed = original.replace("fillfactor = 90", "fillfactor = 80");
    const plan = await service.plan(changed, ["public"]);
    expect(plan.transactional.slice(0, 2)).toEqual([
      'ALTER TABLE "public"."cluster_replace" REPLICA IDENTITY DEFAULT;',
      'ALTER TABLE "public"."cluster_replace" SET WITHOUT CLUSTER;',
    ]);
    expect(plan.transactional).toContain(
      'DROP INDEX "public"."cluster_replace_order";'
    );
    expect(plan.deferred).toEqual([
      'ALTER TABLE "public"."cluster_replace" REPLICA IDENTITY USING INDEX "cluster_replace_order";',
      'ALTER TABLE "public"."cluster_replace" CLUSTER ON "cluster_replace_order";',
    ]);

    await service.apply(changed, ["public"], true);
    expect(await selectedClusterIndex(client, "cluster_replace")).toBe(
      "cluster_replace_order"
    );
    expect((await service.plan(changed, ["public"])).hasChanges).toBe(false);
  });

  test("preserves constraint-backed and inherited relation-local choices", async function () {
    const service = createTestSchemaService();
    const original = `
      CREATE TABLE public.cluster_constraint (
        id integer NOT NULL,
        CONSTRAINT cluster_constraint_old UNIQUE (id)
      );
      ALTER TABLE public.cluster_constraint
        CLUSTER ON cluster_constraint_old;

      CREATE TABLE public.cluster_automatic (
        id integer,
        UNIQUE (id)
      );
      ALTER TABLE public.cluster_automatic
        CLUSTER ON cluster_automatic_id_unique;

      CREATE TABLE public.cluster_parent (id integer);
      CREATE INDEX cluster_parent_order ON public.cluster_parent (id);
      ALTER TABLE public.cluster_parent CLUSTER ON cluster_parent_order;

      CREATE TABLE public.cluster_child ()
        INHERITS (public.cluster_parent);
      CREATE INDEX cluster_child_order ON public.cluster_child (id);
      ALTER TABLE public.cluster_child CLUSTER ON cluster_child_order;
    `;
    await service.apply(original, ["public"], true);
    expect(await selectedClusterIndex(client, "cluster_parent")).toBe(
      "cluster_parent_order"
    );
    expect(await selectedClusterIndex(client, "cluster_child")).toBe(
      "cluster_child_order"
    );
    expect(await selectedClusterIndex(client, "cluster_automatic")).toBe(
      "cluster_automatic_id_unique"
    );

    const renamed = original.replaceAll(
      "cluster_constraint_old",
      "cluster_constraint_new"
    );
    const renamePlan = await service.plan(renamed, ["public"]);
    expect(renamePlan.transactional).toContain(
      'ALTER TABLE "public"."cluster_constraint" RENAME CONSTRAINT "cluster_constraint_old" TO "cluster_constraint_new";'
    );
    await service.apply(renamed, ["public"], true);
    expect(await selectedClusterIndex(client, "cluster_constraint")).toBe(
      "cluster_constraint_new"
    );
    expect((await service.plan(renamed, ["public"])).hasChanges).toBe(false);

    const rebuilt = renamed.replace(
      "UNIQUE (id)",
      "UNIQUE (id) WITH (fillfactor = 80)"
    );
    const rebuildPlan = await service.plan(rebuilt, ["public"]);
    expect(rebuildPlan.transactional[0]).toBe(
      'ALTER TABLE "public"."cluster_constraint" SET WITHOUT CLUSTER;'
    );
    expect(rebuildPlan.transactional.at(-1)).toBe(
      'ALTER TABLE "public"."cluster_constraint" CLUSTER ON "cluster_constraint_new";'
    );
    await service.apply(rebuilt, ["public"], true);
    expect((await service.plan(rebuilt, ["public"])).hasChanges).toBe(false);
  });

  test("does not rename an external equivalent over a selected replacement", async function () {
    const service = createTestSchemaService();
    await client.query(`
      CREATE TABLE public.cluster_equivalent_constraints (
        id integer NOT NULL,
        CONSTRAINT cluster_equivalent_other UNIQUE (id)
          WITH (fillfactor = 80)
      );
      ALTER TABLE public.cluster_equivalent_constraints
        ADD CONSTRAINT cluster_equivalent_selected UNIQUE (id)
          WITH (fillfactor = 90);
      ALTER TABLE public.cluster_equivalent_constraints
        REPLICA IDENTITY USING INDEX cluster_equivalent_selected;
      ALTER TABLE public.cluster_equivalent_constraints
        CLUSTER ON cluster_equivalent_selected;
    `);

    const desired = `
      CREATE TABLE public.cluster_equivalent_constraints (
        id integer NOT NULL,
        CONSTRAINT cluster_equivalent_selected UNIQUE (id)
          WITH (fillfactor = 80)
      );
      ALTER TABLE public.cluster_equivalent_constraints
        REPLICA IDENTITY USING INDEX cluster_equivalent_selected;
      ALTER TABLE public.cluster_equivalent_constraints
        CLUSTER ON cluster_equivalent_selected;
    `;
    const plan = await service.plan(desired, ["public"]);
    expect(plan.hasChanges).toBe(true);
    expect(plan.transactional.join("\n")).not.toContain("RENAME CONSTRAINT");
    expect(plan.transactional.join("\n")).toContain(
      'DROP CONSTRAINT "cluster_equivalent_selected"'
    );

    await service.apply(desired, ["public"], true);
    expect(await selectedClusterIndex(
      client,
      "cluster_equivalent_constraints"
    )).toBe("cluster_equivalent_selected");
    expect((await service.plan(desired, ["public"])).hasChanges).toBe(false);
  });

  test("manages materialized-view and quoted GiST clustering choices", async function () {
    const service = createTestSchemaService();
    const schema = `
      CREATE MATERIALIZED VIEW public."Cluster Summary" AS
        SELECT 1 AS "Key";
      CREATE INDEX "Cluster Summary Order"
        ON public."Cluster Summary" ("Key");
      ALTER MATERIALIZED VIEW public."Cluster Summary"
        CLUSTER ON "Cluster Summary Order";

      CREATE TABLE public."Cluster Geometry" (
        location point,
        CONSTRAINT "Cluster Geometry Exclusion"
          EXCLUDE USING gist (location WITH ~=)
      );
      ALTER TABLE public."Cluster Geometry"
        CLUSTER ON "Cluster Geometry Exclusion";
    `;

    const plan = await service.plan(schema, ["public"]);
    const createIndexPosition = plan.transactional.findIndex(
      function findMaterializedIndex(statement) {
        return statement.includes('CREATE INDEX "Cluster Summary Order"');
      }
    );
    const clusterPosition = plan.transactional.findIndex(
      function findMaterializedCluster(statement) {
        return statement.includes(
          'ALTER MATERIALIZED VIEW "public"."Cluster Summary" CLUSTER ON'
        );
      }
    );
    expect(createIndexPosition).toBeGreaterThanOrEqual(0);
    expect(clusterPosition).toBeGreaterThan(createIndexPosition);

    await service.apply(schema, ["public"], true);
    expect(await selectedClusterIndex(client, "Cluster Geometry")).toBe(
      "Cluster Geometry Exclusion"
    );
    expect(await selectedClusterIndex(client, "Cluster Summary")).toBe(
      "Cluster Summary Order"
    );
    const views = await new DatabaseInspector().getCurrentViews(
      client,
      ["public"]
    );
    expect(views.find(function findSummary(view) {
      return view.name === "Cluster Summary";
    })).toHaveProperty("clusterIndex", "Cluster Summary Order");
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);

    const rebuilt = schema.replace(
      'ON public."Cluster Summary" ("Key");',
      'ON public."Cluster Summary" ("Key") WITH (fillfactor = 80);'
    );
    const rebuildPlan = await service.plan(rebuilt, ["public"]);
    const recreatedIndexPosition = rebuildPlan.transactional.findIndex(
      function findRecreatedIndex(statement) {
        return statement.includes(
          'CREATE INDEX "Cluster Summary Order"'
        );
      }
    );
    const reassignmentPosition = rebuildPlan.transactional.findIndex(
      function findReassignment(statement) {
        return statement.includes(
          'ALTER MATERIALIZED VIEW "public"."Cluster Summary" CLUSTER ON'
        );
      }
    );
    expect(recreatedIndexPosition).toBeGreaterThanOrEqual(0);
    expect(reassignmentPosition).toBeGreaterThan(recreatedIndexPosition);
    await service.apply(rebuilt, ["public"], true);
    expect((await service.plan(rebuilt, ["public"])).hasChanges).toBe(false);
  });

  test("repairs external index loss and rejects invalid choices before mutation", async function () {
    const service = createTestSchemaService();
    const repairSchema = `
      CREATE TABLE public.cluster_repair (id integer);
      CREATE INDEX CONCURRENTLY cluster_repair_order
        ON public.cluster_repair (id);
      ALTER TABLE public.cluster_repair CLUSTER ON cluster_repair_order;
    `;
    await service.apply(repairSchema, ["public"], true);
    await client.query("DROP INDEX public.cluster_repair_order");
    expect(await selectedClusterIndex(client, "cluster_repair")).toBe(
      undefined
    );

    const repairPlan = await service.plan(repairSchema, ["public"]);
    expect(repairPlan.concurrent).toContain(
      'CREATE INDEX CONCURRENTLY "cluster_repair_order" ON "public"."cluster_repair" ("id");'
    );
    expect(repairPlan.deferred).toContain(
      'ALTER TABLE "public"."cluster_repair" CLUSTER ON "cluster_repair_order";'
    );
    await service.apply(repairSchema, ["public"], true);
    expect((await service.plan(repairSchema, ["public"])).hasChanges).toBe(
      false
    );

    const invalidDefinitions = [
      "CREATE TABLE public.invalid_cluster (id integer);",
      `CREATE TABLE public.invalid_cluster (id integer);
       CREATE INDEX invalid_cluster_order ON public.invalid_cluster (id)
         WHERE id > 0;`,
      `CREATE TABLE public.invalid_cluster (id integer);
       CREATE INDEX invalid_cluster_order ON public.invalid_cluster
         USING hash (id);`,
      `CREATE TABLE public.invalid_cluster (id integer);
       CREATE INDEX invalid_cluster_order ON public.invalid_cluster
         USING brin (id);`,
      `CREATE TABLE public.invalid_cluster (id integer);
       CREATE INDEX invalid_cluster_order ON public.invalid_cluster
         USING gin (id);`,
      `CREATE TABLE public.invalid_cluster (id integer);
       CREATE INDEX invalid_cluster_order ON public.invalid_cluster
         USING spgist (id);`,
      `CREATE TABLE public.invalid_cluster (id integer);
       CREATE INDEX invalid_cluster_order ON public.invalid_cluster
         USING custom_access_method (id);`,
    ];
    for (const definition of invalidDefinitions) {
      await expect(service.plan(`${definition}
        ALTER TABLE public.invalid_cluster
          CLUSTER ON invalid_cluster_order;
      `, ["public"])).rejects.toThrow(/clustering index/i);
    }

    await expect(service.plan(`
      CREATE TABLE public.invalid_expression_cluster (
        during int4range,
        EXCLUDE USING gist (
          (int4range(lower(during), upper(during))) WITH &&
        )
      );
      ALTER TABLE public.invalid_expression_cluster
        CLUSTER ON invalid_expression_cluster_int4range_excl;
    `, ["public"])).rejects.toThrow(/not declared/i);
  });

  test("rejects an externally clustered partition instead of ignoring it", async function () {
    await client.query(`
      CREATE TABLE public.cluster_partitioned (id integer)
        PARTITION BY RANGE (id);
      CREATE TABLE public.cluster_partitioned_low
        PARTITION OF public.cluster_partitioned
        FOR VALUES FROM (0) TO (100);
      CREATE INDEX cluster_partitioned_order
        ON public.cluster_partitioned (id);
    `);
    const indexResult = await client.query(`
      SELECT index_relation.relname AS index_name
      FROM pg_index index_catalog
      JOIN pg_class partition_relation
        ON partition_relation.oid = index_catalog.indrelid
      JOIN pg_namespace namespace
        ON namespace.oid = partition_relation.relnamespace
      JOIN pg_class index_relation
        ON index_relation.oid = index_catalog.indexrelid
      WHERE namespace.nspname = 'public'
        AND partition_relation.relname = 'cluster_partitioned_low'
      ORDER BY index_relation.relname
      LIMIT 1
    `);
    const indexName = indexResult.rows[0]?.index_name;
    expect(typeof indexName).toBe("string");
    if (typeof indexName !== "string") {
      throw new Error("Expected the partition index to exist");
    }
    await client.query(
      `ALTER TABLE public.cluster_partitioned_low CLUSTER ON ${quoteIdentifier(indexName)}`
    );

    await expect(
      new DatabaseInspector().getCurrentSqlObjects(client, ["public"])
    ).rejects.toThrow(/persistent cluster index/i);
  });
});

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function selectedClusterIndex(
  client: Client,
  relationName: string
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
       AND index_catalog.indisclustered`,
    [relationName]
  );
  return result.rows[0]?.index_name;
}
