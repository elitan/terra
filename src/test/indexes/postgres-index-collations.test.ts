import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL index collations", function () {
  let client: Client;
  const services = createColumnTestServices();

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  async function planSchema(schema: string): Promise<MigrationPlan> {
    const current = await services.inspector.getCurrentSchema(client);
    const desired = await services.parser.parseSchema(schema);
    return services.differ.generateMigrationPlan(desired.tables, current);
  }

  function allStatements(plan: MigrationPlan): string[] {
    return [...plan.transactional, ...plan.concurrent];
  }

  test("parses ordered unqualified and schema-qualified key collations", async function () {
    const indexes = await services.parser.parseCreateIndexStatements(`
      CREATE INDEX collated_keys_idx ON public.documents (
        title COLLATE "C" text_pattern_ops DESC NULLS LAST,
        subtitle COLLATE "Tenant Space"."Case Order",
        category
      );
    `);

    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.collations).toEqual([
      { name: "C" },
      { name: "Case Order", schema: "Tenant Space" },
      undefined,
    ]);
    expect(indexes[0]?.opclasses).toEqual({ title: "text_pattern_ops" });
    expect(indexes[0]?.sortOrders).toEqual(["DESC", "ASC", "ASC"]);
    expect(indexes[0]?.nullsOrders).toEqual(["LAST", "LAST", "LAST"]);
  });

  test("creates, inspects, and reapplies a collated covering index", async function () {
    const schema = `
      CREATE TABLE public.collated_documents (
        id integer NOT NULL,
        title text,
        payload text
      );
      CREATE INDEX collated_documents_title_idx
        ON public.collated_documents (
          id,
          title COLLATE pg_catalog."C" text_pattern_ops DESC NULLS LAST
        )
        INCLUDE (payload);
    `;

    const createPlan = await planSchema(schema);
    expect(allStatements(createPlan)).toContain(
      'CREATE INDEX "collated_documents_title_idx" ON "public"."collated_documents" ("id", "title" COLLATE "pg_catalog"."C" text_pattern_ops DESC NULLS LAST) INCLUDE ("payload");'
    );
    await services.executor.executePlan(client, createPlan, true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "collated_documents";
      }
    );
    expect(table?.indexes?.[0]?.collations).toEqual([
      undefined,
      { name: "C" },
    ]);
    expect(table?.indexes?.[0]?.opclasses).toEqual({
      title: "text_pattern_ops",
    });
    expect(table?.indexes?.[0]?.sortOrders).toEqual(["ASC", "DESC"]);
    expect(table?.indexes?.[0]?.nullsOrders).toEqual(["LAST", "LAST"]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("preserves a collation override on an expression index", async function () {
    const schema = `
      CREATE TABLE public.collated_expression (
        id integer NOT NULL,
        title text
      );
      CREATE INDEX collated_expression_title_idx
        ON public.collated_expression ((lower(title)) COLLATE "C");
    `;

    await services.executor.executePlan(client, await planSchema(schema), true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "collated_expression";
      }
    );
    expect(table?.indexes?.[0]?.expression).toBe("lower(title)");
    expect(table?.indexes?.[0]?.collations).toEqual([{ name: "C" }]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("fails rather than silently dropping an unparsable catalog definition", async function () {
    const inspector = services.inspector as any;
    expect(
      await inspector.parseIndexDefinitionCollations(undefined)
    ).toBeUndefined();
    await expect(
      inspector.parseIndexDefinitionCollations(
        "CREATE TABLE public.not_an_index (id integer)"
      )
    ).rejects.toThrow("PostgreSQL returned an invalid index definition");
  });

  test("detects a missing collation on an externally created index", async function () {
    await client.query(`
      CREATE TABLE public.external_collated_index (
        id integer NOT NULL,
        title text
      );
      CREATE INDEX external_collated_index_title_idx
        ON public.external_collated_index (title COLLATE "C");
    `);

    const matchingSchema = `
      CREATE TABLE public.external_collated_index (
        id integer NOT NULL,
        title text
      );
      CREATE INDEX external_collated_index_title_idx
        ON public.external_collated_index (title COLLATE "C");
    `;
    expect((await planSchema(matchingSchema)).hasChanges).toBe(false);

    const uncollatedSchema = `
      CREATE TABLE public.external_collated_index (
        id integer NOT NULL,
        title text
      );
      CREATE INDEX external_collated_index_title_idx
        ON public.external_collated_index (title);
    `;
    expect(allStatements(await planSchema(uncollatedSchema))).toEqual([
      'DROP INDEX "public"."external_collated_index_title_idx";',
      'CREATE INDEX "external_collated_index_title_idx" ON "public"."external_collated_index" ("title");',
    ]);
  });

  test("changes and removes a key collation without losing rows", async function () {
    const schemaWithC = `
      CREATE TABLE public.collation_change (
        id integer NOT NULL,
        title text
      );
      CREATE INDEX collation_change_title_idx
        ON public.collation_change (title COLLATE "C");
    `;
    await services.executor.executePlan(client, await planSchema(schemaWithC), true);
    await client.query(`
      INSERT INTO public.collation_change (id, title)
      VALUES (1, 'Zulu'), (2, 'alpha'), (3, NULL)
    `);

    const schemaWithPosix = schemaWithC.replace('COLLATE "C"', 'COLLATE "POSIX"');
    const changePlan = await planSchema(schemaWithPosix);
    expect(allStatements(changePlan)).toEqual([
      'DROP INDEX "public"."collation_change_title_idx";',
      'CREATE INDEX "collation_change_title_idx" ON "public"."collation_change" ("title" COLLATE "POSIX");',
    ]);
    await services.executor.executePlan(client, changePlan, true);
    expect((await planSchema(schemaWithPosix)).hasChanges).toBe(false);

    const schemaWithoutCollation = schemaWithC.replace(' COLLATE "C"', "");
    await services.executor.executePlan(
      client,
      await planSchema(schemaWithoutCollation),
      true
    );
    expect((await planSchema(schemaWithoutCollation)).hasChanges).toBe(false);

    const rows = await client.query(
      "SELECT id, title FROM public.collation_change ORDER BY id"
    );
    expect(rows.rows).toEqual([
      { id: 1, title: "Zulu" },
      { id: 2, title: "alpha" },
      { id: 3, title: null },
    ]);
  });

  test("uses a matching collated index ordering", async function () {
    const schema = `
      CREATE TABLE public.collation_query_plan (
        id integer NOT NULL,
        title text
      );
      CREATE INDEX collation_query_plan_title_idx
        ON public.collation_query_plan (title COLLATE "C");
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);
    await client.query(`
      INSERT INTO public.collation_query_plan (id, title)
      VALUES (1, 'alpha'), (2, 'Zulu'), (3, 'Beta');
      SET enable_seqscan = off;
    `);

    const explained = await client.query(`
      EXPLAIN (COSTS OFF)
      SELECT title
      FROM public.collation_query_plan
      ORDER BY title COLLATE "C";
    `);
    const plan = explained.rows.map(function getPlanLine(row) {
      return row["QUERY PLAN"];
    }).join("\n");
    expect(plan).toContain("collation_query_plan_title_idx");
    expect(plan).not.toContain("Sort");

    const rows = await client.query(`
      SELECT title
      FROM public.collation_query_plan
      ORDER BY title COLLATE "C";
    `);
    expect(rows.rows).toEqual([
      { title: "Beta" },
      { title: "Zulu" },
      { title: "alpha" },
    ]);
  });

  test("distinguishes inherited and explicit default collations", async function () {
    const inheritedSchema = `
      CREATE TABLE public.inherited_index_collation (
        id integer NOT NULL,
        title text COLLATE "C"
      );
      CREATE INDEX inherited_index_collation_title_idx
        ON public.inherited_index_collation (title);
    `;
    await services.executor.executePlan(client, await planSchema(inheritedSchema), true);
    expect((await planSchema(inheritedSchema)).hasChanges).toBe(false);

    const defaultOverrideSchema = inheritedSchema.replace(
      "(title);",
      '(title COLLATE "default");'
    );
    const overridePlan = await planSchema(defaultOverrideSchema);
    expect(allStatements(overridePlan)).toEqual([
      'DROP INDEX "public"."inherited_index_collation_title_idx";',
      'CREATE INDEX "inherited_index_collation_title_idx" ON "public"."inherited_index_collation" ("title" COLLATE "default");',
    ]);
    await services.executor.executePlan(client, overridePlan, true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "inherited_index_collation";
      }
    );
    expect(table?.indexes?.[0]?.collations).toEqual([{ name: "default" }]);
    expect((await planSchema(defaultOverrideSchema)).hasChanges).toBe(false);
  });

  test("normalizes redundant column and expression collation clauses", async function () {
    const schema = `
      CREATE TABLE public.redundant_index_collations (
        id integer NOT NULL,
        default_title text,
        other_title text,
        bytewise_title text COLLATE "C"
      );
      CREATE INDEX redundant_default_column_idx
        ON public.redundant_index_collations (
          default_title COLLATE "default"
        );
      CREATE INDEX redundant_bytewise_column_idx
        ON public.redundant_index_collations (
          bytewise_title COLLATE pg_catalog."C"
        );
      CREATE INDEX redundant_default_expression_idx
        ON public.redundant_index_collations (
          (lower(default_title)) COLLATE "default"
        );
      CREATE INDEX redundant_bytewise_expression_idx
        ON public.redundant_index_collations (
          (lower(bytewise_title)) COLLATE "C"
        );
      CREATE INDEX redundant_compound_expression_idx
        ON public.redundant_index_collations (
          ((default_title || other_title)) COLLATE "default"
        );
      CREATE INDEX redundant_constant_expression_idx
        ON public.redundant_index_collations (
          (('fixed'::text)) COLLATE "default"
        );
    `;

    const desired = await services.parser.parseSchema(schema);
    expect(
      desired.tables[0]?.indexes?.map(function getCollations(index) {
        return index.collations;
      })
    ).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);

    await services.executor.executePlan(client, await planSchema(schema), true);
    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "redundant_index_collations";
      }
    );
    expect(
      table?.indexes?.map(function getCollations(index) {
        return index.collations;
      })
    ).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });
});
