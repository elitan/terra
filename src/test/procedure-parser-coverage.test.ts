import { describe, expect, test } from "bun:test";
import { parseCreateProcedure } from "../core/schema/parser/procedure-parser";
import { Logger } from "../utils/logger";

describe("Procedure parser coverage", () => {
  test("returns null for missing language and missing body", () => {
    expect(
      parseCreateProcedure({
        funcname: [{ String: { sval: "public" } }, { String: { sval: "p_missing_language" } }],
        options: [{ DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "BEGIN END" } }] } } } }],
      })
    ).toBeNull();

    expect(
      parseCreateProcedure({
        funcname: [{ String: { sval: "public" } }, { String: { sval: "p_missing_body" } }],
        options: [{ DefElem: { defname: "language", arg: { String: { sval: "sql" } } } }],
      })
    ).toBeNull();
  });

  test("handles empty names and fallback extraction paths", () => {
    expect(
      parseCreateProcedure({
        funcname: [{}],
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
          { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
        ],
      })
    ).toBeNull();
  });

  test("parses unknown parameter types and default extraction failures", () => {
    const badTypeNode: any = {};
    Object.defineProperty(badTypeNode, "names", {
      get: function () {
        throw new Error("bad names");
      },
    });

    const badDefaultNode = new Proxy(
      {},
      {
        get: function () {
          throw new Error("bad default");
        },
      }
    );

    const parsed = parseCreateProcedure({
      funcname: [{ String: { sval: "public" } }, { String: { sval: "p_fallbacks" } }],
      parameters: [
        { FunctionParameter: { name: "a", argType: {} } },
        { FunctionParameter: { name: "b", argType: badTypeNode, defexpr: badDefaultNode } },
      ],
      options: [
        { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
        { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
        { DefElem: { defname: "security", arg: { Integer: { ival: 1 } } } },
      ],
    });

    expect(parsed?.name).toBe("p_fallbacks");
    expect(parsed?.parameters).toEqual([
      { name: "a", type: "unknown" },
      { name: "b", type: "unknown", default: undefined },
    ]);
    expect(parsed?.securityDefiner).toBe(true);
  });

  test("returns null when language arg is invalid and body list is malformed", () => {
    expect(
      parseCreateProcedure({
        funcname: [{ String: { sval: "p_bad_lang" } }],
        options: [{ DefElem: { defname: "language", arg: {} } }],
      })
    ).toBeNull();

    expect(
      parseCreateProcedure({
        funcname: [{ String: { sval: "p_bad_body" } }],
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
          { DefElem: { defname: "as", arg: { String: { sval: "not-list" } } } },
        ],
      })
    ).toBeNull();
  });

  test("falls back through outer catch when warning logger throws", () => {
    const original = Logger.warning;
    let callCount = 0;

    (Logger as any).warning = function () {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("logger fail");
      }
    };

    try {
      const parsed = parseCreateProcedure({
        funcname: [{ String: { sval: "p_outer_catch" } }],
        options: [{ DefElem: { defname: "language", arg: { String: { sval: "sql" } } } }],
      });
      expect(parsed).toBeNull();
    } finally {
      (Logger as any).warning = original;
    }
  });
});
