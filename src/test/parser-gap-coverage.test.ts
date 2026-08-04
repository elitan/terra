import { describe, expect, test } from "bun:test";
import { parseCreateFunction } from "../core/schema/parser/function-parser";
import { parseCreateProcedure } from "../core/schema/parser/procedure-parser";
import { parseCreateSequence } from "../core/schema/parser/sequence-parser";
import { parseColumn } from "../core/schema/parser/tables/column-parser";
import { parseCreateView } from "../core/schema/parser/view-parser";

function makeFunctionBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    funcname: [{ String: { sval: "f_gap" } }],
    parameters: [],
    returnType: { names: [{ String: { sval: "int4" } }] },
    options: [
      { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
      { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
    ],
    ...overrides,
  };
}

function makeProcedureBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    funcname: [{ String: { sval: "p_gap" } }],
    parameters: [],
    options: [
      { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
      { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
    ],
    ...overrides,
  };
}

function makeViewStmt(arg: Record<string, unknown>): Record<string, unknown> {
  return {
    view: { relname: "v_gap", schemaname: "public" },
    query: { SelectStmt: { targetList: [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }] } },
    options: [{ DefElem: { defname: "security_barrier", arg } }],
  };
}

describe("Parser gap coverage", function () {
  test("covers function schema catch and fallback branches", function () {
    const node: any = makeFunctionBase({
      parameters: [
        {
          FunctionParameter: {
            name: "a",
            argType: { names: [{}] },
            defexpr: { expr: {} },
          },
        },
      ],
      options: [
        { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
        { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
        { DefElem: { defname: "security", arg: { Integer: { ival: 0 } } } },
      ],
    });

    let calls = 0;
    Object.defineProperty(node, "funcname", {
      get: function () {
        calls += 1;
        if (calls <= 3) {
          return [{ String: { sval: "f_gap" } }];
        }
        throw new Error("schema read fail");
      },
    });

    const parsed = parseCreateFunction(node);
    expect(parsed?.name).toBe("f_gap");
    expect(parsed?.schema).toBeUndefined();
    expect(parsed?.parameters).toEqual([{ name: "a", type: "unknown", default: "" }]);
    expect(parsed?.securityDefiner).toBe(false);
  });

  test("covers procedure parser unknown-type and security integer false", function () {
    const parsed = parseCreateProcedure(
      makeProcedureBase({
        parameters: [
          {
            FunctionParameter: {
              name: "a",
              argType: { names: [{}] },
              defexpr: { A_Const: { ival: { ival: 9 } } },
            },
          },
        ],
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
          { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
          { DefElem: { defname: "security", arg: { Integer: { ival: 0 } } } },
        ],
      })
    );

    expect(parsed?.parameters).toEqual([{ name: "a", type: "unknown", default: "9" }]);
    expect(parsed?.securityDefiner).toBe(false);
  });

  test("covers sequence float and integer cycle branches", function () {
    const parsed = parseCreateSequence({
      sequence: { relname: "seq_gap" },
      options: [
        { DefElem: { defname: "increment", arg: { Float: { fval: 2.5 } } } },
        { DefElem: { defname: "cycle", arg: { Integer: { ival: 0 } } } },
      ],
    });

    expect(parsed?.increment).toBe(2.5);
    expect(parsed?.cycle).toBe(false);
  });

  test("covers column typmod deparse fallback catch and default extraction", function () {
    const parsed = parseColumn({
      colname: "val",
      typeName: {
        names: [{ String: { sval: "numeric" } }],
        typmods: [
          {
            get SelectStmt() {
              throw new Error("bad typmod");
            },
          },
        ],
      },
      constraints: [
        {
          Constraint: {
            contype: "CONSTR_DEFAULT",
            raw_expr: {
              A_Const: {
                ival: { ival: 11 },
              },
            },
          },
        },
      ],
    });

    expect(parsed?.type).toBe("NUMERIC");
    expect(parsed?.default).toBe("11");
  });

  test("covers view security_barrier option value variants", function () {
    const cases: Array<{ arg: Record<string, unknown>; expected: boolean }> = [
      { arg: { Integer: { ival: 1 } }, expected: true },
      { arg: { Integer: { ival: 0 } }, expected: false },
      { arg: { A_Const: { String: { sval: "on" } } }, expected: true },
      { arg: { A_Const: { String: { sval: "true" } } }, expected: true },
      { arg: { A_Const: { String: { sval: "off" } } }, expected: false },
      { arg: { A_Const: { String: { sval: "false" } } }, expected: false },
      { arg: { A_Const: { Integer: { ival: 1 } } }, expected: true },
      { arg: { TypeName: { names: [{ String: { sval: "on" } }] } }, expected: true },
      { arg: { TypeName: { names: [{ String: { sval: "off" } }] } }, expected: false },
    ];

    for (const item of cases) {
      const parsed = parseCreateView(makeViewStmt(item.arg), "");
      expect(parsed?.securityBarrier).toBe(item.expected);
    }

    expect(function parseInvalidBoolean() {
      return parseCreateView(
        makeViewStmt({ String: { sval: "unknown" } }),
        ""
      );
    }).toThrow(
      'PostgreSQL view option "security_barrier" requires a boolean value'
    );
  });
});
