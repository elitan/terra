import { describe, expect, test } from "bun:test";
import { FunctionHandler } from "../../core/schema/handlers/function-handler";
import { ProcedureHandler } from "../../core/schema/handlers/procedure-handler";
import type { Function as DbFunction, Procedure } from "../../types/schema";

function makeFunction(overrides: Partial<DbFunction> = {}): DbFunction {
  return {
    name: "compute",
    schema: "public",
    parameters: [{ name: "value", type: "integer" }],
    returnType: "integer",
    language: "sql",
    body: "SELECT value",
    ...overrides,
  };
}

function makeProcedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    name: "sync_data",
    schema: "public",
    parameters: [{ name: "value", type: "integer" }],
    language: "sql",
    body: "SELECT 1",
    ...overrides,
  };
}

describe("routine handler signature scope", function () {
  test("drops only removed function overload when names match", function () {
    const handler = new FunctionHandler();

    const statements = handler.generateStatements(
      [makeFunction({ parameters: [{ name: "value", type: "integer" }] })],
      [
        makeFunction({ parameters: [{ name: "value", type: "integer" }] }),
        makeFunction({ parameters: [{ name: "value", type: "text" }] }),
      ]
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]).toBe('DROP FUNCTION IF EXISTS "public"."compute"(text);');
    expect(statements[0]).not.toContain('(integer)');
  });

  test("creates only missing function overload when one already exists", function () {
    const handler = new FunctionHandler();

    const statements = handler.generateStatements(
      [
        makeFunction({ parameters: [{ name: "value", type: "integer" }] }),
        makeFunction({ parameters: [{ name: "value", type: "text" }], returnType: "text" }),
      ],
      [makeFunction({ parameters: [{ name: "value", type: "integer" }] })]
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('CREATE FUNCTION "public"."compute"("value" text )');
    expect(statements[0]).not.toContain("DROP FUNCTION");
  });

  test("replaces compatible function changes without dropping dependents", function () {
    const handler = new FunctionHandler();
    const statements = handler.generateStatements(
      [makeFunction({ body: "SELECT value + 1" })],
      [makeFunction()]
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]).toStartWith("CREATE OR REPLACE FUNCTION");
  });

  test("uses language-dependent function cost defaults", function () {
    const handler = new FunctionHandler();
    const internal = makeFunction({
      language: "internal",
      body: "int4abs",
    });

    expect(
      handler.generateStatements(
        [internal],
        [{ ...internal, cost: 1 }]
      )
    ).toEqual([]);
    expect(
      handler.generateStatements(
        [{ ...internal, cost: 100 }],
        [{ ...internal, cost: 1 }]
      )[0]
    ).toStartWith("CREATE OR REPLACE FUNCTION");
  });

  test("treats decorative array dimensions as one routine type", function () {
    const functionHandler = new FunctionHandler();
    const procedureHandler = new ProcedureHandler();

    expect(
      functionHandler.generateStatements(
        [makeFunction({
          parameters: [{ name: "value", type: "integer[2][3]" }],
          returnType: "SETOF text[][]",
        })],
        [makeFunction({
          parameters: [{ name: "value", type: "integer[]" }],
          returnType: "SETOF text[]",
        })]
      )
    ).toEqual([]);
    expect(
      procedureHandler.generateStatements(
        [makeProcedure({
          parameters: [{ name: "value", type: "integer[][]" }],
        })],
        [makeProcedure({
          parameters: [{ name: "value", type: "integer[]" }],
        })]
      )
    ).toEqual([]);
  });

  test("adds names to unnamed input parameters with replacement", function () {
    const functionHandler = new FunctionHandler();
    const procedureHandler = new ProcedureHandler();

    expect(
      functionHandler.generateStatements(
        [makeFunction()],
        [makeFunction({ parameters: [{ type: "integer" }] })]
      )[0]
    ).toStartWith("CREATE OR REPLACE FUNCTION");
    expect(
      procedureHandler.generateStatements(
        [makeProcedure()],
        [makeProcedure({ parameters: [{ type: "integer" }] })]
      )[0]
    ).toStartWith("CREATE OR REPLACE PROCEDURE");
  });

  test("recreates a function when its return type cannot be replaced", function () {
    const handler = new FunctionHandler();
    const statements = handler.generateStatements(
      [makeFunction({ returnType: "text" })],
      [makeFunction()]
    );

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("DROP FUNCTION");
    expect(statements[1]).toStartWith("CREATE FUNCTION");
  });

  test("rejects function and procedure drops with dependent objects", function () {
    const functionHandler = new FunctionHandler();
    const procedureHandler = new ProcedureHandler();

    expect(function dropDependentFunction() {
      return functionHandler.generateStatements(
        [],
        [
          makeFunction({
            dependentObjects: ["rule _RETURN on view compute_view"],
          }),
        ]
      );
    }).toThrow("rule _RETURN on view compute_view");
    expect(function dropDependentProcedure() {
      return procedureHandler.generateStatements(
        [],
        [
          makeProcedure({
            dependentObjects: ["procedure public.wrapper(integer)"],
          }),
        ]
      );
    }).toThrow("procedure public.wrapper(integer)");

    expect(
      functionHandler.generateStatements(
        [],
        [
          makeFunction({
            dependentObjects: ["trigger compute_trigger on table users"],
          }),
        ],
        new Set(["trigger compute_trigger on table users"])
      )
    ).toEqual(['DROP FUNCTION IF EXISTS "public"."compute"(integer);']);
  });

  test("drops only removed procedure overload when names match", function () {
    const handler = new ProcedureHandler();

    const statements = handler.generateStatements(
      [makeProcedure({ parameters: [{ name: "value", type: "integer" }] })],
      [
        makeProcedure({ parameters: [{ name: "value", type: "integer" }] }),
        makeProcedure({ parameters: [{ name: "value", type: "text" }] }),
      ]
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('DROP PROCEDURE IF EXISTS "public"."sync_data"(text);');
    expect(statements[0]).not.toContain('(integer)');
  });

  test("creates only missing procedure overload when one already exists", function () {
    const handler = new ProcedureHandler();

    const statements = handler.generateStatements(
      [
        makeProcedure({ parameters: [{ name: "value", type: "integer" }] }),
        makeProcedure({ parameters: [{ name: "value", type: "text" }] }),
      ],
      [makeProcedure({ parameters: [{ name: "value", type: "integer" }] })]
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('CREATE PROCEDURE "public"."sync_data"("value" text )');
    expect(statements[0]).not.toContain("DROP PROCEDURE");
  });

  test("recreates a procedure when an existing parameter name changes", function () {
    const handler = new ProcedureHandler();
    const statements = handler.generateStatements(
      [makeProcedure({ parameters: [{ name: "desired", type: "integer" }] })],
      [makeProcedure({ parameters: [{ name: "current", type: "integer" }] })]
    );

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("DROP PROCEDURE");
    expect(statements[1]).toStartWith("CREATE PROCEDURE");
  });
});
