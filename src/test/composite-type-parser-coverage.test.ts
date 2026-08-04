import { describe, expect, test } from "bun:test";
import { parseCreateCompositeType } from "../core/schema/parser/composite-type-parser";

describe("Composite type parser coverage", function () {
  test("returns null when type name is missing", function () {
    expect(parseCreateCompositeType({})).toBeNull();
  });

  test("returns null when no valid attributes exist", function () {
    const stmt = {
      typevar: {
        relname: "contact_info",
      },
      coldeflist: [
        {
          ColumnDef: {
            colname: "email",
          },
        },
      ],
    };

    expect(parseCreateCompositeType(stmt)).toBeNull();
  });

  test("preserves zero attributes and explicit collation metadata", function () {
    expect(
      parseCreateCompositeType({
        typevar: { relname: "empty_payload", schemaname: "app" },
      })
    ).toEqual({
      name: "empty_payload",
      schema: "app",
      attributes: [],
    });

    expect(
      parseCreateCompositeType({
        typevar: { relname: "localized_payload", schemaname: "app" },
        coldeflist: [
          {
            ColumnDef: {
              colname: "Display Name",
              typeName: { names: [{ String: { sval: "text" } }] },
              collClause: {
                collname: [
                  { String: { sval: "pg_catalog" } },
                  { String: { sval: "C" } },
                ],
              },
            },
          },
        ],
      })
    ).toEqual({
      name: "localized_payload",
      schema: "app",
      attributes: [
        {
          name: "Display Name",
          type: "TEXT",
          collation: { name: "C", schema: "pg_catalog" },
        },
      ],
    });
  });

  test("returns null when parsing throws", function () {
    const stmt = {
      typevar: {
        relname: "contact_info",
      },
      coldeflist: [
        {
          get ColumnDef() {
            throw new Error("boom");
          },
        },
      ],
    };

    expect(parseCreateCompositeType(stmt)).toBeNull();
  });
});
