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

  test("rejects same-apply user-defined virtual generated column types before mutation", async function () {
    const service = createTestSchemaService();
    const scenarios = [
      {
        name: "enum",
        definition: "CREATE TYPE public.virtual_dependency_enum AS ENUM ('valid');",
      },
      {
        name: "composite",
        definition: "CREATE TYPE public.virtual_dependency_composite AS (value text);",
      },
      {
        name: "domain",
        definition: "CREATE DOMAIN public.virtual_dependency_domain AS text;",
      },
      {
        name: "range",
        definition: "CREATE TYPE public.virtual_dependency_range AS RANGE (SUBTYPE = integer);",
      },
    ];
    const versionResult = await client.query("SHOW server_version_num");

    for (const scenario of scenarios) {
      const typeName = `virtual_dependency_${scenario.name}`;
      const tableName = `virtual_dependency_${scenario.name}_records`;
      const desired = `
        ${scenario.definition}

        CREATE TABLE public.${tableName} (
          source text NOT NULL,
          computed public.${typeName} GENERATED ALWAYS AS (source) VIRTUAL
        );
      `;
      const error = await service.plan(desired, ["public"]).then(
        function planUnexpectedlySucceeded() {
          throw new Error("Expected virtual generated column planning to fail");
        },
        function returnPlanError(reason) {
          return reason;
        }
      );

      expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
      if (Number(versionResult.rows[0]?.server_version_num) >= 180000) {
        expect(String(error)).toContain("cannot use user-defined type");
      } else {
        expect(String(error)).toContain("does not support virtual generated columns");
      }
      expect(
        (await client.query(
          "SELECT to_regtype($1) AS type, to_regclass($2) AS relation",
          [`public.${typeName}`, `public.${tableName}`]
        )).rows
      ).toEqual([{ type: null, relation: null }]);
    }
  });
});
