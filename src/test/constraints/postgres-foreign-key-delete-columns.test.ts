import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL foreign key delete action columns", function () {
  let client: Client;
  let postgresVersionNum: number;
  const services = createColumnTestServices();

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    const versionResult = await client.query(
      "SELECT current_setting('server_version_num') AS version"
    );
    postgresVersionNum = Number(versionResult.rows[0]?.version);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  async function planSchema(schema: string): Promise<MigrationPlan> {
    const current = await services.inspector.getCurrentSchema(client);
    const desired = await services.parser.parseSchema(schema);
    return services.differ.generateMigrationPlan(desired.tables, current, {
      postgresVersionNum,
    });
  }

  const subsetSchema = `
    CREATE TABLE public.delete_parent (
      tenant_id integer NOT NULL,
      id integer NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE TABLE public.delete_child (
      id integer PRIMARY KEY,
      tenant_id integer NOT NULL,
      parent_id integer,
      CONSTRAINT delete_child_parent_fkey
        FOREIGN KEY (tenant_id, parent_id)
        REFERENCES public.delete_parent (tenant_id, id)
        ON DELETE SET NULL (parent_id)
    );
  `;

  test("creates, inspects, enforces, and reapplies a SET NULL column subset", async function () {
    if (postgresVersionNum < 150000) {
      await expect(planSchema(subsetSchema)).rejects.toThrow(
        "PostgreSQL 14 does not support foreign-key ON DELETE column lists"
      );
      expect(
        (await client.query("SELECT to_regclass('public.delete_parent') AS relation"))
          .rows[0]?.relation
      ).toBeNull();
      return;
    }

    const parsed = await services.parser.parseSchema(subsetSchema);
    const parsedChild = parsed.tables.find(function findChild(table) {
      return table.name === "delete_child";
    });
    expect(parsedChild?.foreignKeys?.[0]?.onDeleteColumns).toEqual([
      "parent_id",
    ]);

    await services.executor.executePlan(client, await planSchema(subsetSchema), true);
    const inspectedChild = (await services.inspector.getCurrentSchema(client)).find(
      function findChild(table) {
        return table.name === "delete_child";
      }
    );
    expect(inspectedChild?.foreignKeys?.[0]?.onDeleteColumns).toEqual([
      "parent_id",
    ]);
    expect((await planSchema(subsetSchema)).hasChanges).toBe(false);

    await client.query("INSERT INTO public.delete_parent VALUES (1, 10)");
    await client.query("INSERT INTO public.delete_child VALUES (1, 1, 10)");
    await client.query("DELETE FROM public.delete_parent WHERE tenant_id = 1 AND id = 10");
    expect(
      (await client.query("SELECT * FROM public.delete_child")).rows
    ).toEqual([{ id: 1, tenant_id: 1, parent_id: null }]);
  });

  test("changes and removes the delete action column subset without losing rows", async function () {
    if (postgresVersionNum < 150000) {
      await expect(planSchema(subsetSchema)).rejects.toThrow(
        "PostgreSQL 14 does not support foreign-key ON DELETE column lists"
      );
      return;
    }

    const nullableSchema = subsetSchema.replace(
      "tenant_id integer NOT NULL,\n      parent_id integer,",
      "tenant_id integer,\n      parent_id integer,"
    );
    await services.executor.executePlan(client, await planSchema(nullableSchema), true);
    await client.query("INSERT INTO public.delete_parent VALUES (1, 10)");
    await client.query("INSERT INTO public.delete_child VALUES (1, 1, 10)");

    const changedSchema = nullableSchema.replace(
      "SET NULL (parent_id)",
      "SET NULL (tenant_id)"
    );
    const changedPlan = await planSchema(changedSchema);
    const changedSql = changedPlan.transactional.join("\n");
    expect(changedSql).toContain(
      'DROP CONSTRAINT "delete_child_parent_fkey"'
    );
    expect(changedSql).toContain('SET NULL ("tenant_id")');
    await services.executor.executePlan(client, changedPlan, true);
    expect((await planSchema(changedSchema)).hasChanges).toBe(false);

    const plainSchema = changedSchema.replace(
      "SET NULL (tenant_id)",
      "SET NULL"
    );
    await services.executor.executePlan(client, await planSchema(plainSchema), true);
    expect(
      (await client.query("SELECT * FROM public.delete_child")).rows
    ).toEqual([{ id: 1, tenant_id: 1, parent_id: 10 }]);
    expect((await planSchema(plainSchema)).hasChanges).toBe(false);
  });
});
