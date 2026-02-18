import { describe, expect, test } from "bun:test";
import { parseCreateSequence } from "../core/schema/parser/sequence-parser";
import { parseCreateTrigger } from "../core/schema/parser/trigger-parser";
import {
  extractColumns,
  parseColumn,
} from "../core/schema/parser/tables/column-parser";

describe("Parser edge coverage", () => {
  describe("trigger parser edge paths", () => {
    test("returns null when table name is missing", () => {
      const trigger = parseCreateTrigger({
        trigname: "trg_missing_table",
        timing: 2,
        events: 4,
        funcname: [{ String: { sval: "fn" } }],
      });

      expect(trigger).toBeNull();
    });

    test("returns null when events are empty", () => {
      const trigger = parseCreateTrigger({
        trigname: "trg_missing_events",
        relation: { relname: "users" },
        timing: 2,
        events: 0,
        funcname: [{ String: { sval: "fn" } }],
      });

      expect(trigger).toBeNull();
    });

    test("returns null when timing extraction throws", () => {
      const trigger: any = {
        trigname: "trg_bad_timing",
        relation: { relname: "users" },
        events: 4,
        funcname: [{ String: { sval: "fn" } }],
      };

      Object.defineProperty(trigger, "timing", {
        get() {
          throw new Error("bad timing");
        },
      });

      expect(parseCreateTrigger(trigger)).toBeNull();
    });

    test("maps unknown timing bitmask to AFTER", () => {
      const trigger = parseCreateTrigger({
        trigname: "trg_after",
        relation: { relname: "users" },
        timing: 1,
        events: 4,
        funcname: [{ String: { sval: "fn" } }],
      });

      expect(trigger?.timing).toBe("AFTER");
    });

    test("returns null when event extraction throws", () => {
      const trigger: any = {
        trigname: "trg_bad_events",
        relation: { relname: "users" },
        timing: 2,
        funcname: [{ String: { sval: "fn" } }],
      };

      Object.defineProperty(trigger, "events", {
        get() {
          throw new Error("bad events");
        },
      });

      expect(parseCreateTrigger(trigger)).toBeNull();
    });

    test("returns null when function name extraction throws", () => {
      const trigger: any = {
        trigname: "trg_bad_func",
        relation: { relname: "users" },
        timing: 2,
        events: 4,
      };

      Object.defineProperty(trigger, "funcname", {
        get() {
          throw new Error("bad func");
        },
      });

      expect(parseCreateTrigger(trigger)).toBeNull();
    });

    test("continues when row extraction throws", () => {
      const trigger: any = {
        trigname: "trg_row_throw",
        relation: { relname: "users" },
        timing: 2,
        events: 4,
        funcname: [{ String: { sval: "fn" } }],
      };

      Object.defineProperty(trigger, "row", {
        get() {
          throw new Error("bad row");
        },
      });

      const parsed = parseCreateTrigger(trigger);
      expect(parsed?.name).toBe("trg_row_throw");
      expect(parsed?.forEach).toBeUndefined();
    });

    test("continues when args extraction throws", () => {
      const trigger: any = {
        trigname: "trg_args_throw",
        relation: { relname: "users" },
        timing: 2,
        events: 4,
        funcname: [{ String: { sval: "fn" } }],
      };

      Object.defineProperty(trigger, "args", {
        get() {
          throw new Error("bad args");
        },
      });

      const parsed = parseCreateTrigger(trigger);
      expect(parsed?.name).toBe("trg_args_throw");
      expect(parsed?.functionArgs).toBeUndefined();
    });
  });

  describe("sequence parser edge paths", () => {
    test("maps all integer aliases for AS type", () => {
      const typeCases = [
        { input: "int4", expected: "INTEGER" },
        { input: "integer", expected: "INTEGER" },
        { input: "bigint", expected: "BIGINT" },
      ] as const;

      for (const item of typeCases) {
        const parsed = parseCreateSequence({
          sequence: { relname: `seq_${item.input}` },
          options: [
            {
              DefElem: {
                defname: "as",
                arg: { TypeName: { names: [{ String: { sval: item.input } }] } },
              },
            },
          ],
        });
        expect(parsed?.dataType).toBe(item.expected);
      }
    });

    test("handles unknown AS type and cycle integer zero", () => {
      const parsed = parseCreateSequence({
        sequence: { relname: "seq_unknown" },
        options: [
          {
            DefElem: {
              defname: "as",
              arg: { TypeName: { names: [{ String: { sval: "uuid" } }] } },
            },
          },
          { DefElem: { defname: "cycle", arg: { Integer: { ival: 0 } } } },
          {
            DefElem: {
              defname: "owned_by",
              arg: { List: { items: [{ String: { sval: "users" } }] } },
            },
          },
        ],
      });

      expect(parsed?.dataType).toBeUndefined();
      expect(parsed?.cycle).toBe(false);
      expect(parsed?.ownedBy).toBeUndefined();
    });

    test("continues when options getter throws", () => {
      const node: any = { sequence: { relname: "seq_safe" } };
      Object.defineProperty(node, "options", {
        get() {
          throw new Error("boom");
        },
      });

      const parsed = parseCreateSequence(node);
      expect(parsed?.name).toBe("seq_safe");
      expect(parsed?.dataType).toBeUndefined();
    });

    test("continues when option extraction throws", () => {
      const badOption: any = {};
      Object.defineProperty(badOption, "DefElem", {
        get() {
          throw new Error("bad option");
        },
      });

      const parsed = parseCreateSequence({
        sequence: { relname: "seq_bad" },
        options: [badOption],
      });

      expect(parsed?.name).toBe("seq_bad");
      expect(parsed?.increment).toBeUndefined();
      expect(parsed?.cycle).toBeUndefined();
      expect(parsed?.ownedBy).toBeUndefined();
    });
  });

  describe("column parser edge paths", () => {
    test("extracts columns and skips non-column elements", () => {
      const columns = extractColumns([
        {
          ColumnDef: {
            colname: "id",
            typeName: { names: [{ String: { sval: "serial" } }] },
            constraints: [],
          },
        },
        { Constraint: { contype: "CONSTR_PRIMARY" } },
      ] as any[]);

      expect(columns).toHaveLength(1);
      expect(columns[0]).toEqual({
        name: "id",
        type: "SERIAL",
        nullable: false,
        default: undefined,
        generated: undefined,
      });
    });

    test("returns empty list when extractColumns iteration throws", () => {
      const badIterable = {
        [Symbol.iterator]() {
          throw new Error("bad iterator");
        },
      } as any;

      expect(extractColumns(badIterable)).toEqual([]);
    });

    test("returns null when parseColumn input throws", () => {
      const columnDef: any = {};
      Object.defineProperty(columnDef, "colname", {
        get() {
          throw new Error("bad colname");
        },
      });

      expect(parseColumn(columnDef)).toBeNull();
    });

    test("parses complex type modifiers and array bounds", () => {
      const parsed = parseColumn({
        colname: "ival",
        typeName: {
          names: [{ String: { sval: "interval" } }],
          typmods: [
            { A_Const: { ival: { ival: 32767 } } },
            { A_Const: { sval: { sval: "hour" } } },
          ],
          arrayBounds: [{ Integer: { ival: 3 } }, { Integer: { ival: -1 } }, {}],
        },
        constraints: [{ Constraint: { contype: "CONSTR_NOTNULL" } }],
      });

      expect(parsed?.type).toBe("INTERVAL(hour)[3][][]");
      expect(parsed?.nullable).toBe(false);
    });

    test("parses schema qualified type and columnref typmod", () => {
      const parsed = parseColumn({
        colname: "metric",
        typeName: {
          names: [{ String: { sval: "custom" } }, { String: { sval: "numeric" } }],
          typmods: [
            {
              ColumnRef: {
                fields: [{ String: { sval: "schema" } }, { String: { sval: "precision" } }],
              },
            },
          ],
        },
        constraints: [],
      });

      expect(parsed?.type).toBe("custom.numeric(schema.precision)");
    });

    test("handles data type extraction failures", () => {
      const parsed = parseColumn({
        colname: "bad_type",
        typeName: {
          get names() {
            throw new Error("bad names");
          },
        },
        constraints: [],
      });

      expect(parsed?.type).toBe("UNKNOWN");
    });

    test("handles default and generated parsing failures", () => {
      const parsed = parseColumn({
        colname: "safe",
        typeName: { names: [{ String: { sval: "text" } }] },
        constraints: [
          {
            Constraint: {
              contype: "CONSTR_DEFAULT",
              raw_expr: {
                get SelectStmt() {
                  throw new Error("bad default");
                },
              },
            },
          },
          {
            Constraint: {
              contype: "CONSTR_GENERATED",
              generated_when: "a",
              raw_expr: {
                get SelectStmt() {
                  throw new Error("bad generated");
                },
              },
            },
          },
        ],
      });

      expect(parsed?.default).toBeUndefined();
      expect(parsed?.generated).toBeUndefined();
    });

    test("extracts default and generated column values when valid", () => {
      const parsed = parseColumn({
        colname: "calc",
        typeName: { names: [{ String: { sval: "int4" } }] },
        constraints: [
          {
            Constraint: {
              contype: "CONSTR_DEFAULT",
              raw_expr: {
                A_Const: {
                  ival: { ival: 7 },
                },
              },
            },
          },
          {
            Constraint: {
              contype: "CONSTR_GENERATED",
              generated_when: 97,
              raw_expr: {
                ColumnRef: {
                  fields: [{ String: { sval: "a" } }],
                },
              },
            },
          },
        ],
      });

      expect(parsed?.default).toBe("7");
      expect(parsed?.generated?.always).toBe(true);
      expect(parsed?.generated?.expression).toBe("a");
      expect(parsed?.generated?.stored).toBe(true);
    });
  });
});
