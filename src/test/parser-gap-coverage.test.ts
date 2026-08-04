import { describe, expect, test } from "bun:test";
import { parseCreateFunction } from "../core/schema/parser/function-parser";
import { parseCreateIndex } from "../core/schema/parser/index-parser";
import { parseCreateProcedure } from "../core/schema/parser/procedure-parser";
import {
  extractRoutineConfiguration,
  validateRoutineDefinition,
} from "../core/schema/parser/routine-option-parser";
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
  test("covers routine configuration scalar AST variants", function () {
    const configuration = extractRoutineConfiguration(
      {
        options: [
          {
            DefElem: {
              defname: "set",
              arg: {
                VariableSetStmt: {
                  kind: "VAR_SET_VALUE",
                  name: "integer_values",
                  args: [
                    { A_Const: { ival: { ival: -1 } } },
                    { A_Const: { Integer: { ival: 2 } } },
                  ],
                },
              },
            },
          },
          {
            DefElem: {
              defname: "set",
              arg: {
                VariableSetStmt: {
                  kind: "VAR_SET_VALUE",
                  name: "float_values",
                  args: [
                    { A_Const: { fval: { fval: "1.25" } } },
                    { A_Const: { Float: { fval: 2.5 } } },
                  ],
                },
              },
            },
          },
          {
            DefElem: {
              defname: "set",
              arg: {
                VariableSetStmt: {
                  kind: "VAR_SET_VALUE",
                  name: "boolean_values",
                  args: [
                    { A_Const: { boolval: { boolval: true } } },
                    { A_Const: { Boolean: { boolval: false } } },
                  ],
                },
              },
            },
          },
          {
            DefElem: {
              defname: "set",
              arg: {
                VariableSetStmt: {
                  kind: "VAR_SET_VALUE",
                  name: "direct_string",
                  args: [{ String: { sval: "value" } }],
                },
              },
            },
          },
        ],
      },
      "function",
      ""
    );

    expect(configuration).toEqual({
      integer_values: "-1, 2",
      float_values: "1.25, 2.5",
      boolean_values: "true, false",
      direct_string: "value",
    });
  });

  test("covers defensive routine option validation errors", function () {
    expect(
      extractRoutineConfiguration({ options: "invalid" }, "function", "")
    ).toBeUndefined();
    expect(
      extractRoutineConfiguration(
        {
          get options() {
            throw new Error("bad options");
          },
        },
        "procedure",
        ""
      )
    ).toBeUndefined();
    expect(function missingSettingName() {
      return extractRoutineConfiguration(
        {
          options: [
            {
              DefElem: {
                defname: "set",
                arg: { VariableSetStmt: { kind: "VAR_SET_VALUE", args: [] } },
              },
            },
          ],
        },
        "function",
        ""
      );
    }).toThrow("missing a configuration parameter name");
    expect(function unsupportedSettingKind() {
      return extractRoutineConfiguration(
        {
          options: [
            {
              DefElem: {
                defname: "set",
                arg: {
                  VariableSetStmt: { kind: "VAR_RESET", name: "work_mem" },
                },
              },
            },
          ],
        },
        "function",
        ""
      );
    }).toThrow("uses an unsupported value form");
    expect(function unrepresentableSettingValue() {
      return extractRoutineConfiguration(
        {
          options: [
            {
              DefElem: {
                defname: "set",
                arg: {
                  VariableSetStmt: {
                    kind: "VAR_SET_VALUE",
                    name: "work_mem",
                    args: [{}],
                  },
                },
              },
            },
          ],
        },
        "procedure",
        ""
      );
    }).toThrow("cannot be represented safely");

    expect(function validateMissingOptions() {
      validateRoutineDefinition({}, "function", new Set(["as"]), "");
      validateRoutineDefinition(
        { options: [{}] },
        "procedure",
        new Set(["as"]),
        ""
      );
    }).not.toThrow();
  });

  test("covers the integer leakproof parser form", function () {
    const parsed = parseCreateFunction(
      makeFunctionBase({
        options: [
          {
            DefElem: {
              defname: "language",
              arg: { String: { sval: "sql" } },
            },
          },
          {
            DefElem: {
              defname: "as",
              arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } },
            },
          },
          {
            DefElem: {
              defname: "leakproof",
              arg: { Integer: { ival: 1 } },
            },
          },
        ],
      })
    );

    expect(parsed?.leakproof).toBe(true);
  });

  test("preserves set-returning and bare strict function options", function () {
    const parsed = parseCreateFunction(
      makeFunctionBase({
        returnType: {
          names: [{ String: { sval: "int4" } }],
          setof: true,
        },
        options: [
          {
            DefElem: {
              defname: "language",
              arg: { String: { sval: "sql" } },
            },
          },
          {
            DefElem: {
              defname: "as",
              arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } },
            },
          },
          { DefElem: { defname: "strict" } },
        ],
      })
    );

    expect(parsed?.returnType).toBe("SETOF integer");
    expect(parsed?.strict).toBe(true);
  });

  test("covers expression keys after ordinary index keys", function () {
    const parsed = parseCreateIndex({
      idxname: "idx_gap_mixed",
      relation: { relname: "users" },
      indexParams: [
        { IndexElem: { name: "tenant_id" } },
        {
          IndexElem: {
            expr: {
              FuncCall: {
                funcname: [{ String: { sval: "lower" } }],
                args: [
                  {
                    ColumnRef: {
                      fields: [{ String: { sval: "email" } }],
                    },
                  },
                ],
              },
            },
            opclass: [{ String: { sval: "text_pattern_ops" } }],
            ordering: "SORTBY_DESC",
            nulls_ordering: "SORTBY_NULLS_LAST",
          },
        },
      ],
    });

    expect(parsed?.columns).toEqual(["tenant_id"]);
    expect(parsed?.expression?.toLowerCase()).toContain("lower");
    expect(parsed?.expressionOpclass).toBe("text_pattern_ops");
    expect(parsed?.sortOrders).toEqual(["ASC", "DESC"]);
    expect(parsed?.nullsOrders).toEqual(["LAST", "LAST"]);
  });

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
