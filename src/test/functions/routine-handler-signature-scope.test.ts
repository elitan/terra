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
    expect(statements[0]).toContain('DROP FUNCTION IF EXISTS "public"."compute"(text) CASCADE;');
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
});
