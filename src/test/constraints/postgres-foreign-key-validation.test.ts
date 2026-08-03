import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL foreign key validation state", function () {
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

  const notValidSchema = `
    CREATE TABLE public.validation_parent (
      id integer PRIMARY KEY
    );
    CREATE TABLE public.validation_child (
      id integer PRIMARY KEY,
      parent_id integer
    );
    ALTER TABLE public.validation_child
      ADD CONSTRAINT validation_child_parent_fkey
      FOREIGN KEY (parent_id) REFERENCES public.validation_parent (id)
      NOT VALID;
  `;

  const validSchema = `
    CREATE TABLE public.validation_parent (
      id integer PRIMARY KEY
    );
    CREATE TABLE public.validation_child (
      id integer PRIMARY KEY,
      parent_id integer,
      CONSTRAINT validation_child_parent_fkey
        FOREIGN KEY (parent_id) REFERENCES public.validation_parent (id)
    );
  `;

  test("creates, inspects, and reapplies a declarative NOT VALID foreign key", async function () {
    const parsed = await services.parser.parseSchema(notValidSchema);
    const parsedChild = parsed.tables.find(function findChild(table) {
      return table.name === "validation_child";
    });
    expect(parsedChild?.foreignKeys?.[0]?.notValid).toBe(true);

    await services.executor.executePlan(client, await planSchema(notValidSchema), true);
    const inspectedChild = (await services.inspector.getCurrentSchema(client)).find(
      function findChild(table) {
        return table.name === "validation_child";
      }
    );
    expect(inspectedChild?.foreignKeys?.[0]?.notValid).toBe(true);
    expect((await planSchema(notValidSchema)).hasChanges).toBe(false);
  });

  test("rolls back failed validation, then validates after legacy rows are repaired", async function () {
    await client.query(`
      CREATE TABLE public.validation_parent (id integer PRIMARY KEY);
      CREATE TABLE public.validation_child (
        id integer PRIMARY KEY,
        parent_id integer
      );
      INSERT INTO public.validation_child VALUES (1, 99);
      ALTER TABLE public.validation_child
        ADD CONSTRAINT validation_child_parent_fkey
        FOREIGN KEY (parent_id) REFERENCES public.validation_parent (id)
        NOT VALID;
    `);

    const invalidPlan = await planSchema(validSchema);
    const invalidSql = [
      ...invalidPlan.transactional,
      ...invalidPlan.concurrent,
    ].join("\n");
    expect(invalidSql).toContain(
      'VALIDATE CONSTRAINT "validation_child_parent_fkey"'
    );
    expect(invalidSql).not.toContain("DROP CONSTRAINT");
    await expect(
      services.executor.executePlan(client, invalidPlan, true)
    ).rejects.toThrow(/validation_child_parent_fkey/);

    const stillInvalid = (await services.inspector.getCurrentSchema(client)).find(
      function findChild(table) {
        return table.name === "validation_child";
      }
    );
    expect(stillInvalid?.foreignKeys?.[0]?.notValid).toBe(true);

    await client.query("INSERT INTO public.validation_parent VALUES (99)");
    const repairedPlan = await planSchema(validSchema);
    expect(repairedPlan.transactional.join("\n")).toContain(
      'VALIDATE CONSTRAINT "validation_child_parent_fkey"'
    );
    await services.executor.executePlan(client, repairedPlan, true);

    const validated = (await services.inspector.getCurrentSchema(client)).find(
      function findChild(table) {
        return table.name === "validation_child";
      }
    );
    expect(validated?.foreignKeys?.[0]?.notValid).toBeUndefined();
    expect((await planSchema(validSchema)).hasChanges).toBe(false);
  });

  test("changes a validated foreign key to NOT VALID without losing rows", async function () {
    await services.executor.executePlan(client, await planSchema(validSchema), true);
    await client.query("INSERT INTO public.validation_parent VALUES (1)");
    await client.query("INSERT INTO public.validation_child VALUES (1, 1)");

    const notValidPlan = await planSchema(notValidSchema);
    const sql = notValidPlan.transactional.join("\n");
    expect(sql).toContain('DROP CONSTRAINT "validation_child_parent_fkey"');
    expect(sql).toContain("NOT VALID");
    await services.executor.executePlan(client, notValidPlan, true);

    expect(
      (await client.query("SELECT * FROM public.validation_child")).rows
    ).toEqual([{ id: 1, parent_id: 1 }]);
    expect((await planSchema(notValidSchema)).hasChanges).toBe(false);
  });
});
