import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { DatabaseInspector } from "../../core/schema/inspector";
import { SchemaParser } from "../../core/schema/parser";
import {
  generateCreateFunctionSQL,
  generateCreateProcedureSQL,
} from "../../utils/sql";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

describe("PostgreSQL routine security options", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  async function getRoutineMetadata(name: string): Promise<{
    oid: number;
    leakproof: boolean;
    configuration: string[] | null;
    argumentNames: string[] | null;
  }> {
    const result = await client.query(
      `
        SELECT
          p.oid::integer AS oid,
          p.proleakproof AS leakproof,
          p.proconfig AS configuration,
          p.proargnames AS "argumentNames"
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = $1
      `,
      [name]
    );
    if (!result.rows[0]) {
      throw new Error(`Missing routine public.${name}`);
    }
    return result.rows[0];
  }

  test("parses and generates deterministic routine security options", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE FUNCTION public.configured_function(value text)
      RETURNS text
      LANGUAGE sql
      SECURITY DEFINER
      LEAKPROOF
      SET search_path = pg_catalog, "Case Schema", "schema,with,comma"
      SET application_name TO 'routine function'
      AS $$ SELECT value $$;

      CREATE PROCEDURE public.configured_procedure(value text)
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$ BEGIN NULL; END $$;

      CREATE FUNCTION public.defaulted_configuration()
      RETURNS integer LANGUAGE sql
      SET application_name = 'discarded'
      SET application_name TO DEFAULT
      AS $$ SELECT 1 $$;
    `);

    expect(parsed.functions[0]).toMatchObject({
      leakproof: true,
      configuration: {
        application_name: "routine function",
        search_path: 'pg_catalog, "Case Schema", "schema,with,comma"',
      },
    });
    expect(parsed.procedures[0]).toMatchObject({
      configuration: {
        search_path: "pg_catalog, pg_temp",
      },
    });

    const functionSql = generateCreateFunctionSQL(parsed.functions[0]!);
    expect(functionSql).toContain("LEAKPROOF");
    expect(functionSql).toContain("SET application_name TO 'routine function'");
    expect(functionSql).toContain(
      "SET search_path TO 'pg_catalog', 'Case Schema', 'schema,with,comma'"
    );
    const procedureSql = generateCreateProcedureSQL(parsed.procedures[0]!);
    expect(procedureSql).toContain("SET search_path TO 'pg_catalog', 'pg_temp'");
    expect(parsed.functions[1]?.configuration).toBeUndefined();
  });

  test("rejects nondeterministic and unmodeled routine forms before planning", async function () {
    const parser = new SchemaParser();
    const scenarios = [
      {
        label: "SET FROM CURRENT",
        sql: `
          CREATE FUNCTION public.unsupported_routine() RETURNS integer
          LANGUAGE sql SET statement_timeout FROM CURRENT
          AS $$ SELECT 1 $$;
        `,
      },
      {
        label: "SUPPORT",
        sql: `
          CREATE FUNCTION public.unsupported_routine(integer) RETURNS integer
          LANGUAGE internal SUPPORT public.support_routine AS 'int4abs';
        `,
      },
      {
        label: "WINDOW",
        sql: `
          CREATE FUNCTION public.unsupported_routine(internal) RETURNS internal
          LANGUAGE internal WINDOW AS 'window_dense_rank';
        `,
      },
      {
        label: "TRANSFORM",
        sql: `
          CREATE FUNCTION public.unsupported_routine(integer) RETURNS integer
          LANGUAGE plpython3u TRANSFORM FOR TYPE integer
          AS $$ return args[0] $$;
        `,
      },
      {
        label: "SQL-standard body",
        sql: `
          CREATE FUNCTION public.unsupported_routine(value integer)
          RETURNS integer LANGUAGE sql RETURN value + 1;
        `,
      },
      {
        label: "linked object",
        sql: `
          CREATE FUNCTION public.unsupported_routine(integer) RETURNS integer
          LANGUAGE c AS 'library_file', 'link_symbol';
        `,
      },
      {
        label: "linked object",
        sql: `
          CREATE FUNCTION public.unsupported_routine(integer) RETURNS integer
          AS 'library_file' LANGUAGE c;
        `,
      },
      {
        label: "procedure linked object",
        sql: `
          CREATE PROCEDURE public.unsupported_routine(integer)
          AS 'library_file' LANGUAGE c;
        `,
      },
      {
        label: "procedure SQL-standard body",
        sql: `
          CREATE PROCEDURE public.unsupported_routine()
          LANGUAGE sql BEGIN ATOMIC SELECT 1; END;
        `,
      },
    ];

    for (const scenario of scenarios) {
      try {
        await parser.parseSchema(scenario.sql, "routines.sql");
        throw new Error(`Expected ${scenario.label} to be rejected`);
      } catch (error) {
        expect(error).toMatchObject({
          code: "PARSER_ERROR",
          filePath: "routines.sql",
        });
        expect((error as Error).message).toContain(scenario.label);
      }
    }
  });

  test("preserves empty quoted routine bodies without destructive drift", async function () {
    const schema = `
      CREATE FUNCTION public.empty_body_function()
      RETURNS void LANGUAGE sql AS '';

      CREATE PROCEDURE public.empty_body_procedure()
      AS $$$$ LANGUAGE sql;
    `;
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(schema);
    expect(parsed.functions).toHaveLength(1);
    expect(parsed.functions[0]?.body).toBe("");
    expect(parsed.procedures).toHaveLength(1);
    expect(parsed.procedures[0]?.body).toBe("");

    await client.query(schema);
    const service = createTestSchemaService();
    const externalPlan = await service.plan(schema, ["public"]);
    expect(externalPlan.hasChanges).toBe(false);
    expect(externalPlan.transactional).toEqual([]);

    await cleanDatabase(client);
    const creation = await service.apply(schema, ["public"], true);
    expect(creation.transactional.some(function createsFunction(statement) {
      return statement.includes("CREATE FUNCTION");
    })).toBe(true);
    expect(creation.transactional.some(function createsProcedure(statement) {
      return statement.includes("CREATE PROCEDURE");
    })).toBe(true);

    const routines = await client.query(`
      SELECT p.proname, p.prosrc
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('empty_body_function', 'empty_body_procedure')
      ORDER BY p.proname
    `);
    expect(routines.rows.map(function normalizeBody(row) {
      return { name: row.proname, body: row.prosrc.trim() };
    })).toEqual([
      { name: "empty_body_function", body: "" },
      { name: "empty_body_procedure", body: "" },
    ]);
    expect((await service.plan(schema, ["public"])).hasChanges).toBe(false);
  });

  test("changes and resets routine options without losing OIDs or dependents", async function () {
    const initialSchema = `
      CREATE TABLE public.routine_config_log (value text NOT NULL);

      CREATE FUNCTION public.current_routine_setting()
      RETURNS text
      LANGUAGE sql
      SECURITY DEFINER
      NOT LEAKPROOF
      SET application_name = 'function-v1'
      SET search_path = pg_catalog, pg_temp
      AS $$ SELECT current_setting('application_name') $$;

      CREATE PROCEDURE public.record_routine_setting()
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET application_name = 'procedure-v1'
      AS $$
      BEGIN
        INSERT INTO public.routine_config_log
        VALUES (current_setting('application_name'));
      END
      $$;

      CREATE VIEW public.routine_setting_view AS
        SELECT public.current_routine_setting() AS value;
    `;
    const updatedSchema = initialSchema
      .replace("NOT LEAKPROOF", "LEAKPROOF")
      .replace("function-v1", "function-v2")
      .replace("procedure-v1", "procedure-v2");
    const service = createTestSchemaService();
    await service.apply(initialSchema, ["public"], true);
    const initialFunction = await getRoutineMetadata("current_routine_setting");
    const initialProcedure = await getRoutineMetadata("record_routine_setting");

    await client.query("SET application_name = 'session-value'");
    expect(
      (await client.query("SELECT public.current_routine_setting() AS value"))
        .rows[0]?.value
    ).toBe("function-v1");
    expect(
      (await client.query("SELECT current_setting('application_name') AS value"))
        .rows[0]?.value
    ).toBe("session-value");
    await client.query("CALL public.record_routine_setting()");
    expect(
      (await client.query("SELECT value FROM public.routine_config_log"))
        .rows
    ).toEqual([{ value: "procedure-v1" }]);

    const failingSchema = `${updatedSchema}
      CREATE VIEW public.invalid_routine_view AS
        SELECT missing_column FROM public.routine_config_log;
    `;
    await expect(
      service.apply(failingSchema, ["public"], true)
    ).rejects.toThrow('column "missing_column" does not exist');
    expect(await getRoutineMetadata("current_routine_setting")).toEqual(
      initialFunction
    );
    expect(await getRoutineMetadata("record_routine_setting")).toEqual(
      initialProcedure
    );

    const updatePlan = await service.plan(updatedSchema, ["public"]);
    expect(
      updatePlan.transactional.some(function replacesFunction(statement) {
        return statement.startsWith(
          'CREATE OR REPLACE FUNCTION "public"."current_routine_setting"'
        );
      })
    ).toBe(true);
    expect(
      updatePlan.transactional.some(function replacesProcedure(statement) {
        return statement.startsWith(
          'CREATE OR REPLACE PROCEDURE "public"."record_routine_setting"'
        );
      })
    ).toBe(true);
    await service.apply(updatedSchema, ["public"], true);

    const updatedFunction = await getRoutineMetadata("current_routine_setting");
    const updatedProcedure = await getRoutineMetadata("record_routine_setting");
    expect(updatedFunction).toMatchObject({
      oid: initialFunction.oid,
      leakproof: true,
      configuration: [
        "application_name=function-v2",
        "search_path=pg_catalog, pg_temp",
      ],
    });
    expect(updatedProcedure).toMatchObject({
      oid: initialProcedure.oid,
      configuration: ["application_name=procedure-v2"],
    });
    expect(
      (await client.query("SELECT value FROM public.routine_setting_view"))
        .rows
    ).toEqual([{ value: "function-v2" }]);
    expect((await service.plan(updatedSchema, ["public"])).hasChanges).toBe(
      false
    );

    const resetSchema = `
      CREATE TABLE public.routine_config_log (value text NOT NULL);
      CREATE FUNCTION public.current_routine_setting()
      RETURNS text LANGUAGE sql SECURITY DEFINER
      AS $$ SELECT current_setting('application_name') $$;
      CREATE PROCEDURE public.record_routine_setting()
      LANGUAGE plpgsql SECURITY DEFINER
      AS $$
      BEGIN
        INSERT INTO public.routine_config_log
        VALUES (current_setting('application_name'));
      END
      $$;
      CREATE VIEW public.routine_setting_view AS
        SELECT public.current_routine_setting() AS value;
    `;
    await service.apply(resetSchema, ["public"], true);
    expect(await getRoutineMetadata("current_routine_setting")).toMatchObject({
      oid: initialFunction.oid,
      leakproof: false,
      configuration: null,
    });
    expect(await getRoutineMetadata("record_routine_setting")).toMatchObject({
      oid: initialProcedure.oid,
      configuration: null,
    });
    expect(
      (await client.query("SELECT value FROM public.routine_setting_view"))
        .rows
    ).toEqual([{ value: "session-value" }]);
    expect((await service.plan(resetSchema, ["public"])).hasChanges).toBe(false);
  });

  test("detects option drift on externally created routines", async function () {
    await client.query(`
      CREATE FUNCTION public.external_routine_setting()
      RETURNS text LANGUAGE sql LEAKPROOF
      SET application_name = 'external-value'
      AS $$ SELECT current_setting('application_name') $$;
    `);
    const desiredSchema = `
      CREATE FUNCTION public.external_routine_setting()
      RETURNS text LANGUAGE sql NOT LEAKPROOF
      SET application_name = 'desired-value'
      AS $$ SELECT current_setting('application_name') $$;
    `;
    const service = createTestSchemaService();

    const plan = await service.plan(desiredSchema, ["public"]);
    expect(plan.transactional).toHaveLength(1);
    expect(plan.transactional[0]).toStartWith(
      'CREATE OR REPLACE FUNCTION "public"."external_routine_setting"'
    );
    await service.apply(desiredSchema, ["public"], true);
    expect(await getRoutineMetadata("external_routine_setting")).toMatchObject({
      leakproof: false,
      configuration: ["application_name=desired-value"],
    });
    expect((await service.plan(desiredSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("inspects routine configuration as semantic records", async function () {
    await client.query(`
      CREATE FUNCTION public.inspected_function() RETURNS integer
      LANGUAGE sql LEAKPROOF
      SET search_path TO pg_catalog, pg_temp
      SET application_name TO 'inspected function'
      AS $$ SELECT 1 $$;
      CREATE PROCEDURE public.inspected_procedure()
      LANGUAGE sql SET application_name = 'inspected procedure'
      AS $$ SELECT 1 $$;
    `);

    const inspector = new DatabaseInspector();
    const functions = await inspector.getCurrentFunctions(client, ["public"]);
    const procedures = await inspector.getCurrentProcedures(client, ["public"]);
    expect(functions[0]).toMatchObject({
      leakproof: true,
      configuration: {
        application_name: "inspected function",
        search_path: "pg_catalog, pg_temp",
      },
    });
    expect(procedures[0]).toMatchObject({
      configuration: {
        application_name: "inspected procedure",
      },
    });
  });

  test("normalizes language-dependent function cost defaults", async function () {
    const desiredSchema = `
      CREATE FUNCTION public.default_internal_cost(value integer)
      RETURNS integer LANGUAGE internal
      AS 'int4abs';

      CREATE FUNCTION public.explicit_internal_cost(value integer)
      RETURNS integer LANGUAGE internal COST 100
      AS 'int4abs';
    `;
    await client.query(desiredSchema);

    const catalog = await client.query(`
      SELECT p.proname AS name, p.procost::double precision AS cost
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
      ORDER BY p.proname
    `);
    expect(catalog.rows).toEqual([
      { name: "default_internal_cost", cost: 1 },
      { name: "explicit_internal_cost", cost: 100 },
    ]);

    const inspected = await new DatabaseInspector().getCurrentFunctions(
      client,
      ["public"]
    );
    expect(
      inspected.find(function findDefaultCost(func) {
        return func.name === "default_internal_cost";
      })?.cost
    ).toBeUndefined();
    expect(
      inspected.find(function findExplicitCost(func) {
        return func.name === "explicit_internal_cost";
      })?.cost
    ).toBe(100);

    const plan = await createTestSchemaService().plan(desiredSchema, ["public"]);
    expect(plan.hasChanges).toBe(false);
  });

  test("adds input parameter names without dropping routine dependents", async function () {
    const initialSchema = `
      CREATE FUNCTION public.nameable_function(integer)
      RETURNS integer LANGUAGE sql
      AS $$ SELECT $1 $$;

      CREATE PROCEDURE public.nameable_procedure(integer)
      LANGUAGE plpgsql
      AS $$ BEGIN NULL; END $$;

      CREATE VIEW public.nameable_function_view AS
        SELECT public.nameable_function(1) AS value;
    `;
    const desiredSchema = `
      CREATE FUNCTION public.nameable_function(value integer)
      RETURNS integer LANGUAGE sql
      AS $$ SELECT $1 $$;

      CREATE PROCEDURE public.nameable_procedure(value integer)
      LANGUAGE plpgsql
      AS $$ BEGIN NULL; END $$;

      CREATE VIEW public.nameable_function_view AS
        SELECT public.nameable_function(1) AS value;
    `;
    const service = createTestSchemaService();
    await service.apply(initialSchema, ["public"], true);
    const initialFunction = await getRoutineMetadata("nameable_function");
    const initialProcedure = await getRoutineMetadata("nameable_procedure");

    const plan = await service.plan(desiredSchema, ["public"]);
    expect(plan.transactional).toHaveLength(2);
    expect(plan.transactional[0]).toStartWith("CREATE OR REPLACE FUNCTION");
    expect(plan.transactional[1]).toStartWith("CREATE OR REPLACE PROCEDURE");
    expect(plan.transactional.join("\n")).not.toContain("DROP");
    await service.apply(desiredSchema, ["public"], true);

    expect(await getRoutineMetadata("nameable_function")).toMatchObject({
      oid: initialFunction.oid,
      argumentNames: ["value"],
    });
    expect(await getRoutineMetadata("nameable_procedure")).toMatchObject({
      oid: initialProcedure.oid,
      argumentNames: ["value"],
    });
    expect(
      (await client.query("SELECT value FROM public.nameable_function_view"))
        .rows
    ).toEqual([{ value: 1 }]);
    expect((await service.plan(desiredSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("rejects dependency-breaking routine recreation before mutation", async function () {
    const initialSchema = `
      CREATE TABLE public.dependent_return_change_rows (value integer);
      CREATE FUNCTION public.dependent_return_change(value integer)
      RETURNS integer LANGUAGE sql IMMUTABLE
      AS $$ SELECT value $$;
      CREATE INDEX dependent_return_change_index
        ON public.dependent_return_change_rows
        (public.dependent_return_change(value));
      CREATE VIEW public.dependent_return_change_view AS
        SELECT public.dependent_return_change(1) AS value;
    `;
    const desiredSchema = `
      CREATE TABLE public.dependent_return_change_rows (value integer);
      CREATE FUNCTION public.dependent_return_change(value integer)
      RETURNS text LANGUAGE sql IMMUTABLE
      AS $$ SELECT value::text $$;
      CREATE INDEX dependent_return_change_index
        ON public.dependent_return_change_rows
        (public.dependent_return_change(value));
      CREATE VIEW public.dependent_return_change_view AS
        SELECT public.dependent_return_change(1) AS value;
    `;
    const service = createTestSchemaService();
    await client.query(initialSchema);
    const initialFunction = await getRoutineMetadata("dependent_return_change");

    try {
      await service.plan(desiredSchema, ["public"]);
      throw new Error("Expected dependent routine recreation to be rejected");
    } catch (error) {
      expect(error).toMatchObject({
        code: "VALIDATION_ERROR",
        field: "dependentObjects",
      });
      expect((error as Error).message).toContain(
        "index dependent_return_change_index"
      );
      expect((error as Error).message).toContain(
        "rule _RETURN on view dependent_return_change_view"
      );
    }

    expect(await getRoutineMetadata("dependent_return_change")).toEqual(
      initialFunction
    );
    expect(
      (await client.query("SELECT value FROM public.dependent_return_change_view"))
        .rows
    ).toEqual([{ value: 1 }]);
    expect(
      (await client.query("SELECT to_regclass('public.dependent_return_change_index') AS name"))
        .rows[0]?.name
    ).toBe("dependent_return_change_index");
  });

  test("rejects unsupported routines already present in managed schemas", async function () {
    const scenarios = [
      {
        feature: "SQL-standard body",
        identity: "public.external_sql_body(value integer)",
        sql: `
          CREATE FUNCTION public.external_sql_body(value integer)
          RETURNS integer LANGUAGE sql RETURN value + 1;
        `,
      },
      {
        feature: "SQL-standard body",
        identity: "public.external_sql_procedure(IN value integer)",
        sql: `
          CREATE TABLE public.external_procedure_log(value integer);
          CREATE PROCEDURE public.external_sql_procedure(value integer)
          LANGUAGE sql
          BEGIN ATOMIC
            INSERT INTO public.external_procedure_log VALUES (value);
          END;
        `,
      },
      {
        feature: "WINDOW",
        identity: "public.external_window()",
        sql: `
          CREATE FUNCTION public.external_window()
          RETURNS bigint LANGUAGE internal WINDOW
          AS 'window_row_number';
        `,
      },
      {
        feature: "SUPPORT",
        identity: "public.external_support(value text)",
        sql: `
          CREATE FUNCTION public.external_support(value text)
          RETURNS text LANGUAGE sql SUPPORT varchar_support
          AS $$ SELECT value $$;
        `,
      },
      {
        feature: "aggregate",
        identity: "public.external_sum(integer)",
        sql: `
          CREATE AGGREGATE public.external_sum(integer) (
            SFUNC = int4pl,
            STYPE = integer,
            INITCOND = '0'
          );
        `,
        cleanup: "DROP AGGREGATE IF EXISTS public.external_sum(integer)",
      },
    ];
    const service = createTestSchemaService();

    for (const scenario of scenarios) {
      try {
        await client.query(scenario.sql);
        try {
          await service.plan("", ["public"]);
          throw new Error(`Expected ${scenario.feature} to be rejected`);
        } catch (error) {
          expect(error).toMatchObject({
            code: "VALIDATION_ERROR",
            field: "definition",
          });
          expect((error as Error).message).toContain(scenario.feature);
          expect((error as Error).message).toContain(scenario.identity);
        }
      } finally {
        if (scenario.cleanup) {
          await client.query(scenario.cleanup);
        }
        await cleanDatabase(client);
      }
    }
  });
});
