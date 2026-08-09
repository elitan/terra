import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { cleanDatabase, createTestClient, createTestSchemaService } from "../utils";

const TABLE_NAME = "constraint_rollback_guard";
const CONSTRAINT_NAME = "constraint_rollback_guard_value_check";
const FUNCTION_NAME = "constraint_rollback_invalid";

describe("PostgreSQL transactional constraint rollback", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  test("rolls a constraint addition back when a later routine definition fails", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE TABLE public.${TABLE_NAME} (
        id integer PRIMARY KEY,
        value integer NOT NULL
      );
    `;
    const failing = `
      ${initial}

      ALTER TABLE public.${TABLE_NAME}
        ADD CONSTRAINT ${CONSTRAINT_NAME} CHECK (value > 0);

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
    const plan = await service.plan(failing, ["public"]);
    const constraintIndex = plan.transactional.findIndex(function findConstraint(statement) {
      return statement.includes(`ADD CONSTRAINT "${CONSTRAINT_NAME}"`);
    });
    const functionIndex = plan.transactional.findIndex(function findInvalidFunction(statement) {
      return statement.includes(`"${FUNCTION_NAME}"`);
    });

    expect(constraintIndex).toBeGreaterThanOrEqual(0);
    expect(constraintIndex).toBeLessThan(functionIndex);
    expect(plan.concurrent).toEqual([]);

    await expect(service.apply(failing, ["public"], true)).rejects.toMatchObject({
      code: "MIGRATION_ERROR",
    });

    const after = await client.query(`
      SELECT
        'public.${TABLE_NAME}'::regclass::oid AS table_oid,
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.${TABLE_NAME}'::regclass
            AND conname = '${CONSTRAINT_NAME}'
        ) AS constraint_exists,
        to_regprocedure('public.${FUNCTION_NAME}()') AS invalid_function
    `);
    expect(after.rows).toEqual([{
      table_oid: before.rows[0]!.oid,
      constraint_exists: false,
      invalid_function: null,
    }]);
    expect(
      (await client.query(`SELECT id, value FROM public.${TABLE_NAME}`)).rows
    ).toEqual([{ id: 1, value: 7 }]);
    expect((await service.plan(initial, ["public"])).hasChanges).toBe(false);
  });
});
