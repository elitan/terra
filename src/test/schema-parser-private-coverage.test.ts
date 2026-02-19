import { describe, expect, test } from "bun:test";
import { SchemaParser } from "../core/schema/parser";
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

  test("extractErrorContext returns empty when token is not found", function () {
    const parser = new SchemaParser() as any;
    const result = parser.extractErrorContext('syntax error at or near "missing"', "CREATE TABLE users (id INT)");
    expect(result).toEqual({});
  });

  test("parseCommentStmt handles column and schema qualified object names", function () {
    const parser = new SchemaParser() as any;

    expect(parser.parseCommentStmt({})).toBeNull();
    expect(parser.parseCommentStmt({ objtype: "OBJECT_UNKNOWN", comment: "x" })).toBeNull();

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

    expect(
      parser.parseCommentStmt({
        objtype: "OBJECT_SCHEMA",
        comment: "schema comment",
        object: {
          List: {
            items: [{ String: { sval: "public" } }, { String: { sval: "ignored" } }],
          },
        },
      })
    ).toEqual({
      objectType: "SCHEMA",
      objectName: "ignored",
      schemaName: undefined,
      comment: "schema comment",
    });
  });

  test("extractObjectParts handles list arrays and fallback values", function () {
    const parser = new SchemaParser() as any;

    expect(
      parser.extractObjectParts({
        List: {
          items: [{ String: { sval: "public" } }, { A_Const: { ival: { ival: 1 } } }],
        },
      })
    ).toEqual(["public", "[object Object]"]);

    expect(parser.extractObjectParts([{ String: { sval: "users" } }, { Integer: { ival: 2 } }])).toEqual([
      "users",
      "[object Object]",
    ]);

    expect(parser.extractObjectParts({ String: { sval: "single" } })).toEqual(["single"]);
    expect(parser.extractObjectParts(42)).toEqual(["42"]);
  });
});
