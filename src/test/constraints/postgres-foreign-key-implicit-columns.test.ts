import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

describe("PostgreSQL implicit foreign key columns", function () {
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

  const implicitCompositeSchema = `
    CREATE TABLE public.implicit_child (
      id integer PRIMARY KEY,
      tenant_id integer NOT NULL,
      parent_id integer NOT NULL,
      CONSTRAINT implicit_child_parent_fkey
        FOREIGN KEY (tenant_id, parent_id)
        REFERENCES public.implicit_parent
        ON DELETE CASCADE
    );
    CREATE TABLE public.implicit_parent (
      tenant_id integer NOT NULL,
      id integer NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
  `;

  test("resolves a forward composite reference and preserves the full lifecycle", async function () {
    const parsed = await services.parser.parseSchema(implicitCompositeSchema);
    const child = parsed.tables.find(function findChild(table) {
      return table.name === "implicit_child";
    });
    expect(child?.foreignKeys?.[0]?.referencedColumns).toEqual([
      "tenant_id",
      "id",
    ]);

    const createPlan = await planSchema(implicitCompositeSchema);
    expect(createPlan.transactional.join("\n")).toContain(
      'REFERENCES "public"."implicit_parent" ("tenant_id", "id")'
    );
    await services.executor.executePlan(client, createPlan, true);

    const inspectedChild = (await services.inspector.getCurrentSchema(client)).find(
      function findChild(table) {
        return table.name === "implicit_child";
      }
    );
    expect(inspectedChild?.foreignKeys?.[0]?.referencedColumns).toEqual([
      "tenant_id",
      "id",
    ]);
    expect((await planSchema(implicitCompositeSchema)).hasChanges).toBe(false);

    await client.query("INSERT INTO public.implicit_parent VALUES (1, 10)");
    await client.query("INSERT INTO public.implicit_child VALUES (1, 1, 10)");
    await expect(
      client.query("INSERT INTO public.implicit_child VALUES (2, 1, 99)")
    ).rejects.toThrow(/implicit_child_parent_fkey/);

    const explicitSchema = implicitCompositeSchema.replace(
      "REFERENCES public.implicit_parent",
      "REFERENCES public.implicit_parent (tenant_id, id)"
    );
    expect((await planSchema(explicitSchema)).hasChanges).toBe(false);

    const removedSchema = explicitSchema.replace(
      /,\s*CONSTRAINT implicit_child_parent_fkey[\s\S]*?ON DELETE CASCADE/,
      ""
    );
    const removePlan = await planSchema(removedSchema);
    expect(removePlan.transactional.join("\n")).toContain(
      'DROP CONSTRAINT "implicit_child_parent_fkey"'
    );
    await services.executor.executePlan(client, removePlan, true);
    expect(
      (await client.query("SELECT * FROM public.implicit_child ORDER BY id")).rows
    ).toEqual([{ id: 1, tenant_id: 1, parent_id: 10 }]);
    await client.query("INSERT INTO public.implicit_child VALUES (2, 1, 99)");
    expect((await planSchema(removedSchema)).hasChanges).toBe(false);
  });

  test("resolves column-level and ALTER TABLE shorthand", async function () {
    const columnLevelSchema = `
      CREATE TABLE public.implicit_parent (
        id integer PRIMARY KEY
      );
      CREATE TABLE public.implicit_child (
        id integer PRIMARY KEY,
        parent_id integer REFERENCES implicit_parent
      );
    `;
    const columnLevel = await services.parser.parseSchema(columnLevelSchema);
    expect(columnLevel.tables[1]?.foreignKeys?.[0]?.referencedColumns).toEqual([
      "id",
    ]);

    const alterTableSchema = `
      CREATE TABLE public.implicit_parent (
        id integer PRIMARY KEY
      );
      CREATE TABLE public.implicit_child (
        id integer PRIMARY KEY,
        parent_id integer
      );
      ALTER TABLE public.implicit_child
        ADD CONSTRAINT implicit_child_parent_fkey
        FOREIGN KEY (parent_id) REFERENCES public.implicit_parent
        NOT VALID;
    `;
    const altered = await services.parser.parseSchema(alterTableSchema);
    expect(altered.tables[1]?.foreignKeys).toEqual([
      expect.objectContaining({
        name: "implicit_child_parent_fkey",
        referencedColumns: ["id"],
        notValid: true,
      }),
    ]);

    const schemaQualified = await services.parser.parseSchema(`
      CREATE TABLE "Tenant Space"."Parent Ü" (
        "Tenant Key" integer,
        "Parent Key" integer,
        PRIMARY KEY ("Tenant Key", "Parent Key")
      );
      CREATE TABLE "Tenant Space"."Child Ü" (
        "Tenant Key" integer,
        "Parent Key" integer
      );
      ALTER TABLE "Tenant Space"."Child Ü"
        ADD CONSTRAINT "Child Parent FK"
        FOREIGN KEY ("Tenant Key", "Parent Key") REFERENCES "Parent Ü";
    `);
    expect(schemaQualified.tables[1]?.foreignKeys?.[0]).toMatchObject({
      name: "Child Parent FK",
      referencedTable: "Tenant Space.Parent Ü",
      referencedColumns: ["Tenant Key", "Parent Key"],
    });

    const selfReference = await services.parser.parseSchema(`
      CREATE TABLE public.implicit_node (
        id integer PRIMARY KEY,
        parent_id integer REFERENCES public.implicit_node
      );
    `);
    expect(
      selfReference.tables[0]?.foreignKeys?.[0]?.referencedColumns
    ).toEqual(["id"]);

    await services.executor.executePlan(
      client,
      await planSchema(alterTableSchema),
      true
    );
    expect((await planSchema(alterTableSchema)).hasChanges).toBe(false);
  });

  test("rejects shorthand that cannot be resolved before planning", async function () {
    const cases = [
      {
        schema: `
          CREATE TABLE public.implicit_child (
            parent_id integer REFERENCES public.external_parent
          );
        `,
        message: "referenced table public.external_parent is not defined",
      },
      {
        schema: `
          CREATE TABLE public.implicit_parent (id integer);
          CREATE TABLE public.implicit_child (
            parent_id integer REFERENCES public.implicit_parent
          );
        `,
        message: "referenced table public.implicit_parent has no primary key",
      },
      {
        schema: `
          CREATE TABLE public.implicit_parent (
            tenant_id integer,
            id integer,
            PRIMARY KEY (tenant_id, id)
          );
          CREATE TABLE public.implicit_child (
            parent_id integer REFERENCES public.implicit_parent
          );
        `,
        message: "1 referencing column but the primary key has 2 columns",
      },
    ];

    for (const scenario of cases) {
      await expect(services.parser.parseSchema(scenario.schema)).rejects.toThrow(
        scenario.message
      );
    }

    await expect(
      createTestSchemaService().apply(cases[0]!.schema, ["public"], true)
    ).rejects.toThrow(cases[0]!.message);
    expect(
      (await client.query("SELECT to_regclass('public.implicit_child') AS relation"))
        .rows[0]?.relation
    ).toBeNull();
  });
});
