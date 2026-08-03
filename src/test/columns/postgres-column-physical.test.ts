import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { cleanDatabase, createTestClient, createTestSchemaService } from "../utils";
import {
  createColumnTestServices,
  findColumn,
} from "./column-test-utils";

describe("PostgreSQL column storage and compression", function () {
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

  test("parses and renders storage, compression, and explicit defaults", async function () {
    const parsed = await services.parser.parseSchema(`
      CREATE TABLE public.physical_parser_probe (
        plain text,
        external_value text STORAGE EXTERNAL,
        compressed_value text STORAGE EXTENDED COMPRESSION pglz,
        fast_value text COMPRESSION lz4,
        defaults text STORAGE DEFAULT COMPRESSION default,
        fixed integer STORAGE PLAIN
      );
    `);
    const columns = parsed.tables[0]!.columns;

    expect(findColumn(columns, "plain")).toMatchObject({
      storage: undefined,
      compression: undefined,
    });
    expect(findColumn(columns, "external_value")).toMatchObject({
      storage: "EXTERNAL",
      compression: undefined,
    });
    expect(findColumn(columns, "compressed_value")).toMatchObject({
      storage: "EXTENDED",
      compression: "pglz",
    });
    expect(findColumn(columns, "fast_value")?.compression).toBe("lz4");
    expect(findColumn(columns, "defaults")).toMatchObject({
      storage: undefined,
      compression: undefined,
    });
    expect(findColumn(columns, "fixed")?.storage).toBe("PLAIN");

    const sql = services.differ
      .generateMigrationPlan(parsed.tables, [])
      .transactional.join("\n");
    expect(sql).toContain('"external_value" TEXT');
    expect(sql).not.toContain('"external_value" TEXT STORAGE');
    expect(sql).toContain(
      'ALTER COLUMN "external_value" SET STORAGE EXTERNAL'
    );
    expect(sql).toContain(
      'ALTER COLUMN "compressed_value" SET STORAGE EXTENDED'
    );
    expect(sql).toContain(
      'ALTER COLUMN "compressed_value" SET COMPRESSION pglz'
    );
    expect(sql).toContain('ALTER COLUMN "fast_value" SET COMPRESSION lz4');
    expect(sql).not.toContain('ALTER COLUMN "defaults" SET STORAGE');
    expect(sql).not.toContain('ALTER COLUMN "defaults" SET COMPRESSION');
  });

  test("creates and inspects physical settings through the full service", async function () {
    const schema = `
      CREATE TABLE public.physical_columns (
        id integer STORAGE PLAIN PRIMARY KEY,
        external_value text STORAGE EXTERNAL,
        default_storage text STORAGE EXTENDED,
        pglz_value text COMPRESSION pglz,
        lz4_value text STORAGE MAIN COMPRESSION lz4
      );
    `;
    const schemaService = createTestSchemaService();

    const first = await schemaService.apply(schema, ["public"], true);
    const second = await schemaService.apply(schema, ["public"], true);
    expect(first.hasChanges).toBe(true);
    expect(second.hasChanges).toBe(false);

    const current = await services.inspector.getCurrentSchema(client);
    const table = current.find(function findTable(candidate) {
      return candidate.name === "physical_columns";
    });
    expect(findColumn(table!.columns, "id")).toMatchObject({
      storage: undefined,
      storageDefault: "PLAIN",
    });
    expect(findColumn(table!.columns, "external_value")).toMatchObject({
      storage: "EXTERNAL",
      storageDefault: "EXTENDED",
    });
    expect(findColumn(table!.columns, "default_storage")).toMatchObject({
      storage: undefined,
      storageDefault: "EXTENDED",
    });
    expect(findColumn(table!.columns, "pglz_value")?.compression).toBe("pglz");
    expect(findColumn(table!.columns, "lz4_value")).toMatchObject({
      storage: "MAIN",
      compression: "lz4",
    });
  });

  test("adds a physically configured column to populated rows", async function () {
    await client.query(`
      CREATE TABLE public.physical_addition (id integer PRIMARY KEY);
      INSERT INTO public.physical_addition VALUES (1), (2);
    `);
    const schema = `
      CREATE TABLE public.physical_addition (
        id integer PRIMARY KEY,
        payload text STORAGE EXTERNAL COMPRESSION pglz
      );
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ADD COLUMN "payload" TEXT');
    expect(sql).not.toContain('ADD COLUMN "payload" TEXT STORAGE');
    expect(sql.indexOf('ADD COLUMN "payload" TEXT')).toBeLessThan(
      sql.indexOf('ALTER COLUMN "payload" SET STORAGE EXTERNAL')
    );
    expect(sql).toContain('ALTER COLUMN "payload" SET COMPRESSION pglz');
    await services.executor.executePlan(client, plan, true);
    expect(
      (
        await client.query(
          "SELECT id, payload FROM public.physical_addition ORDER BY id"
        )
      ).rows
    ).toEqual([
      { id: 1, payload: null },
      { id: 2, payload: null },
    ]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("changes storage and compression in place without rewriting declarations", async function () {
    const initialSchema = `
      CREATE TABLE public.physical_change (
        payload text STORAGE EXTERNAL COMPRESSION pglz NOT NULL
      );
    `;
    const desiredSchema = `
      CREATE TABLE public.physical_change (
        payload text STORAGE MAIN COMPRESSION lz4 NOT NULL
      );
    `;

    await services.executor.executePlan(client, await planSchema(initialSchema), true);
    await client.query(
      "INSERT INTO public.physical_change VALUES (repeat('payload-', 1000))"
    );

    const plan = await planSchema(desiredSchema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ALTER COLUMN "payload" SET STORAGE MAIN');
    expect(sql).toContain('ALTER COLUMN "payload" SET COMPRESSION lz4');
    expect(sql).not.toMatch(/DROP (?:COLUMN|TABLE)/);
    expect(sql).not.toContain('ALTER COLUMN "payload" TYPE');
    await services.executor.executePlan(client, plan, true);

    expect(
      (
        await client.query(
          "SELECT length(payload) AS length FROM public.physical_change"
        )
      ).rows[0].length
    ).toBe(8000);
    expect((await planSchema(desiredSchema)).hasChanges).toBe(false);
  });

  test("resets storage and compression to their defaults", async function () {
    const initialSchema = `
      CREATE TABLE public.physical_reset (
        payload text STORAGE PLAIN COMPRESSION lz4
      );
    `;
    const desiredSchema = `
      CREATE TABLE public.physical_reset (
        payload text
      );
    `;

    await services.executor.executePlan(client, await planSchema(initialSchema), true);
    const plan = await planSchema(desiredSchema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ALTER COLUMN "payload" SET STORAGE EXTENDED');
    expect(sql).toContain('ALTER COLUMN "payload" SET COMPRESSION default');
    await services.executor.executePlan(client, plan, true);

    const current = await services.inspector.getCurrentSchema(client);
    const table = current.find(function findTable(candidate) {
      return candidate.name === "physical_reset";
    });
    expect(findColumn(table!.columns, "payload")).toMatchObject({
      storage: undefined,
      storageDefault: "EXTENDED",
      compression: undefined,
    });
    expect((await planSchema(desiredSchema)).hasChanges).toBe(false);
  });

  test("applies explicit physical settings after a type change", async function () {
    await client.query(`
      CREATE TABLE public.physical_type_change (payload text NOT NULL);
      INSERT INTO public.physical_type_change VALUES ('preserved');
    `);
    const schema = `
      CREATE TABLE public.physical_type_change (
        payload varchar(100) STORAGE EXTERNAL COMPRESSION pglz NOT NULL
      );
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(sql.indexOf('ALTER COLUMN "payload" TYPE VARCHAR(100)')).toBeLessThan(
      sql.indexOf('ALTER COLUMN "payload" SET STORAGE EXTERNAL')
    );
    expect(sql).toContain('ALTER COLUMN "payload" SET COMPRESSION pglz');
    await services.executor.executePlan(client, plan, true);

    expect(
      (await client.query("SELECT payload FROM public.physical_type_change")).rows
    ).toEqual([{ payload: "preserved" }]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("reapplies unchanged explicit settings after a type change", async function () {
    const initialSchema = `
      CREATE TABLE public.physical_type_preserve (
        payload text STORAGE EXTERNAL COMPRESSION pglz NOT NULL
      );
    `;
    const desiredSchema = `
      CREATE TABLE public.physical_type_preserve (
        payload varchar(100) STORAGE EXTERNAL COMPRESSION pglz NOT NULL
      );
    `;

    await services.executor.executePlan(client, await planSchema(initialSchema), true);
    await client.query(
      "INSERT INTO public.physical_type_preserve VALUES ('preserved')"
    );
    const plan = await planSchema(desiredSchema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ALTER COLUMN "payload" TYPE VARCHAR(100)');
    expect(sql).toContain('ALTER COLUMN "payload" SET STORAGE EXTERNAL');
    expect(sql).toContain('ALTER COLUMN "payload" SET COMPRESSION pglz');
    await services.executor.executePlan(client, plan, true);

    expect(
      (await client.query("SELECT payload FROM public.physical_type_preserve"))
        .rows
    ).toEqual([{ payload: "preserved" }]);
    expect((await planSchema(desiredSchema)).hasChanges).toBe(false);
  });

  test("resets prior physical settings after a type change", async function () {
    const initialSchema = `
      CREATE TABLE public.physical_type_reset (
        payload varchar(100) STORAGE EXTERNAL COMPRESSION pglz NOT NULL
      );
    `;
    const desiredSchema = `
      CREATE TABLE public.physical_type_reset (
        payload text NOT NULL
      );
    `;

    await services.executor.executePlan(client, await planSchema(initialSchema), true);
    await client.query(
      "INSERT INTO public.physical_type_reset VALUES ('preserved')"
    );
    const plan = await planSchema(desiredSchema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ALTER COLUMN "payload" TYPE TEXT');
    expect(sql).not.toContain('ALTER COLUMN "payload" SET STORAGE');
    expect(sql).not.toContain('ALTER COLUMN "payload" SET COMPRESSION');
    await services.executor.executePlan(client, plan, true);

    expect(
      (await client.query("SELECT payload FROM public.physical_type_reset")).rows
    ).toEqual([{ payload: "preserved" }]);
    expect((await planSchema(desiredSchema)).hasChanges).toBe(false);
  });

  test("changes generated-column physical settings without recreating it", async function () {
    const initialSchema = `
      CREATE TABLE public.physical_generated (
        source text NOT NULL,
        normalized text GENERATED ALWAYS AS (lower(source)) STORED
      );
    `;
    const desiredSchema = `
      CREATE TABLE public.physical_generated (
        source text NOT NULL,
        normalized text STORAGE EXTERNAL COMPRESSION pglz
          GENERATED ALWAYS AS (lower(source)) STORED
      );
    `;

    await services.executor.executePlan(client, await planSchema(initialSchema), true);
    await client.query(
      "INSERT INTO public.physical_generated (source) VALUES ('ABC')"
    );
    const plan = await planSchema(desiredSchema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ALTER COLUMN "normalized" SET STORAGE EXTERNAL');
    expect(sql).toContain('ALTER COLUMN "normalized" SET COMPRESSION pglz');
    expect(sql).not.toContain('DROP COLUMN "normalized"');
    await services.executor.executePlan(client, plan, true);

    expect(
      (await client.query("SELECT normalized FROM public.physical_generated")).rows
    ).toEqual([{ normalized: "abc" }]);
    expect((await planSchema(desiredSchema)).hasChanges).toBe(false);
  });

  test("reapplies physical settings when recreating a generated column", async function () {
    const initialSchema = `
      CREATE TABLE public.physical_generated_recreate (
        source text NOT NULL,
        normalized text STORAGE EXTERNAL COMPRESSION pglz
          GENERATED ALWAYS AS (lower(source)) STORED
      );
    `;
    const desiredSchema = `
      CREATE TABLE public.physical_generated_recreate (
        source text NOT NULL,
        normalized text STORAGE EXTERNAL COMPRESSION pglz
          GENERATED ALWAYS AS (upper(source)) STORED
      );
    `;

    await services.executor.executePlan(client, await planSchema(initialSchema), true);
    await client.query(
      "INSERT INTO public.physical_generated_recreate (source) VALUES ('AbC')"
    );
    const plan = await planSchema(desiredSchema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('DROP COLUMN "normalized"');
    expect(sql).toContain('ADD COLUMN "normalized" TEXT GENERATED ALWAYS');
    expect(sql).toContain('ALTER COLUMN "normalized" SET STORAGE EXTERNAL');
    expect(sql).toContain('ALTER COLUMN "normalized" SET COMPRESSION pglz');
    await services.executor.executePlan(client, plan, true);

    expect(
      (
        await client.query(
          "SELECT normalized FROM public.physical_generated_recreate"
        )
      ).rows
    ).toEqual([{ normalized: "ABC" }]);
    expect((await planSchema(desiredSchema)).hasChanges).toBe(false);
  });
});
