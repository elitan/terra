import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { cleanDatabase, createTestClient, createTestSchemaService } from "../utils";

describe("PostgreSQL generated-column function dependencies", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  test("creates a same-apply function before a table that uses it in a stored generated column", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE FUNCTION public.generated_dependency_normalize(value text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      AS $$ SELECT lower(value); $$;

      CREATE TABLE public.generated_dependency_records (
        source text NOT NULL,
        normalized text GENERATED ALWAYS AS (
          public.generated_dependency_normalize(source)
        ) STORED
      );
    `;
    const plan = await service.plan(desired, ["public"]);
    const functionIndex = plan.transactional.findIndex(function findFunction(statement) {
      return statement.includes('CREATE FUNCTION "public"."generated_dependency_normalize"');
    });
    const tableIndex = plan.transactional.findIndex(function findTable(statement) {
      return statement.includes('CREATE TABLE "public"."generated_dependency_records"');
    });

    expect(functionIndex).toBeGreaterThanOrEqual(0);
    expect(functionIndex).toBeLessThan(tableIndex);

    await service.apply(desired, ["public"], true);
    await client.query(
      "INSERT INTO public.generated_dependency_records (source) VALUES ('TeRrAdB')"
    );
    expect(
      (await client.query(
        "SELECT source, normalized FROM public.generated_dependency_records"
      )).rows
    ).toEqual([{ source: "TeRrAdB", normalized: "terradb" }]);
    expect((await service.plan(desired, ["public"])).hasChanges).toBe(false);
  });

  test("rejects a same-apply function in a virtual generated expression before mutation", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE FUNCTION public.virtual_dependency_normalize(value text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      AS $$ SELECT lower(value); $$;

      CREATE TABLE public.virtual_dependency_records (
        source text NOT NULL,
        normalized text GENERATED ALWAYS AS (
          public.virtual_dependency_normalize(source)
        ) VIRTUAL
      );
    `;

    await expect(service.plan(desired, ["public"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(
      (await client.query(`
        SELECT
          to_regprocedure('public.virtual_dependency_normalize(text)') AS routine,
          to_regclass('public.virtual_dependency_records') AS relation
      `)).rows
    ).toEqual([{ routine: null, relation: null }]);
  });
});
