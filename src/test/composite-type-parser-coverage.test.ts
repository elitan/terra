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
