import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { cleanDatabase, createTestClient, createTestSchemaService } from "../utils";
import {
  createColumnTestServices,
  findColumn,
} from "./column-test-utils";

describe("PostgreSQL column collations", function () {
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

  test("parses unqualified, qualified, quoted, and default collations", async function () {
    const parsed = await services.parser.parseSchema(`
      CREATE TABLE public.collation_parser_probe (
        plain text,
        bytewise text COLLATE "C",
        qualified varchar(20) COLLATE pg_catalog."C",
        quoted text COLLATE "tenant collations"."Sort ""Rules""",
        explicit_default text COLLATE "default"
      );
    `);
    const columns = parsed.tables[0]!.columns;

    expect(findColumn(columns, "plain")?.collation).toBeUndefined();
    expect(findColumn(columns, "bytewise")?.collation).toEqual({
      name: "C",
      schema: undefined,
    });
    expect(findColumn(columns, "qualified")?.collation).toEqual({
      name: "C",
      schema: "pg_catalog",
    });
    expect(findColumn(columns, "quoted")?.collation).toEqual({
      name: 'Sort "Rules"',
      schema: "tenant collations",
    });
    expect(findColumn(columns, "explicit_default")?.collation).toBeUndefined();

    const createSql = services.differ.generateMigrationPlan(parsed.tables, [])
      .transactional[0]!;
    expect(createSql).toContain('"bytewise" TEXT COLLATE "C"');
    expect(createSql).toContain(
      '"qualified" VARCHAR(20) COLLATE "pg_catalog"."C"'
    );
    expect(createSql).toContain(
      '"quoted" TEXT COLLATE "tenant collations"."Sort ""Rules"""'
    );
    expect(createSql).not.toContain('"explicit_default" TEXT COLLATE');
  });

  test("creates and inspects a built-in collation through the full service", async function () {
    const schema = `
      CREATE TABLE public.collated_names (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        value text COLLATE pg_catalog."C" NOT NULL
      );
    `;
    const schemaService = createTestSchemaService();

    const first = await schemaService.apply(schema, ["public"], true);
    const second = await schemaService.apply(schema, ["public"], true);
    expect(first.hasChanges).toBe(true);
    expect(second.hasChanges).toBe(false);

    const current = await services.inspector.getCurrentSchema(client);
    const table = current.find(function findTable(candidate) {
      return candidate.name === "collated_names";
    });
    expect(findColumn(table!.columns, "value")?.collation).toEqual({
      name: "C",
      schema: "pg_catalog",
    });

    await client.query(
      "INSERT INTO public.collated_names (value) VALUES ('z'), ('ä')"
    );
    const result = await client.query(
      "SELECT pg_collation_for(value) AS active_collation, string_agg(value, ',' ORDER BY value) AS ordered_values FROM public.collated_names GROUP BY pg_collation_for(value)"
    );
    expect(result.rows[0]).toEqual({
      active_collation: '"C"',
      ordered_values: "z,ä",
    });
  });

  test("adds a collated column to a populated table", async function () {
    await client.query(`
      CREATE TABLE public.collation_addition (id integer PRIMARY KEY);
      INSERT INTO public.collation_addition VALUES (1), (2);
    `);
    const schema = `
      CREATE TABLE public.collation_addition (
        id integer PRIMARY KEY,
        code text COLLATE "C"
      );
    `;

    const plan = await planSchema(schema);
    expect(plan.transactional.join("\n")).toContain(
      'ADD COLUMN "code" TEXT COLLATE "C"'
    );
    await services.executor.executePlan(client, plan, true);

    const rows = await client.query(
      "SELECT id, code FROM public.collation_addition ORDER BY id"
    );
    expect(rows.rows).toEqual([
      { id: 1, code: null },
      { id: 2, code: null },
    ]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("changes collation in place while preserving rows and indexes", async function () {
    await client.query(`
      CREATE TABLE public.collation_change (label text NOT NULL);
      INSERT INTO public.collation_change VALUES ('z'), ('ä');
      CREATE INDEX collation_change_label_idx
        ON public.collation_change (label);
    `);
    const schema = `
      CREATE TABLE public.collation_change (
        label text COLLATE "C" NOT NULL
      );
      CREATE INDEX collation_change_label_idx
        ON public.collation_change (label);
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ALTER COLUMN "label" TYPE TEXT COLLATE "C"');
    expect(sql).not.toMatch(/DROP (?:COLUMN|TABLE|INDEX)/);
    await services.executor.executePlan(client, plan, true);

    const rows = await client.query(
      "SELECT label FROM public.collation_change ORDER BY label"
    );
    expect(rows.rows).toEqual([{ label: "z" }, { label: "ä" }]);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname='public' AND tablename='collation_change' AND indexname='collation_change_label_idx'"
        )
      ).rows[0].count
    ).toBe(1);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("resets an explicit collation to the data type default", async function () {
    const initialSchema = `
      CREATE TABLE public.collation_reset (
        value text COLLATE "C" NOT NULL
      );
    `;
    const desiredSchema = `
      CREATE TABLE public.collation_reset (
        value text NOT NULL
      );
    `;

    await services.executor.executePlan(client, await planSchema(initialSchema), true);
    await client.query("INSERT INTO public.collation_reset VALUES ('preserved')");

    const plan = await planSchema(desiredSchema);
    expect(plan.transactional.join("\n")).toContain(
      'ALTER COLUMN "value" TYPE TEXT COLLATE "default"'
    );
    await services.executor.executePlan(client, plan, true);

    const current = await services.inspector.getCurrentSchema(client);
    const table = current.find(function findTable(candidate) {
      return candidate.name === "collation_reset";
    });
    expect(findColumn(table!.columns, "value")?.collation).toBeUndefined();
    expect(
      (
        await client.query(
          "SELECT pg_collation_for(value) AS active_collation FROM public.collation_reset"
        )
      ).rows[0].active_collation
    ).toBe('"default"');
    expect((await planSchema(desiredSchema)).hasChanges).toBe(false);
  });

  test("combines data type and collation changes in one safe alteration", async function () {
    await client.query(`
      CREATE TABLE public.collation_type_change (
        value varchar(20) NOT NULL DEFAULT 'initial'
      );
      INSERT INTO public.collation_type_change DEFAULT VALUES;
    `);
    const schema = `
      CREATE TABLE public.collation_type_change (
        value text COLLATE "C" NOT NULL DEFAULT 'initial'
      );
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ALTER COLUMN "value" TYPE TEXT COLLATE "C"');
    expect(sql).not.toContain("DROP DEFAULT");
    await services.executor.executePlan(client, plan, true);

    const rows = await client.query(
      "SELECT value FROM public.collation_type_change"
    );
    expect(rows.rows).toEqual([{ value: "initial" }]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("uses the new type default when changing type and removing collation", async function () {
    const initialSchema = `
      CREATE TABLE public.collation_type_reset (
        value varchar(20) COLLATE "C" NOT NULL
      );
    `;
    const desiredSchema = `
      CREATE TABLE public.collation_type_reset (
        value text NOT NULL
      );
    `;

    await services.executor.executePlan(client, await planSchema(initialSchema), true);
    await client.query(
      "INSERT INTO public.collation_type_reset VALUES ('preserved')"
    );

    const plan = await planSchema(desiredSchema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ALTER COLUMN "value" TYPE TEXT');
    expect(sql).not.toContain("COLLATE");
    await services.executor.executePlan(client, plan, true);

    const current = await services.inspector.getCurrentSchema(client);
    const table = current.find(function findTable(candidate) {
      return candidate.name === "collation_type_reset";
    });
    const value = findColumn(table!.columns, "value");
    expect(value?.type).toBe("text");
    expect(value?.collation).toBeUndefined();
    expect(
      (await client.query("SELECT value FROM public.collation_type_reset")).rows
    ).toEqual([{ value: "preserved" }]);
    expect((await planSchema(desiredSchema)).hasChanges).toBe(false);
  });

  test("supports collatable array columns", async function () {
    const schema = `
      CREATE TABLE public.collation_arrays (
        tags text[] COLLATE "C" NOT NULL
      );
    `;

    await services.executor.executePlan(client, await planSchema(schema), true);
    await client.query(
      "INSERT INTO public.collation_arrays VALUES (ARRAY['z', 'ä'])"
    );
    const current = await services.inspector.getCurrentSchema(client);
    const table = current.find(function findTable(candidate) {
      return candidate.name === "collation_arrays";
    });
    expect(findColumn(table!.columns, "tags")?.collation).toEqual({
      name: "C",
      schema: "pg_catalog",
    });
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("changes a generated column collation without recreating the column", async function () {
    const initialSchema = `
      CREATE TABLE public.collation_generated (
        source text NOT NULL,
        normalized text GENERATED ALWAYS AS (lower(source)) STORED
      );
    `;
    const desiredSchema = `
      CREATE TABLE public.collation_generated (
        source text NOT NULL,
        normalized text COLLATE "C"
          GENERATED ALWAYS AS (lower(source)) STORED
      );
    `;

    await services.executor.executePlan(client, await planSchema(initialSchema), true);
    await client.query(
      "INSERT INTO public.collation_generated (source) VALUES ('ABC')"
    );

    const plan = await planSchema(desiredSchema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain(
      'ALTER COLUMN "normalized" TYPE TEXT COLLATE "C"'
    );
    expect(sql).not.toContain('DROP COLUMN "normalized"');
    await services.executor.executePlan(client, plan, true);

    const current = await services.inspector.getCurrentSchema(client);
    const table = current.find(function findTable(candidate) {
      return candidate.name === "collation_generated";
    });
    const normalized = findColumn(table!.columns, "normalized");
    expect(normalized?.generated?.expression).toContain("lower(source)");
    expect(normalized?.collation).toEqual({
      name: "C",
      schema: "pg_catalog",
    });
    expect(
      (
        await client.query(
          "SELECT normalized FROM public.collation_generated"
        )
      ).rows
    ).toEqual([{ normalized: "abc" }]);
    expect((await planSchema(desiredSchema)).hasChanges).toBe(false);
  });
});
