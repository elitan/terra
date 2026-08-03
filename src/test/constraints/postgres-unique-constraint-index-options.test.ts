import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL unique constraint index options", function () {
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

  test("creates, inspects, and reapplies physical index options", async function () {
    const schema = `
      CREATE TABLE public.unique_options (
        id integer NOT NULL,
        email text,
        display_name text,
        updated_at timestamp,
        CONSTRAINT unique_options_email_key
          UNIQUE (email)
          INCLUDE (display_name, updated_at)
          WITH (fillfactor=75)
          USING INDEX TABLESPACE pg_default
          DEFERRABLE INITIALLY DEFERRED
      );
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);

    const table = (await services.inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "unique_options";
      }
    );
    expect(table?.uniqueConstraints).toEqual([
      {
        name: "unique_options_email_key",
        columns: ["email"],
        include: ["display_name", "updated_at"],
        storageParameters: { fillfactor: "75" },
        deferrable: true,
        initiallyDeferred: true,
      },
    ]);
    expect(table?.indexes).toEqual([]);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("keeps included columns out of uniqueness semantics", async function () {
    const schema = `
      CREATE TABLE public.unique_payload_semantics (
        id integer NOT NULL,
        email text,
        display_name text,
        CONSTRAINT unique_payload_semantics_email_key
          UNIQUE (email) INCLUDE (display_name)
      );
    `;
    await services.executor.executePlan(client, await planSchema(schema), true);
    await client.query(`
      INSERT INTO public.unique_payload_semantics
        VALUES (1, 'a@example.com', 'First');
    `);
    await expect(
      client.query(`
        INSERT INTO public.unique_payload_semantics
          VALUES (2, 'a@example.com', 'Second');
      `)
    ).rejects.toThrow(/unique_payload_semantics_email_key/);
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("changes and removes index options without losing rows", async function () {
    await client.query(`
      CREATE TABLE public.unique_options_lifecycle (
        id integer NOT NULL,
        email text,
        display_name text,
        updated_at timestamp,
        CONSTRAINT unique_options_lifecycle_email_key
          UNIQUE (email)
          INCLUDE (display_name)
          WITH (fillfactor=70)
      );
      INSERT INTO public.unique_options_lifecycle
        VALUES (1, 'a@example.com', 'First', '2026-08-03 12:00:00');
    `);
    const changedSchema = `
      CREATE TABLE public.unique_options_lifecycle (
        id integer NOT NULL,
        email text,
        display_name text,
        updated_at timestamp,
        CONSTRAINT unique_options_lifecycle_email_key
          UNIQUE (email)
          INCLUDE (updated_at, display_name)
          WITH (fillfactor=80)
      );
    `;
    const changedPlan = await planSchema(changedSchema);
    const changedSql = [
      ...changedPlan.transactional,
      ...changedPlan.concurrent,
    ].join("\n");
    expect(changedSql).toContain(
      'DROP CONSTRAINT "unique_options_lifecycle_email_key"'
    );
    expect(changedSql).toContain('INCLUDE ("updated_at", "display_name")');
    expect(changedSql).toContain("WITH (fillfactor=80)");
    await services.executor.executePlan(client, changedPlan, true);
    expect((await planSchema(changedSchema)).hasChanges).toBe(false);

    const plainSchema = changedSchema
      .replace("\n          INCLUDE (updated_at, display_name)", "")
      .replace("\n          WITH (fillfactor=80)", "");
    await services.executor.executePlan(client, await planSchema(plainSchema), true);
    expect(
      (await client.query(
        "SELECT id, email FROM public.unique_options_lifecycle"
      )).rows
    ).toEqual([{ id: 1, email: "a@example.com" }]);
    expect((await planSchema(plainSchema)).hasChanges).toBe(false);
  });
});
