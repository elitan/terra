import { describe, expect, test } from "bun:test";
import { parseCreateFunction } from "../core/schema/parser/function-parser";
import { Logger } from "../utils/logger";

function languageOption(language: string): Record<string, unknown> {
  return { DefElem: { defname: "language", arg: { String: { sval: language } } } };
}

function asOption(...parts: string[]): Record<string, unknown> {
  return {
    DefElem: {
      defname: "as",
      arg: { List: { items: parts.map(function (part) { return { String: { sval: part } }; }) } },
    },
  };
}

function baseNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    funcname: [{ String: { sval: "f_test" } }],
    parameters: [],
    returnType: { names: [{ String: { sval: "int4" } }] },
    options: [languageOption("sql"), asOption("SELECT 1")],
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
          languageOption("sql"),
          asOption("BEGIN END"),
          { DefElem: { defname: "security", arg: { Integer: { ival: 1 } } } },
        ],
      })
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.parameters[0].type).toBe("unknown");
    expect(parsed?.parameters[0].default).toBe("");
    expect(parsed?.body).toBe("BEGIN END");
    expect(parsed?.securityDefiner).toBe(true);
  });

  test("extracts schema from schema-qualified function name", function () {
    const parsed = parseCreateFunction(
      baseNode({
        funcname: [{ String: { sval: "tenant_a" } }, { String: { sval: "f_test" } }],
      })
    );

    expect(parsed?.name).toBe("f_test");
    expect(parsed?.schema).toBe("tenant_a");
  });

  test("keeps schema-qualified and quoted custom types in signature", function () {
    const parsed = parseCreateFunction(
      baseNode({
        funcname: [{ String: { sval: "tenant_a" } }, { String: { sval: "f_custom" } }],
        parameters: [
          {
            FunctionParameter: {
              name: "arg",
              argType: {
                names: [{ String: { sval: "tenant_a" } }, { String: { sval: "StateType" } }],
              },
            },
          },
        ],
        returnType: {
          names: [{ String: { sval: "tenant_a" } }, { String: { sval: "StateType" } }],
        },
      })
    );

    expect(parsed?.parameters[0]?.type).toBe('tenant_a."StateType"');
    expect(parsed?.returnType).toBe('tenant_a."StateType"');
  });

  test("keeps non-pg-catalog schema-qualified builtin aliases as qualified types", function () {
    const parsed = parseCreateFunction(
      baseNode({
        parameters: [
          {
            FunctionParameter: {
              name: "arg",
              argType: {
                names: [{ String: { sval: "tenant_a" } }, { String: { sval: "int4" } }],
              },
            },
          },
        ],
        returnType: {
          names: [{ String: { sval: "tenant_a" } }, { String: { sval: "int4" } }],
        },
      })
    );

    expect(parsed?.parameters[0]?.type).toBe("tenant_a.int4");
    expect(parsed?.returnType).toBe("tenant_a.int4");
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
          languageOption("sql"),
          badBodyOption,
        ],
      })
    );

    expect(parsed).toBeNull();
  });

  test("parses security integer true and parameter default expr value", function () {
    const parsed = parseCreateFunction(
      baseNode({
        parameters: [
          {
            FunctionParameter: {
              name: "n",
              argType: { names: [{ String: { sval: "int4" } }] },
              defexpr: { expr: { value: "7" } },
            },
          },
        ],
        options: [
          languageOption("sql"),
          asOption("SELECT 1"),
          { DefElem: { defname: "security", arg: { Integer: { ival: 1 } } } },
        ],
      })
    );

    expect(parsed?.parameters[0]?.default).toBe("7");
    expect(parsed?.securityDefiner).toBe(true);
  });

  test("returns null when body list has no string items", function () {
    const parsed = parseCreateFunction(
      baseNode({
        options: [
          languageOption("sql"),
          { DefElem: { defname: "as", arg: { List: { items: [{}] } } } },
        ],
      })
    );

    expect(parsed).toBeNull();
  });

  test("hits top-level catch when warning logger throws once", function () {
    const original = Logger.warning;
    let calls = 0;

    (Logger as any).warning = function () {
      calls += 1;
      if (calls === 1) {
        throw new Error("boom");
      }
    };

    try {
      const parsed = parseCreateFunction({});
      expect(parsed).toBeNull();
    } finally {
      (Logger as any).warning = original;
    }
  });
});
