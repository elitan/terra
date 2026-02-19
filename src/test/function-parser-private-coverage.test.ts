import { describe, expect, test } from "bun:test";
import { parseCreateFunction } from "../core/schema/parser/function-parser";

function baseNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    funcname: [{ String: { sval: "f_test" } }],
    parameters: [],
    returnType: { names: [{ String: { sval: "int4" } }] },
    options: [
      { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
      { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
    ],
    ...overrides,
  };
}

describe("Function parser private coverage", () => {
  test("parses options and defensive parameter paths", () => {
    const parsed = parseCreateFunction(
      baseNode({
        parameters: [
          {
            FunctionParameter: {
              name: "arg1",
              argType: { names: { not: "array" } },
              mode: "FUNC_PARAM_DEFAULT",
              defexpr: { expr: {} },
            },
          },
        ],
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
          {
            DefElem: {
              defname: "as",
              arg: { List: { items: [{ String: { sval: "BEGIN" } }, { String: { sval: "END" } }] } },
            },
          },
          { DefElem: { defname: "security", arg: { Integer: { ival: 1 } } } },
        ],
      })
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.parameters[0].type).toBe("unknown");
    expect(parsed?.parameters[0].default).toBe("");
    expect(parsed?.body).toBe("BEGIN\nEND");
    expect(parsed?.securityDefiner).toBe(true);
  });

  test("returns null when top-level parse throws", () => {
    const node = {} as Record<string, unknown>;
    Object.defineProperty(node, "funcname", {
      get: function () {
        throw new Error("boom");
      },
    });

    expect(parseCreateFunction(node)).toBeNull();
  });

  test("returns null when language extraction throws", () => {
    const throwingOption = {} as Record<string, unknown>;
    Object.defineProperty(throwingOption, "DefElem", {
      get: function () {
        throw new Error("bad language option");
      },
    });

    const parsed = parseCreateFunction(
      baseNode({
        options: [throwingOption],
      })
    );

    expect(parsed).toBeNull();
  });

  test("returns null when body extraction throws", () => {
    const badBodyOption = {
      DefElem: {
        defname: "as",
      },
    } as Record<string, unknown>;

    Object.defineProperty((badBodyOption.DefElem as Record<string, unknown>), "arg", {
      get: function () {
        throw new Error("bad body option");
      },
    });

    const parsed = parseCreateFunction(
      baseNode({
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
          badBodyOption,
        ],
      })
    );

    expect(parsed).toBeNull();
  });
});
