import { describe, expect, test } from "bun:test";
import { ProcedureHandler } from "../../core/schema/handlers/procedure-handler";
import type { Procedure } from "../../types/schema";

function makeProcedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    name: "sync_data",
    schema: "public",
    parameters: [],
    language: "sql",
    body: "SELECT 1",
    ...overrides,
  };
}

describe("procedure handler schema scope", function () {
  test("drops only removed schema procedure when names match", function () {
    const handler = new ProcedureHandler();

    const statements = handler.generateStatements(
      [makeProcedure({ schema: "public" })],
      [makeProcedure({ schema: "public" }), makeProcedure({ schema: "tenant_a" })]
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('DROP PROCEDURE IF EXISTS "tenant_a"."sync_data"()');
    expect(statements[0]).not.toContain('"public"."sync_data"()');
  });

  test("keeps same-name cross-schema procedures isolated in no-op plan", function () {
    const handler = new ProcedureHandler();

    const statements = handler.generateStatements(
      [
        makeProcedure({ schema: "public", body: "SELECT 1" }),
        makeProcedure({ schema: "tenant_a", body: "SELECT 2" }),
      ],
      [
        makeProcedure({ schema: "tenant_a", body: "SELECT 2" }),
        makeProcedure({ schema: "public", body: "SELECT 1" }),
      ]
    );

    expect(statements).toEqual([]);
  });
});
