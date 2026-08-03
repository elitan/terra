import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL check constraint metadata", function () {
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

  const validSchema = `
    CREATE TABLE public.check_metadata (
      id integer PRIMARY KEY,
      amount integer,
      CONSTRAINT check_metadata_amount_check
        CHECK (amount > 0) NO INHERIT
    );
  `;

  const notValidSchema = `
    CREATE TABLE public.check_metadata (
      id integer PRIMARY KEY,
      amount integer
    );
    ALTER TABLE public.check_metadata
      ADD CONSTRAINT check_metadata_amount_check
      CHECK (amount > 0) NO INHERIT NOT VALID;
  `;

  test("creates, inspects, enforces, and reapplies a NOT VALID NO INHERIT check", async function () {
    const parsed = await services.parser.parseSchema(notValidSchema);
    expect(parsed.tables[0]?.checkConstraints).toEqual([
      {
        name: "check_metadata_amount_check",
        expression: "amount > 0",
        noInherit: true,
        notValid: true,
      },
    ]);

    const plan = await planSchema(notValidSchema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain("CREATE TABLE");
    expect(sql).toContain("NO INHERIT NOT VALID");
    await services.executor.executePlan(client, plan, true);

    const inspected = (await services.inspector.getCurrentSchema(client))[0];
    expect(inspected?.checkConstraints).toEqual([
      expect.objectContaining({
        name: "check_metadata_amount_check",
        noInherit: true,
        notValid: true,
      }),
    ]);
    await expect(
      client.query("INSERT INTO public.check_metadata VALUES (1, -1)")
    ).rejects.toThrow(/check_metadata_amount_check/);
    expect((await planSchema(notValidSchema)).hasChanges).toBe(false);
  });

  test("rolls back failed validation, then validates in place after rows are repaired", async function () {
    await client.query(`
      CREATE TABLE public.check_metadata (
        id integer PRIMARY KEY,
        amount integer
      );
      INSERT INTO public.check_metadata VALUES (1, -1);
      ALTER TABLE public.check_metadata
        ADD CONSTRAINT check_metadata_amount_check
        CHECK (amount > 0) NO INHERIT NOT VALID;
    `);

    const invalidPlan = await planSchema(validSchema);
    const invalidSql = invalidPlan.transactional.join("\n");
    expect(invalidSql).toContain(
      'VALIDATE CONSTRAINT "check_metadata_amount_check"'
    );
    expect(invalidSql).not.toContain("DROP CONSTRAINT");
    await expect(
      services.executor.executePlan(client, invalidPlan, true)
    ).rejects.toThrow(/check_metadata_amount_check/);

    const stillInvalid = (await services.inspector.getCurrentSchema(client))[0];
    expect(stillInvalid?.checkConstraints?.[0]?.notValid).toBe(true);

    await client.query(
      "UPDATE public.check_metadata SET amount = 1 WHERE id = 1"
    );
    await services.executor.executePlan(client, await planSchema(validSchema), true);

    const validated = (await services.inspector.getCurrentSchema(client))[0];
    expect(validated?.checkConstraints?.[0]?.notValid).toBeUndefined();
    expect(validated?.checkConstraints?.[0]?.noInherit).toBe(true);
    expect((await planSchema(validSchema)).hasChanges).toBe(false);
  });

  test("changes a validated check to NOT VALID without losing rows", async function () {
    await services.executor.executePlan(client, await planSchema(validSchema), true);
    await client.query("INSERT INTO public.check_metadata VALUES (1, 1)");

    const plan = await planSchema(notValidSchema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('DROP CONSTRAINT "check_metadata_amount_check"');
    expect(sql).toContain("NO INHERIT NOT VALID");
    await services.executor.executePlan(client, plan, true);

    expect(
      (await client.query("SELECT * FROM public.check_metadata")).rows
    ).toEqual([{ id: 1, amount: 1 }]);
    expect((await planSchema(notValidSchema)).hasChanges).toBe(false);
  });

  test("replaces a check when its inheritance semantics change", async function () {
    await services.executor.executePlan(client, await planSchema(validSchema), true);
    await client.query("INSERT INTO public.check_metadata VALUES (1, 1)");

    const inheritableSchema = validSchema.replace(" NO INHERIT", "");
    const plan = await planSchema(inheritableSchema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain('DROP CONSTRAINT "check_metadata_amount_check"');
    expect(sql).toContain(
      'ADD CONSTRAINT "check_metadata_amount_check" CHECK (amount > 0)'
    );
    expect(sql).not.toContain("NO INHERIT");
    await services.executor.executePlan(client, plan, true);

    expect(
      (await client.query("SELECT * FROM public.check_metadata")).rows
    ).toEqual([{ id: 1, amount: 1 }]);
    const inspected = (await services.inspector.getCurrentSchema(client))[0];
    expect(inspected?.checkConstraints?.[0]?.noInherit).toBeUndefined();
    expect((await planSchema(inheritableSchema)).hasChanges).toBe(false);
  });

  test("keeps a NO INHERIT check local to its parent table", async function () {
    const schema = `
      CREATE TABLE public.check_parent (
        amount integer,
        CONSTRAINT check_parent_amount_check
          CHECK (amount > 0) NO INHERIT
      );
      CREATE TABLE public.check_child ()
        INHERITS (public.check_parent);
    `;

    await services.executor.executePlan(client, await planSchema(schema), true);
    await expect(
      client.query("INSERT INTO public.check_parent VALUES (-1)")
    ).rejects.toThrow(/check_parent_amount_check/);
    await client.query("INSERT INTO public.check_child VALUES (-1)");

    const tables = await services.inspector.getCurrentSchema(client);
    const parent = tables.find(function findParent(table) {
      return table.name === "check_parent";
    });
    const child = tables.find(function findChild(table) {
      return table.name === "check_child";
    });
    expect(parent?.checkConstraints?.[0]?.noInherit).toBe(true);
    expect(child?.inheritedCheckConstraints).toBeUndefined();
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });
});
