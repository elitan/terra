import { describe, expect, test } from "bun:test";
import { parseCreateSequence } from "../core/schema/parser/sequence-parser";
import { parseCreateTrigger } from "../core/schema/parser/trigger-parser";
import { parseCreateFunction } from "../core/schema/parser/function-parser";
import {
  parseCreateMaterializedView,
  parseCreateView,
} from "../core/schema/parser/view-parser";
import { parseCreateIndex } from "../core/schema/parser/index-parser";
import {
  extractColumns,
  parseColumn,
} from "../core/schema/parser/tables/column-parser";
import { SchemaParser } from "../core/schema/parser";

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

    test("continues when schema extraction throws", () => {
      const trigger = parseCreateTrigger({
        trigname: "trg_schema_throw",
        relation: {
          relname: "users",
          get schemaname() {
            throw new Error("bad schema");
          },
        },
        timing: 2,
        events: 4,
        funcname: [{ String: { sval: "fn" } }],
      });

      expect(trigger?.name).toBe("trg_schema_throw");
      expect(trigger?.schema).toBeUndefined();
    });

    test("continues when when clause extraction throws", () => {
      const trigger: any = {
        trigname: "trg_when_throw",
        relation: { relname: "users" },
        timing: 2,
        events: 4,
        funcname: [{ String: { sval: "fn" } }],
      };

      Object.defineProperty(trigger, "whenClause", {
        get() {
          throw new Error("bad when");
        },
      });

      const parsed = parseCreateTrigger(trigger);
      expect(parsed?.name).toBe("trg_when_throw");
      expect(parsed?.when).toBeUndefined();
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

    test("parses float numeric option and integer cycle one", function () {
      const parsed = parseCreateSequence({
        sequence: { relname: "seq_float_cycle" },
        options: [
          { DefElem: { defname: "increment", arg: { Float: { fval: 1.5 } } } },
          { DefElem: { defname: "cycle", arg: { Integer: { ival: 1 } } } },
        ],
      });

      expect(parsed?.increment).toBe(1.5);
      expect(parsed?.cycle).toBe(true);
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

    test("distinguishes unconstrained and primary-key nullability", function () {
      const unconstrained = parseColumn({
        colname: "optional_value",
        typeName: { names: [{ String: { sval: "integer" } }] },
        constraints: [],
      });
      const primaryKey = parseColumn({
        colname: "id",
        typeName: { names: [{ String: { sval: "integer" } }] },
        constraints: [{ Constraint: { contype: "CONSTR_PRIMARY" } }],
      });

      expect(unconstrained?.nullable).toBe(true);
      expect(primaryKey?.nullable).toBe(false);
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

  describe("function parser edge paths", () => {
    test("returns null when body is missing", () => {
      const fn = parseCreateFunction({
        funcname: [{ String: { sval: "f" } }],
        returnType: { names: [{ String: { sval: "int4" } }] },
        options: [{ DefElem: { defname: "language", arg: { String: { sval: "sql" } } } }],
      });

      expect(fn).toBeNull();
    });

    test("handles thrown return type extraction", () => {
      const node: any = {
        funcname: [{ String: { sval: "f" } }],
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
          { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
        ],
      };

      Object.defineProperty(node, "returnType", {
        get() {
          throw new Error("bad return type");
        },
      });

      expect(parseCreateFunction(node)).toBeNull();
    });

    test("handles parameter extraction and default extraction failures", () => {
      const badParamNode: any = {
        funcname: [{ String: { sval: "f" } }],
        returnType: { names: [{ String: { sval: "int4" } }] },
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
          { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
        ],
      };
      Object.defineProperty(badParamNode, "parameters", {
        get() {
          throw new Error("bad parameters");
        },
      });
      expect(parseCreateFunction(badParamNode)?.parameters).toEqual([]);

      const badDefaultNode = parseCreateFunction({
        funcname: [{ String: { sval: "f2" } }],
        parameters: [
          {
            FunctionParameter: {
              name: "a",
              mode: "FUNC_PARAM_DEFAULT",
              argType: {
                get names() {
                  throw new Error("bad names");
                },
              },
              defexpr: {
                get expr() {
                  throw new Error("bad expr");
                },
              },
            },
          },
        ],
        returnType: { names: [{ String: { sval: "int4" } }] },
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
          { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
        ],
      });

      expect(badDefaultNode?.parameters).toEqual([{ name: "a", type: "unknown", default: "" }]);
    });

    test("handles option extraction failures after language and body", () => {
      let calls = 0;
      const node: any = {
        funcname: [{ String: { sval: "f3" } }],
        returnType: { names: [{ String: { sval: "int4" } }] },
      };
      Object.defineProperty(node, "options", {
        get() {
          calls += 1;
          if (calls <= 6) {
            return [
              { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
              { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
            ];
          }
          throw new Error("bad options");
        },
      });

      const fn = parseCreateFunction(node);
      expect(fn?.name).toBe("f3");
      expect(fn?.volatility).toBeUndefined();
      expect(fn?.parallel).toBeUndefined();
      expect(fn?.securityDefiner).toBeUndefined();
      expect(fn?.strict).toBeUndefined();
      expect(fn?.cost).toBeUndefined();
      expect(fn?.rows).toBeUndefined();
    });

    test("handles unsupported option values", () => {
      const fn = parseCreateFunction({
        funcname: [{ String: { sval: "f4" } }],
        returnType: { names: [{ String: { sval: "int4" } }] },
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
          { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
          { DefElem: { defname: "volatility", arg: { String: { sval: "random" } } } },
          { DefElem: { defname: "parallel", arg: { String: { sval: "odd" } } } },
          { DefElem: { defname: "security", arg: { Integer: { ival: 0 } } } },
        ],
      });

      expect(fn?.volatility).toBeUndefined();
      expect(fn?.parallel).toBeUndefined();
      expect(fn?.securityDefiner).toBe(false);
    });
  });

  describe("view parser edge paths", () => {
    test("parses security_barrier variants", () => {
      const trueView = parseCreateView(
        {
          view: { relname: "v1", schemaname: "public" },
          query: { SelectStmt: { targetList: [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }] } },
          withCheckOption: "LOCAL_CHECK_OPTION",
          options: [{ DefElem: { defname: "security_barrier", arg: { String: { sval: "true" } } } }],
        },
        ""
      );
      const falseView = parseCreateView(
        {
          view: { relname: "v2" },
          query: { SelectStmt: { targetList: [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }] } },
          options: [{ DefElem: { defname: "security_barrier", arg: { String: { sval: "false" } } } }],
        },
        ""
      );

      expect(trueView?.securityBarrier).toBe(true);
      expect(trueView?.checkOption).toBe("LOCAL");
      expect(falseView?.securityBarrier).toBe(false);
    });

    test("parses security_barrier boolean argument", function () {
      const view = parseCreateView(
        {
          view: { relname: "v_bool_barrier" },
          query: { SelectStmt: { targetList: [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }] } },
          options: [{ DefElem: { defname: "security_barrier", arg: { Boolean: { boolval: true } } } }],
        },
        ""
      );

      expect(view?.securityBarrier).toBe(true);
    });

    test("returns null when view parsing throws", () => {
      const stmt: any = {};
      Object.defineProperty(stmt, "view", {
        get() {
          throw new Error("boom");
        },
      });

      expect(parseCreateView(stmt, "")).toBeNull();
    });

    test("returns null when materialized view parsing throws", () => {
      const stmt: any = { objtype: "OBJECT_MATVIEW" };
      Object.defineProperty(stmt, "into", {
        get() {
          throw new Error("boom");
        },
      });

      expect(parseCreateMaterializedView(stmt)).toBeNull();
    });
  });

  describe("index parser edge paths", () => {
    test("parses storage params and quoted tablespace", function () {
      const index = parseCreateIndex({
        idxname: "idx_users_email",
        relation: { relname: "users", schemaname: "public" },
        indexParams: [{ IndexElem: { name: "email", ordering: "SORTBY_DESC" } }],
        indexIncludingParams: [
          { IndexElem: { name: "display_name" } },
          { IndexElem: { name: "updated_at" } },
        ],
        options: [
          { DefElem: { defname: "fillfactor", arg: { Integer: { ival: 70 } } } },
          { DefElem: { defname: "note", arg: { A_Const: { String: { sval: "x" } } } } },
          { DefElem: { defname: "count", arg: { A_Const: { Integer: { ival: 3 } } } } },
        ],
        tableSpace: { String: { sval: "Fast Space" } },
        unique: true,
        nulls_not_distinct: true,
      });

      expect(index?.sortOrders).toEqual(["DESC"]);
      expect(index?.include).toEqual(["display_name", "updated_at"]);
      expect(index?.unique).toBe(true);
      expect(index?.nullsNotDistinct).toBe(true);
      expect(index?.concurrent).toBe(false);
      expect(index?.storageParameters).toEqual({ fillfactor: "70", note: "x", count: "3" });
      expect(index?.tablespace).toBe("\"Fast Space\"");
    });

    test("drops empty storage params and handles expression index", () => {
      const index = parseCreateIndex({
        idxname: "idx_expr",
        relation: { relname: "users" },
        indexParams: [
          {
            IndexElem: {
              expr: {
                FuncCall: {
                  funcname: [{ String: { sval: "lower" } }],
                  args: [{ ColumnRef: { fields: [{ String: { sval: "email" } }] } }],
                },
              },
              ordering: 2,
            },
          },
        ],
        options: [{ DefElem: { defname: "unused", arg: { TypeName: { names: [] } } } }],
      });

      expect(index?.unique).toBe(false);
      expect(index?.expression?.toLowerCase()).toContain("lower");
      expect(index?.storageParameters).toBeUndefined();
      expect(index?.sortOrders).toEqual(["DESC"]);
    });

    test("parses lowercase tablespace string and deparse fallback", function () {
      const simple = parseCreateIndex({
        idxname: "idx_simple_ts",
        relation: { relname: "users" },
        indexParams: [{ IndexElem: { name: "email" } }],
        tableSpace: { String: { sval: "fastspace" } },
      });

      const fallback = parseCreateIndex({
        idxname: "idx_fallback_ts",
        relation: { relname: "users" },
        indexParams: [{ IndexElem: { name: "email" } }],
        tableSpace: { A_Const: { String: { sval: "fallback_space" } } },
      });

      expect(simple?.tablespace).toBe("fastspace");
      expect(fallback?.tablespace).toBe("'fallback_space'");
    });

    test("returns null when index parsing throws", () => {
      const stmt: any = {};
      Object.defineProperty(stmt, "idxname", {
        get() {
          throw new Error("boom");
        },
      });

      expect(parseCreateIndex(stmt)).toBeNull();
    });
  });

  describe("schema parser sql object edge paths", function () {
    test("covers advanced sql object helper branches", function () {
      const parser = new SchemaParser() as any;

      expect(parser.parsePartitionSqlObject({ CreateStmt: { relation: {} } })).toBeNull();
      expect(
        parser.parsePartitionSqlObject({
          CreateStmt: {
            relation: { relname: "accounts_eu", schemaname: "public" },
            inhRelations: [
              { RangeVar: {} },
              { RangeVar: { relname: "accounts", schemaname: "audit" } },
            ],
          },
        })
      ).toMatchObject({
        key: "partition:public.accounts_eu",
        dependencies: ["partition:audit.accounts"],
      });

      expect(
        parser.parseAlterTableSqlObject({
          AlterTableStmt: {
            relation: null,
            cmds: [{ AlterTableCmd: { subtype: "AT_EnableRowSecurity" } }],
          },
        })
      ).toBeNull();

      expect(
        parser.parseAlterTableSqlObject({
          AlterTableStmt: {
            relation: { relname: "users" },
            cmds: [{ AlterTableCmd: {} }],
          },
        })
      ).toBeNull();

      expect(
        parser.parseAlterTableSqlObject({
          AlterTableStmt: {
            relation: { relname: "accounts", schemaname: "public" },
            cmds: [{ AlterTableCmd: { subtype: "AT_AttachPartition" } }],
          },
        })
      ).toMatchObject({
        kind: "partition",
        key: "partition:public.accounts:alter",
      });

      expect(parser.parsePolicySqlObject({ CreatePolicyStmt: { policy_name: "tenant_policy" } })).toBeNull();
      expect(parser.parseDomainSqlObject({ CreateDomainStmt: { domainname: [] } })).toBeNull();
      expect(parser.parseRangeSqlObject({ CreateRangeStmt: { typeName: [] } })).toBeNull();
      expect(parser.parseForeignServerSqlObject({ CreateForeignServerStmt: {} })).toBeNull();
      expect(parser.parseConstraintTriggerSqlObject({ CreateTrigStmt: { trigname: "trg" } })).toBeNull();
      expect(parser.parseEventTriggerSqlObject({ CreateEventTrigStmt: {} })).toBeNull();
      expect(parser.parseRoleSqlObject({ CreateRoleStmt: {} })).toBeNull();

      expect(
        parser.extractGrantSchema({
          AlterDefaultPrivilegesStmt: {
            action: {
              GrantStmt: {
                objects: [
                  {
                    List: {
                      items: [{ String: { sval: "audit" } }],
                    },
                  },
                ],
              },
            },
          },
        })
      ).toBe("audit");
    });

    test("covers alter table foreign key error branches", function () {
      const parser = new SchemaParser() as any;

      expect(function () {
        parser.parseAlterTableForeignKeys(
          {
            relation: { relname: "users" },
            cmds: [],
          },
          "schema.sql"
        );
      }).toThrow("ALTER TABLE statements are not supported");

      expect(function () {
        parser.parseAlterTableForeignKeys(
          {
            relation: { relname: "users" },
            cmds: [
              {
                AlterTableCmd: {
                  subtype: "AT_AddConstraint",
                  def: { Constraint: { contype: "CONSTR_CHECK" } },
                },
              },
            ],
          },
          "schema.sql"
        );
      }).toThrow("ALTER TABLE statements are not supported");

      expect(function () {
        parser.parseAlterTableForeignKeys(
          {
            relation: { relname: "users" },
            cmds: [
              {
                AlterTableCmd: {
                  subtype: "AT_AddConstraint",
                  def: { Constraint: { contype: "CONSTR_FOREIGN" } },
                },
              },
            ],
          },
          "schema.sql"
        );
      }).toThrow("ALTER TABLE statements are not supported");

      expect(function () {
        parser.mergePendingForeignKeys(
          [],
          [
            {
              tableName: "users",
              schemaName: "public",
              foreignKey: {
                columns: ["account_id"],
                referencedTable: "accounts",
                referencedColumns: ["id"],
              },
            },
          ],
          "schema.sql"
        );
      }).toThrow("ALTER TABLE target not found in schema definitions: public.users");
    });
  });
});
