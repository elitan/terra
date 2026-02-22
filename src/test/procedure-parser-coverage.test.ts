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

  test("extracts default value from deparsed select and integer security true", function () {
    const parsed = parseCreateProcedure({
      funcname: [{ String: { sval: "p_select_default" } }],
      parameters: [
        {
          FunctionParameter: {
            name: "a",
            argType: { names: [{ String: { sval: "int4" } }] },
            defexpr: { A_Const: { ival: { ival: 5 } } },
          },
        },
      ],
      options: [
        { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
        { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "BEGIN END" } }] } } } },
        { DefElem: { defname: "security", arg: { Integer: { ival: 1 } } } },
      ],
    });

    expect(parsed?.parameters).toEqual([{ name: "a", type: "integer", default: "5" }]);
    expect(parsed?.securityDefiner).toBe(true);
  });

  test("keeps schema-qualified and quoted custom parameter types", function () {
    const parsed = parseCreateProcedure({
      funcname: [{ String: { sval: "tenant_a" } }, { String: { sval: "p_custom" } }],
      parameters: [
        {
          FunctionParameter: {
            name: "a",
            argType: {
              names: [{ String: { sval: "tenant_a" } }, { String: { sval: "StateType" } }],
            },
          },
        },
      ],
      options: [
        { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
        { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
      ],
    });

    expect(parsed?.parameters).toEqual([{ name: "a", type: 'tenant_a."StateType"' }]);
  });

  test("keeps non-pg-catalog schema-qualified builtin aliases as qualified types", function () {
    const parsed = parseCreateProcedure({
      funcname: [{ String: { sval: "tenant_a" } }, { String: { sval: "p_builtin_alias" } }],
      parameters: [
        {
          FunctionParameter: {
            name: "a",
            argType: {
              names: [{ String: { sval: "tenant_a" } }, { String: { sval: "int4" } }],
            },
          },
        },
      ],
      options: [
        { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
        { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
      ],
    });

    expect(parsed?.parameters).toEqual([{ name: "a", type: "tenant_a.int4" }]);
  });

  test("handles throw while scanning procedure body options", function () {
    const badOption: any = {};
    Object.defineProperty(badOption, "DefElem", {
      get: function () {
        throw new Error("bad option");
      },
    });

    const parsed = parseCreateProcedure({
      funcname: [{ String: { sval: "p_throw_body" } }],
      options: [
        { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
        badOption,
      ],
    });

    expect(parsed).toBeNull();
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
