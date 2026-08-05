import { describe, expect, test } from "bun:test";
import { ViewHandler } from "../../core/schema/handlers/view-handler";
import type { View } from "../../types/schema";

function makeView(overrides: Partial<View> = {}): View {
  return {
    name: "matrix_view",
    schema: "public",
    definition: "SELECT 1 AS id",
    materialized: false,
    ...overrides,
  };
}

describe("view definition normalization matrix", function () {
  test("keeps equivalent references as no-op across local schema forms", function () {
    const handler = new ViewHandler();
    const matrix = [
      {
        schema: "public",
        desired: "SELECT id FROM public.base_tbl",
        current: "SELECT id FROM base_tbl",
      },
      {
        schema: "public",
        desired: 'SELECT id FROM "public".base_tbl',
        current: "SELECT id FROM base_tbl",
      },
      {
        schema: "public",
        desired: 'SELECT id FROM "public"."base_tbl"',
        current: "SELECT id FROM base_tbl;",
      },
      {
        schema: "tenant_a",
        desired: "SELECT id FROM tenant_a.base_tbl",
        current: "SELECT id FROM base_tbl",
      },
      {
        schema: "tenant_a",
        desired: 'SELECT id FROM "tenant_a"."base_tbl"',
        current: "SELECT id FROM base_tbl;",
      },
      {
        schema: "public",
        desired: "SELECT id FROM public.base_tbl AS b",
        current: "SELECT id FROM base_tbl AS b",
      },
      {
        schema: "public",
        desired: 'SELECT id FROM "base_tbl"',
        current: "SELECT id FROM base_tbl",
      },
      {
        schema: "public",
        desired: 'SELECT id FROM "tenant_a"."base_tbl"',
        current: "SELECT id FROM tenant_a.base_tbl",
      },
      {
        schema: "public",
        desired:
          "SELECT public.base_tbl.id FROM public.base_tbl",
        current: "SELECT id FROM base_tbl",
      },
      {
        schema: "tenant_a",
        desired:
          "SELECT tenant_a.normalize_value(id) FROM tenant_a.base_tbl",
        current: "SELECT normalize_value(id) FROM base_tbl",
      },
      {
        schema: "tenant_a",
        desired:
          "SELECT id::tenant_a.custom_value FROM tenant_a.base_tbl",
        current: "SELECT id::custom_value FROM base_tbl",
      },
    ];

    for (const item of matrix) {
      const statements = handler.generateStatements(
        [makeView({ schema: item.schema, definition: item.desired })],
        [makeView({ schema: item.schema, definition: item.current })]
      );
      expect(statements).toEqual([]);
    }
  });

  test("keeps other-schema references distinct from local unqualified references", function () {
    const handler = new ViewHandler();

    const statements = handler.generateStatements(
      [makeView({ schema: "public", definition: "SELECT id FROM tenant_a.base_tbl" })],
      [makeView({ schema: "public", definition: "SELECT id FROM base_tbl" })]
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("CREATE OR REPLACE VIEW");
  });

  test("keeps mixed-case quoted identifiers distinct", function () {
    const handler = new ViewHandler();

    const statements = handler.generateStatements(
      [makeView({ schema: "public", definition: 'SELECT "Id" FROM "BaseTbl"' })],
      [makeView({ schema: "public", definition: "SELECT id FROM basetbl" })]
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("CREATE OR REPLACE VIEW");
  });

  test("keeps multi-source references distinct", function () {
    const handler = new ViewHandler();

    const statements = handler.generateStatements(
      [
        makeView({
          schema: "public",
          definition:
            "SELECT users.id FROM users JOIN posts ON posts.user_id = users.id",
        }),
      ],
      [
        makeView({
          schema: "public",
          definition: "SELECT id FROM users JOIN posts ON posts.user_id = users.id",
        }),
      ]
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("CREATE OR REPLACE VIEW");
  });

  test("keeps PostgreSQL literal content distinct", function () {
    const handler = new ViewHandler();
    const cases = [
      {
        current: "SELECT 'alpha beta'::text AS value",
        desired: "SELECT 'alpha  beta'::text AS value",
      },
      {
        current:
          "SELECT 'public.secret'::text AS value FROM public.base_tbl",
        desired: "SELECT 'secret'::text AS value FROM public.base_tbl",
      },
      {
        current:
          "SELECT 'source.label'::text AS value " +
          "FROM public.base_tbl AS source",
        desired:
          "SELECT 'label'::text AS value FROM public.base_tbl AS source",
      },
      {
        current: "SELECT $view$alpha  beta$view$::text AS value",
        desired: "SELECT $view$alpha beta$view$::text AS value",
      },
    ];

    for (const item of cases) {
      const statements = handler.generateStatements(
        [makeView({ definition: item.desired })],
        [makeView({ definition: item.current })]
      );
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("CREATE OR REPLACE VIEW");
    }
  });

  test("recreates a materialized view when changing it to an ordinary view", function () {
    const handler = new ViewHandler();

    const statements = handler.generateStatements(
      [makeView({ materialized: false })],
      [makeView({ materialized: true })]
    );

    expect(statements).toEqual([
      'DROP MATERIALIZED VIEW IF EXISTS "public"."matrix_view";\n' +
        'CREATE VIEW "public"."matrix_view" AS SELECT 1 AS id;',
    ]);
  });
});
