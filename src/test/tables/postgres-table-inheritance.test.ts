import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL table inheritance", function () {
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

  test("parses, renders, and orders multiple inheritance parents", async function () {
    const schema = `
      CREATE TABLE public.a_child (extra text)
      INHERITS (public.z_parent, public.y_parent);
      CREATE TABLE public.z_parent (id integer);
      CREATE TABLE public.y_parent (created_at timestamp);
    `;
    const desired = await services.parser.parseSchema(schema);
    const child = desired.tables.find(function findChild(table) {
      return table.name === "a_child";
    });

    expect(child?.inherits).toEqual([
      { name: "z_parent", schema: "public" },
      { name: "y_parent", schema: "public" },
    ]);

    const plan = services.differ.generateMigrationPlan(desired.tables, []);
    const sql = plan.transactional.join("\n");
    const childPosition = sql.indexOf('CREATE TABLE "public"."a_child"');
    expect(sql.indexOf('CREATE TABLE "public"."z_parent"')).toBeLessThan(
      childPosition
    );
    expect(sql.indexOf('CREATE TABLE "public"."y_parent"')).toBeLessThan(
      childPosition
    );
    expect(sql).toContain(
      'INHERITS ("public"."z_parent", "public"."y_parent")'
    );
  });

  test("creates, inspects, and reapplies inherited columns and checks", async function () {
    const schema = `
      CREATE TABLE public.inheritance_parent (
        id integer NOT NULL,
        payload text,
        CONSTRAINT inheritance_parent_id_check CHECK (id > 0)
      );
      CREATE TABLE public.inheritance_child (
        extra text,
        CONSTRAINT inheritance_child_extra_check CHECK (extra <> '')
      ) INHERITS (public.inheritance_parent);
    `;

    await services.executor.executePlan(client, await planSchema(schema), true);

    const tables = await services.inspector.getCurrentSchema(client);
    const child = tables.find(function findChild(table) {
      return table.name === "inheritance_child";
    });
    expect(child?.inherits).toEqual([
      { name: "inheritance_parent", schema: "public" },
    ]);
    expect(child?.columns.map(function getName(column) {
      return column.name;
    })).toEqual(["extra"]);
    expect(child?.inheritedColumns?.map(function getName(column) {
      return column.name;
    })).toEqual(["id", "payload"]);
    expect(child?.checkConstraints?.map(function getName(constraint) {
      return constraint.name;
    })).toEqual(["inheritance_child_extra_check"]);
    expect(child?.inheritedCheckConstraints?.map(function getName(constraint) {
      return constraint.name;
    })).toEqual(["inheritance_parent_id_check"]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("includes child rows in parent queries", async function () {
    const schema = `
      CREATE TABLE public.inheritance_query_parent (id integer, payload text);
      CREATE TABLE public.inheritance_query_child (extra text)
      INHERITS (public.inheritance_query_parent);
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);
    await client.query(`
      INSERT INTO public.inheritance_query_child VALUES (1, 'child', 'extra');
    `);

    expect(
      (
        await client.query(
          "SELECT id, payload FROM public.inheritance_query_parent"
        )
      ).rows
    ).toEqual([{ id: 1, payload: "child" }]);
  });

  test("attaches an existing compatible table without losing rows", async function () {
    await client.query(`
      CREATE TABLE public.inheritance_attach_parent (
        id integer NOT NULL,
        payload text,
        CONSTRAINT inheritance_attach_parent_check CHECK (id > 0)
      );
      CREATE TABLE public.inheritance_attach_child (
        id integer NOT NULL,
        payload text,
        extra text,
        CONSTRAINT inheritance_attach_parent_check CHECK (id > 0),
        CONSTRAINT inheritance_attach_child_check CHECK (extra <> '')
      );
      INSERT INTO public.inheritance_attach_child VALUES (1, 'preserved', 'x');
    `);
    const schema = `
      CREATE TABLE public.inheritance_attach_parent (
        id integer NOT NULL,
        payload text,
        CONSTRAINT inheritance_attach_parent_check CHECK (id > 0)
      );
      CREATE TABLE public.inheritance_attach_child (
        extra text,
        CONSTRAINT inheritance_attach_child_check CHECK (extra <> '')
      ) INHERITS (public.inheritance_attach_parent);
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain(
      'INHERIT "public"."inheritance_attach_parent"'
    );
    expect(sql).not.toContain("DROP COLUMN");
    expect(sql).not.toContain("DROP CONSTRAINT");
    await services.executor.executePlan(client, plan, true);

    expect(
      (await client.query("SELECT * FROM public.inheritance_attach_child")).rows
    ).toEqual([{ id: 1, payload: "preserved", extra: "x" }]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("detaches a child and localizes inherited definitions", async function () {
    await client.query(`
      CREATE TABLE public.inheritance_detach_parent (
        id integer NOT NULL,
        payload text,
        CONSTRAINT inheritance_detach_parent_check CHECK (id > 0)
      );
      CREATE TABLE public.inheritance_detach_child (
        extra text,
        CONSTRAINT inheritance_detach_child_check CHECK (extra <> '')
      ) INHERITS (public.inheritance_detach_parent);
      INSERT INTO public.inheritance_detach_child VALUES (1, 'preserved', 'x');
    `);
    const schema = `
      CREATE TABLE public.inheritance_detach_parent (
        id integer NOT NULL,
        payload text,
        CONSTRAINT inheritance_detach_parent_check CHECK (id > 0)
      );
      CREATE TABLE public.inheritance_detach_child (
        id integer NOT NULL,
        payload text,
        extra text,
        CONSTRAINT inheritance_detach_parent_check CHECK (id > 0),
        CONSTRAINT inheritance_detach_child_check CHECK (extra <> '')
      );
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain(
      'NO INHERIT "public"."inheritance_detach_parent"'
    );
    expect(sql).not.toContain("ADD COLUMN");
    expect(sql).not.toContain("ADD CONSTRAINT");
    await services.executor.executePlan(client, plan, true);

    expect(
      (await client.query("SELECT * FROM public.inheritance_detach_child")).rows
    ).toEqual([{ id: 1, payload: "preserved", extra: "x" }]);
    expect(
      (
        await client.query(
          "SELECT id, payload FROM public.inheritance_detach_parent"
        )
      ).rows
    ).toEqual([]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });
});
