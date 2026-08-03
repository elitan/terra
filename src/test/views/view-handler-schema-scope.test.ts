import { describe, expect, test } from "bun:test";
import { ViewHandler } from "../../core/schema/handlers/view-handler";
import type { View } from "../../types/schema";

function makeView(overrides: Partial<View> = {}): View {
  return {
    name: "status_view",
    schema: "public",
    definition: "SELECT 1 AS id",
    materialized: false,
    ...overrides,
  };
}

describe("view handler schema scope", function () {
  test("drops only removed schema view when names match", function () {
    const handler = new ViewHandler();

    const statements = handler.generateStatements(
      [makeView({ schema: "public" })],
      [makeView({ schema: "public" }), makeView({ schema: "tenant_a" })]
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('DROP VIEW IF EXISTS "tenant_a"."status_view"');
    expect(statements[0]).not.toContain('"public"."status_view"');
  });

  test("keeps same-name cross-schema views isolated in no-op plan", function () {
    const handler = new ViewHandler();

    const statements = handler.generateStatements(
      [
        makeView({ schema: "public", definition: "SELECT 1 AS id" }),
        makeView({ schema: "tenant_a", definition: "SELECT 2 AS id" }),
      ],
      [
        makeView({ schema: "tenant_a", definition: "SELECT 2 AS id" }),
        makeView({ schema: "public", definition: "SELECT 1 AS id" }),
      ]
    );

    expect(statements).toEqual([]);
  });

  test("treats local schema-qualified and unqualified references as equivalent", function () {
    const handler = new ViewHandler();

    const statements = handler.generateStatements(
      [makeView({ schema: "public", definition: "SELECT id FROM public.shared_base" })],
      [makeView({ schema: "public", definition: " SELECT id FROM shared_base;" })]
    );

    expect(statements).toEqual([]);
  });

  test("treats single-source table-qualified column rewrites as equivalent", function () {
    const handler = new ViewHandler();

    const statements = handler.generateStatements(
      [
        makeView({ schema: "public", definition: "SELECT id FROM public.shared_base" }),
        makeView({ schema: "tenant_a", definition: "SELECT id FROM tenant_a.shared_base" }),
      ],
      [
        makeView({ schema: "public", definition: "SELECT shared_base.id FROM shared_base" }),
        makeView({
          schema: "tenant_a",
          definition: "SELECT shared_base.id FROM tenant_a.shared_base",
        }),
      ]
    );

    expect(statements).toEqual([]);
  });

  test("uses complete sqlite view statements for create and replacement", function () {
    const handler = new ViewHandler();
    const desired = makeView({
      schema: undefined,
      definition: "SELECT 'a   b' AS value",
      createStatement: "CREATE VIEW status_view(label) AS SELECT 'a   b' AS value",
    });
    const current = makeView({
      schema: undefined,
      definition: "SELECT 'a b' AS value",
      createStatement: "CREATE VIEW status_view(label) AS SELECT 'a b' AS value",
    });

    const statements = handler.generateStatements([desired], [current]);
    expect(statements).toEqual([
      'DROP VIEW IF EXISTS "status_view";',
      "CREATE VIEW status_view(label) AS SELECT 'a   b' AS value;",
    ]);
  });

  test("quotes sqlite view names when dropping complete definitions", function () {
    const handler = new ViewHandler();
    const current = makeView({
      name: 'status"view',
      schema: undefined,
      createStatement: 'CREATE VIEW "status""view" AS SELECT 1 AS id',
    });

    expect(handler.generateStatements([], [current])).toEqual([
      'DROP VIEW IF EXISTS "status""view";',
    ]);
  });
});
