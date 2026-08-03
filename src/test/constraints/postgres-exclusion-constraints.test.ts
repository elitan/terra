import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL exclusion constraints", function () {
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

  test("creates, inspects, reapplies, and enforces an exclusion constraint", async function () {
    const schema = `
      CREATE TABLE public.bookings (
        id integer NOT NULL,
        during int4range NOT NULL,
        CONSTRAINT bookings_no_overlap
          EXCLUDE USING gist (during WITH &&)
          INCLUDE (id)
          WITH (fillfactor=80)
          WHERE (NOT isempty(during))
          DEFERRABLE
      );
    `;

    await services.executor.executePlan(client, await planSchema(schema), true);

    const tables = await services.inspector.getCurrentSchema(client);
    const bookings = tables.find(function findBookings(table) {
      return table.name === "bookings";
    });
    expect(bookings?.exclusionConstraints).toEqual([
      {
        name: "bookings_no_overlap",
        method: "gist",
        elements: [{ definition: "during", operator: { name: "&&" } }],
        include: ["id"],
        storageParameters: { fillfactor: "80" },
        where: "(NOT isempty(during))",
        deferrable: true,
      },
    ]);
    expect(bookings?.indexes).toEqual([]);
    expect((await planSchema(schema)).hasChanges).toBe(false);

    await client.query(
      "INSERT INTO public.bookings VALUES (1, int4range(1, 5))"
    );
    await expect(
      client.query(
        "INSERT INTO public.bookings VALUES (2, int4range(4, 8))"
      )
    ).rejects.toThrow(/bookings_no_overlap/);
    await client.query(
      "INSERT INTO public.bookings VALUES (3, int4range(10, 12))"
    );
  });

  test("normalizes expression elements and qualified built-in operators", async function () {
    const schema = `
      CREATE TABLE public.expression_bookings (
        during int4range NOT NULL,
        EXCLUDE USING gist (
          (int4range(lower(during), upper(during)))
          WITH OPERATOR(pg_catalog.&&)
        )
      );
    `;
    const desired = await services.parser.parseSchema(schema);
    const constraint = desired.tables[0]?.exclusionConstraints?.[0];
    expect(constraint?.elements).toEqual([
      {
        definition: "(int4range(lower(during), upper(during)))",
        operator: { name: "&&", schema: "pg_catalog" },
      },
    ]);

    await services.executor.executePlan(client, await planSchema(schema), true);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("preserves the default btree exclusion access method", async function () {
    const schema = `
      CREATE TABLE public.exclusion_btree_default (
        id integer NOT NULL,
        CONSTRAINT exclusion_btree_default_id EXCLUDE (id WITH =)
      );
    `;
    const desired = await services.parser.parseSchema(schema);
    expect(desired.tables[0]?.exclusionConstraints?.[0]?.method).toBe("btree");

    await services.executor.executePlan(client, await planSchema(schema), true);
    expect((await planSchema(schema)).hasChanges).toBe(false);
    await client.query("INSERT INTO public.exclusion_btree_default VALUES (1)");
    await expect(
      client.query("INSERT INTO public.exclusion_btree_default VALUES (1)")
    ).rejects.toThrow(/exclusion_btree_default_id/);
  });

  test("adds and replaces a constraint on a populated table without losing rows", async function () {
    await client.query(`
      CREATE TABLE public.exclusion_lifecycle (
        id integer NOT NULL,
        during int4range NOT NULL
      );
      INSERT INTO public.exclusion_lifecycle VALUES
        (1, int4range(1, 3)),
        (2, int4range(5, 7));
    `);
    const initialSchema = `
      CREATE TABLE public.exclusion_lifecycle (
        id integer NOT NULL,
        during int4range NOT NULL,
        CONSTRAINT exclusion_lifecycle_no_overlap
          EXCLUDE USING gist (during WITH &&)
          WHERE (id > 0)
      );
    `;
    const addPlan = await planSchema(initialSchema);
    expect(addPlan.transactional.join("\n")).toContain(
      "ADD CONSTRAINT \"exclusion_lifecycle_no_overlap\" EXCLUDE"
    );
    await services.executor.executePlan(client, addPlan, true);

    const replacementSchema = initialSchema.replace("id > 0", "id >= 0");
    const replacementPlan = await planSchema(replacementSchema);
    const replacementSql = replacementPlan.transactional.join("\n");
    expect(replacementSql).toContain(
      'DROP CONSTRAINT "exclusion_lifecycle_no_overlap"'
    );
    expect(replacementSql).toContain(
      "ADD CONSTRAINT \"exclusion_lifecycle_no_overlap\" EXCLUDE"
    );
    expect(replacementSql).not.toContain("DROP INDEX");
    await services.executor.executePlan(client, replacementPlan, true);

    expect(
      (await client.query("SELECT id FROM public.exclusion_lifecycle ORDER BY id"))
        .rows
    ).toEqual([{ id: 1 }, { id: 2 }]);
    expect((await planSchema(replacementSchema)).hasChanges).toBe(false);
  });

  test("removes a constraint through ALTER TABLE rather than its index", async function () {
    await client.query(`
      CREATE TABLE public.exclusion_removal (
        id integer NOT NULL,
        during int4range NOT NULL,
        CONSTRAINT exclusion_removal_no_overlap
          EXCLUDE USING gist (during WITH &&)
      );
      INSERT INTO public.exclusion_removal VALUES (1, int4range(1, 3));
    `);
    const schema = `
      CREATE TABLE public.exclusion_removal (
        id integer NOT NULL,
        during int4range NOT NULL
      );
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain(
      'DROP CONSTRAINT "exclusion_removal_no_overlap"'
    );
    expect(sql).not.toContain("DROP INDEX");
    await services.executor.executePlan(client, plan, true);

    expect(
      (await client.query("SELECT id FROM public.exclusion_removal")).rows
    ).toEqual([{ id: 1 }]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });
});
