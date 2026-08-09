import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { cleanDatabase, createTestClient, createTestSchemaService } from "../utils";

const TABLE_NAME = "index_rollback_guard";
const INDEX_NAME = "index_rollback_guard_value_idx";
const FUNCTION_NAME = "index_rollback_invalid";

describe("PostgreSQL transactional index rollback", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  test("rolls an index creation back when a later routine definition fails", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE TABLE public.${TABLE_NAME} (
        id integer PRIMARY KEY,
        value integer NOT NULL
      );
    `;
    const failing = `
      ${initial}

      CREATE INDEX ${INDEX_NAME} ON public.${TABLE_NAME} (value);

      CREATE FUNCTION public.${FUNCTION_NAME}()
      RETURNS void
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE NOTICE;
      END;
      $$;
    `;

    await service.apply(initial, ["public"], true);
    await client.query(`INSERT INTO public.${TABLE_NAME} (id, value) VALUES (1, 7)`);
    const before = await client.query(`
      SELECT oid
      FROM pg_class
      WHERE oid = 'public.${TABLE_NAME}'::regclass
    `);
    const indexStatement =
      `CREATE INDEX "${INDEX_NAME}" ON "public"."${TABLE_NAME}" ("value");`;
    const plan = await service.plan(failing, ["public"]);

    expect(plan.transactional).toContain(indexStatement);
    expect(plan.transactional.findIndex(function findIndex(statement) {
      return statement === indexStatement;
    })).toBeLessThan(plan.transactional.findIndex(function findInvalidFunction(statement) {
      return statement.includes(`"${FUNCTION_NAME}"`);
    }));
    expect(plan.concurrent).toEqual([]);

    await expect(service.apply(failing, ["public"], true)).rejects.toMatchObject({
      code: "MIGRATION_ERROR",
    });

    const after = await client.query(`
      SELECT
        'public.${TABLE_NAME}'::regclass::oid AS table_oid,
        to_regclass('public.${INDEX_NAME}') AS index_relation,
        to_regprocedure('public.${FUNCTION_NAME}()') AS invalid_function
    `);
    expect(after.rows).toEqual([{
      table_oid: before.rows[0]!.oid,
      index_relation: null,
      invalid_function: null,
    }]);
    expect(
      (await client.query(`SELECT id, value FROM public.${TABLE_NAME}`)).rows
    ).toEqual([{ id: 1, value: 7 }]);
    expect((await service.plan(initial, ["public"])).hasChanges).toBe(false);
  });
});
