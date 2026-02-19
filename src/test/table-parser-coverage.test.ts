import { describe, expect, test } from "bun:test";
import { parseCreateTable } from "../core/schema/parser/tables/table-parser";

describe("Table parser coverage", () => {
  test("returns null when relation or table name is missing", function () {
    expect(parseCreateTable({})).toBeNull();
    expect(parseCreateTable({ relation: {} })).toBeNull();
  });

  test("returns parsed table shape", function () {
    const parsed = parseCreateTable({
      relation: { relname: "users", schemaname: "public" },
      tableElts: [
        {
          ColumnDef: {
            colname: "id",
            typeName: { names: [{ String: { sval: "int4" } }] },
            constraints: [{ Constraint: { contype: "CONSTR_NOTNULL" } }],
          },
        },
      ],
    });

    expect(parsed).toEqual({
      name: "users",
      schema: "public",
      columns: [{ name: "id", type: "INT4", nullable: false, default: undefined, generated: undefined }],
      primaryKey: undefined,
      foreignKeys: undefined,
      checkConstraints: undefined,
      uniqueConstraints: undefined,
    });
  });

  test("returns null when parsing throws", function () {
    const stmt: any = {};
    Object.defineProperty(stmt, "relation", {
      get: function () {
        throw new Error("boom");
      },
    });

    expect(parseCreateTable(stmt)).toBeNull();
  });
});
