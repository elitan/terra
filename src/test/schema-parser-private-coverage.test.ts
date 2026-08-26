import { describe, expect, test } from "bun:test";
import { SchemaParser } from "../core/schema/parser";
import { qualifyDeclaredRoutineTypes } from "../core/schema/parser/routine-type-canonicalizer";
import type { Index, View } from "../types/schema";

function makeParseResult(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    tables: [],
    indexes: [],
    enums: [],
    views: [],
    functions: [],
    procedures: [],
    triggers: [],
    sequences: [],
    extensions: [],
    schemas: [],
    comments: [],
    ...overrides,
  };
}

describe("SchemaParser private coverage", () => {
  test("quotes reserved identifiers without rewriting SQL comments", function () {
    const parser = new SchemaParser() as any;
    const sql = `CREATE TABLE user (
  user TEXT
);
-- CREATE TABLE user (user TEXT);
/* outer CREATE TABLE user (
   /* nested user TEXT */
   user TEXT
) */
CREATE TABLE status (
  order TEXT
);
-- trailing user TEXT`;

    expect(parser.autoQuoteReservedKeywords(sql)).toBe(`CREATE TABLE "user" (
  "user" TEXT
);
-- CREATE TABLE user (user TEXT);
/* outer CREATE TABLE user (
   /* nested user TEXT */
   user TEXT
) */
CREATE TABLE "status" (
  "order" TEXT
);
-- trailing user TEXT`);
  });

  test("qualifies unambiguous declared routine types across object kinds", function () {
    const functions = [
      {
        name: "typed_function",
        parameters: [
          { type: "row_type[]" },
          { type: '"StateType"' },
          { type: "domain_type" },
          { type: "range_type" },
          { type: "integer" },
        ],
        returnType: "SETOF composite_type",
      },
    ];
    const procedures = [
      {
        name: "typed_procedure",
        parameters: [{ type: '"StateType"[][]' }],
      },
    ];

    qualifyDeclaredRoutineTypes({
      tables: [{ name: "row_type", schema: "tenant", columns: [] }],
      enums: [{ name: "StateType", schema: "public", values: ["a"] }],
      compositeTypes: [{ name: "composite_type", schema: "public", attributes: [] }],
      sqlObjects: [
        { kind: "domain-type", name: "domain_type", schema: "public" },
        { kind: "range-type", name: "range_type", schema: "tenant" },
        { kind: "policy", name: "ignored", schema: "public" },
      ],
      functions: functions as any,
      procedures: procedures as any,
      filePath: "schema.sql",
    });

    expect(functions[0]?.parameters.map(function getType(parameter) {
      return parameter.type;
    })).toEqual([
      "tenant.row_type[]",
      'public."StateType"',
      "public.domain_type",
      "tenant.range_type",
      "integer",
    ]);
    expect(functions[0]?.returnType).toBe("SETOF public.composite_type");
    expect(procedures[0]?.parameters[0]?.type).toBe('public."StateType"[][]');
  });

  test("rejects ambiguous unqualified declared routine types", function () {
    expect(function qualifyAmbiguousType() {
      qualifyDeclaredRoutineTypes({
        tables: [],
        enums: [
          { name: "state", schema: "tenant_a", values: ["a"] },
          { name: "state", schema: "tenant_b", values: ["b"] },
        ],
        compositeTypes: [],
        sqlObjects: [],
        functions: [{
          name: "read_state",
          parameters: [],
          returnType: "state",
        }] as any,
        procedures: [],
        filePath: "schema.sql",
      });
    }).toThrow(
      "PostgreSQL routine type state is ambiguous across desired schemas (tenant_a.state, tenant_b.state); schema-qualify the routine type"
    );
  });

  test("parseCreateIndexStatements delegates to parsed indexes", async function () {
    const parser = new SchemaParser() as any;
    const indexes: Index[] = [{ name: "idx_users_email", tableName: "users", columns: ["email"], type: "btree" }];
    parser.ensureWasmLoaded = async function () {};
    parser.parseWithPgsql = async function () {
      return makeParseResult({ indexes });
    };

    const parsed = await parser.parseCreateIndexStatements("CREATE INDEX idx_users_email ON users(email)");
    expect(parsed).toEqual(indexes);
  });

  test("parseCreateViewStatements delegates to parsed views", async function () {
    const parser = new SchemaParser() as any;
    const views: View[] = [{ name: "v_users", definition: "SELECT id FROM users" }];
    parser.ensureWasmLoaded = async function () {};
    parser.parseWithPgsql = async function () {
      return makeParseResult({ views });
    };

    const parsed = await parser.parseCreateViewStatements("CREATE VIEW v_users AS SELECT id FROM users");
    expect(parsed).toEqual(views);
  });

  test("normalizes index collations against the referenced column", function () {
    const parser = new SchemaParser() as any;
    const table = {
      name: "documents",
      columns: [
        { name: "title", type: "text", nullable: true, collation: { name: "C" } },
        { name: "summary", type: "text", nullable: true, collation: { name: "POSIX" } },
      ],
    };
    const index: Index = {
      name: "documents_summary_idx",
      tableName: "documents",
      columns: ["summary"],
      collations: [{ name: "POSIX" }],
    };

    parser.normalizeIndexCollations(index, table);

    expect(index.collations).toBeUndefined();
    expect(parser.getExpressionNaturalCollation("'fixed'::text", table)).toEqual({
      name: "default",
    });
    expect(parser.getExpressionNaturalCollation("lower(summary)", table)).toEqual({
      name: "POSIX",
    });
  });

  test("extractErrorContext returns empty when token is not found", function () {
    const parser = new SchemaParser() as any;
    const result = parser.extractErrorContext('syntax error at or near "missing"', "CREATE TABLE users (id INT)");
    expect(result).toEqual({});
  });

  test("extractErrorContext marks only the failing source line", function () {
    const parser = new SchemaParser() as any;
    const result = parser.extractErrorContext(
      'syntax error at or near "broken"',
      "first line\nsecond line\nbroken token\nfourth line\nfifth line"
    );

    expect(result.line).toBe(3);
    expect(result.column).toBe(1);
    expect(result.snippet?.split("\n")).toEqual([
      "     1 | first line",
      "     2 | second line",
      "→    3 | broken token",
      "     4 | fourth line",
      "     5 | fifth line",
    ]);
  });

  test("parseCommentStmt handles column and schema qualified object names", function () {
    const parser = new SchemaParser() as any;

    expect(function parseCommentRemoval() {
      return parser.parseCommentStmt({});
    }).toThrow("COMMENT removal");
    expect(function parseUnknownCommentTarget() {
      return parser.parseCommentStmt({ objtype: "OBJECT_UNKNOWN", comment: "x" });
    }).toThrow("is not supported in desired schemas");

    expect(
      parser.parseCommentStmt({
        objtype: "OBJECT_COLUMN",
        comment: "column comment",
        object: {
          List: {
            items: [{ String: { sval: "users" } }, { String: { sval: "email" } }],
          },
        },
      })
    ).toEqual({
      objectType: "COLUMN",
      objectName: "users",
      columnName: "email",
      comment: "column comment",
    });

    expect(
      parser.parseCommentStmt({
        objtype: "OBJECT_COLUMN",
        comment: "column comment",
        object: {
          List: {
            items: [
              { String: { sval: "public" } },
              { String: { sval: "users" } },
              { String: { sval: "email" } },
            ],
          },
        },
      })
    ).toEqual({
      objectType: "COLUMN",
      objectName: "users",
      schemaName: "public",
      columnName: "email",
      comment: "column comment",
    });

    expect(
      parser.parseCommentStmt({
        objtype: "OBJECT_TABLE",
        comment: "table comment",
        object: {
          List: {
            items: [{ String: { sval: "public" } }, { String: { sval: "users" } }],
          },
        },
      })
    ).toEqual({
      objectType: "TABLE",
      objectName: "users",
      schemaName: "public",
      comment: "table comment",
    });

    expect(function parseInvalidSchemaTarget() {
      return parser.parseCommentStmt({
        objtype: "OBJECT_SCHEMA",
        comment: "schema comment",
        object: {
          List: {
            items: [{ String: { sval: "public" } }, { String: { sval: "ignored" } }],
          },
        },
      });
    }).toThrow("target identity");

    expect(parser.parseCommentStmt({
      objtype: "OBJECT_SCHEMA",
      comment: "schema comment",
      object: { String: { sval: "public" } },
    })).toEqual({
      objectType: "SCHEMA",
      objectName: "public",
      schemaName: undefined,
      comment: "schema comment",
    });

    expect(
      parser.parseCommentStmt({
        objtype: "OBJECT_TYPE",
        comment: "type comment",
        object: {
          TypeName: {
            names: [{ String: { sval: "priority_data" } }],
          },
        },
      })
    ).toEqual({
      objectType: "TYPE",
      objectName: "priority_data",
      schemaName: undefined,
      comment: "type comment",
    });
  });

  test("extractObjectParts keeps only lossless string identities", function () {
    const parser = new SchemaParser() as any;

    expect(
      parser.extractObjectParts({
        List: {
          items: [{ String: { sval: "public" } }, { A_Const: { ival: { ival: 1 } } }],
        },
      })
    ).toEqual(["public"]);

    expect(parser.extractObjectParts([{ String: { sval: "users" } }, { Integer: { ival: 2 } }])).toEqual([
      "users",
    ]);

    expect(parser.extractObjectParts({ String: { sval: "single" } })).toEqual(["single"]);
    expect(
      parser.extractObjectParts({
        TypeName: {
          names: [{ String: { sval: "public" } }, { String: { sval: "priority_data" } }],
        },
      })
    ).toEqual(["public", "priority_data"]);
    expect(parser.extractObjectParts(42)).toEqual([]);
  });
});
