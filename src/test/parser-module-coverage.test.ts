import { describe, expect, test } from "bun:test";
import { parse } from "pgsql-parser";
import { MigrationExecutor } from "../core/migration/executor";
import { parseCreateExtension } from "../core/schema/parser/extension-parser";
import { parseCreateFunction } from "../core/schema/parser/function-parser";
import { parseCreateType } from "../core/schema/parser/enum-parser";
import { parseCreateProcedure } from "../core/schema/parser/procedure-parser";
import { parseCreateSchema } from "../core/schema/parser/schema-definition-parser";
import { parseCreateSequence } from "../core/schema/parser/sequence-parser";
import { parseCreateTrigger } from "../core/schema/parser/trigger-parser";
import {
  isReplicaIdentitySubtype,
  parseAlterTableReplicaIdentities,
} from "../core/schema/parser/replica-identity-parser";
import {
  isClusteringSubtype,
  mergePendingClusteringChoices,
  parseAlterRelationClustering,
} from "../core/schema/parser/clustering-parser";
import {
  extractAllConstraints,
  parseForeignKey,
  parseTablePrimaryKey,
  parseUniqueConstraint,
} from "../core/schema/parser/tables/constraint-parser";

describe("Parser module coverage", () => {
  describe("replica identity parser", function () {
    test("recognizes only replica identity ALTER TABLE commands", function () {
      expect(isReplicaIdentitySubtype("AT_ReplicaIdentity")).toBe(true);
      expect(isReplicaIdentitySubtype("AT_AddColumn")).toBe(false);
      expect(parseAlterTableReplicaIdentities({ cmds: [] })).toEqual([]);
    });

    test("rejects missing targets and malformed index declarations", function () {
      const replicaCommand = {
        AlterTableCmd: {
          subtype: "AT_ReplicaIdentity",
          def: { ReplicaIdentityStmt: { identity_type: "f" } },
        },
      };
      expect(function parseMissingTarget() {
        parseAlterTableReplicaIdentities({ cmds: [replicaCommand] });
      }).toThrow(/missing a table name/i);

      expect(function parseUnnamedIndex() {
        parseAlterTableReplicaIdentities({
          relation: { relname: "events" },
          cmds: [{
            AlterTableCmd: {
              subtype: "AT_ReplicaIdentity",
              def: { ReplicaIdentityStmt: { identity_type: "i" } },
            },
          }],
        });
      }).toThrow(/using index with a named index/i);
    });
  });

  describe("clustering parser", function () {
    test("recognizes, parses, and clears persistent choices", function () {
      expect(isClusteringSubtype("AT_ClusterOn")).toBe(true);
      expect(isClusteringSubtype("AT_DropCluster")).toBe(true);
      expect(isClusteringSubtype("AT_AddColumn")).toBe(false);
      expect(parseAlterRelationClustering({ cmds: [] })).toEqual([]);
      expect(parseAlterRelationClustering({
        relation: { schemaname: "public", relname: "events" },
        objtype: "OBJECT_MATVIEW",
        cmds: [
          { AlterTableCmd: { subtype: "AT_ClusterOn", name: "events_idx" } },
          { AlterTableCmd: { subtype: "AT_DropCluster" } },
        ],
      })).toEqual([
        {
          schemaName: "public",
          relationName: "events",
          relationKind: "materialized-view",
          indexName: "events_idx",
        },
        {
          schemaName: "public",
          relationName: "events",
          relationKind: "materialized-view",
        },
      ]);
    });

    test("rejects malformed or unbound choices", function () {
      const command = {
        AlterTableCmd: { subtype: "AT_ClusterOn", name: "events_idx" },
      };
      expect(function parseMissingTarget() {
        parseAlterRelationClustering({ cmds: [command] });
      }).toThrow(/missing a relation name/i);
      expect(function parseMissingIndex() {
        parseAlterRelationClustering({
          relation: { relname: "events" },
          cmds: [{ AlterTableCmd: { subtype: "AT_ClusterOn" } }],
        });
      }).toThrow(/must name an index/i);

      expect(function mergeMissingTarget() {
        mergePendingClusteringChoices([], [], [], [{
          relationName: "missing",
          relationKind: "table",
          indexName: "missing_idx",
        }]);
      }).toThrow(/target.*not found/i);
      expect(function mergeWrongKind() {
        mergePendingClusteringChoices(
          [{ name: "events", columns: [] }],
          [],
          [],
          [{
            relationName: "events",
            relationKind: "materialized-view",
            indexName: "events_idx",
          }]
        );
      }).toThrow(/must use ALTER MATERIALIZED VIEW/i);
      expect(function mergePartitionChoice() {
        mergePendingClusteringChoices(
          [],
          [],
          [{
            kind: "partition",
            key: "partition:public.events",
            name: "events",
            schema: "public",
            createStatement: "CREATE TABLE public.events (id integer) PARTITION BY RANGE (id);",
          }],
          [{
            relationName: "events",
            relationKind: "table",
            indexName: "events_idx",
          }]
        );
      }).toThrow(/partition clustering/i);
    });

    test("merges table, materialized-view, and explicit clear choices", function () {
      const tables = [{
        name: "events",
        columns: [],
        clusterIndex: "old_idx",
      }];
      const views = [{
        name: "summary",
        definition: "SELECT 1",
        materialized: true,
      }];
      mergePendingClusteringChoices(tables, views, [], [
        { relationName: "events", relationKind: "table" },
        {
          relationName: "summary",
          relationKind: "materialized-view",
          indexName: "summary_idx",
        },
      ]);
      expect(tables[0]).not.toHaveProperty("clusterIndex");
      expect(views[0]).toHaveProperty("clusterIndex", "summary_idx");
    });
  });

  describe("extension parser", () => {
    test("parses extension options", () => {
      const extension = parseCreateExtension({
        extname: "vector",
        options: [
          { DefElem: { defname: "schema", arg: { String: { sval: "public" } } } },
          { DefElem: { defname: "new_version", arg: { String: { sval: "0.8.0" } } } },
          { DefElem: { defname: "cascade" } },
        ],
      });

      expect(extension).toEqual({
        name: "vector",
        schema: "public",
        version: "0.8.0",
        cascade: true,
      });
    });

    test("returns null for missing extension name", () => {
      expect(parseCreateExtension({ options: [] })).toBeNull();
    });

    test("returns null when statement access throws", () => {
      const stmt: any = {};
      Object.defineProperty(stmt, "extname", {
        get() {
          throw new Error("boom");
        },
      });
      expect(parseCreateExtension(stmt)).toBeNull();
    });
  });

  describe("schema parser", () => {
    test("parses schema name", () => {
      expect(parseCreateSchema({ schemaname: "analytics" })).toEqual({ name: "analytics" });
    });

    test("rejects a missing schema identity", () => {
      expect(function parseMissingSchema() {
        return parseCreateSchema({});
      }).toThrow("has no concrete schema name");
    });

    test("does not hide schema parser failures", () => {
      const stmt: any = {};
      Object.defineProperty(stmt, "schemaname", {
        get() {
          throw new Error("boom");
        },
      });
      expect(function parseBrokenSchema() {
        return parseCreateSchema(stmt);
      }).toThrow("boom");
    });
  });

  describe("enum parser", () => {
    test("parses schema qualified enum type", () => {
      const parsed = parseCreateType({
        typeName: [{ String: { sval: "public" } }, { String: { sval: "status" } }],
        vals: [{ String: { sval: "pending" } }, { String: { sval: "active" } }],
      });

      expect(parsed).toEqual({
        name: "status",
        schema: "public",
        values: ["pending", "active"],
      });
    });

    test("returns null for missing required fields", () => {
      expect(parseCreateType({})).toBeNull();
      expect(parseCreateType({ vals: [{ String: { sval: "x" } }] })).toBeNull();
    });

    test("preserves empty labels and zero-label enums", () => {
      expect(
        parseCreateType({
          typeName: [{ String: { sval: "status" } }],
          vals: [{ String: { sval: "" } }],
        })
      ).toEqual({ name: "status", schema: undefined, values: [""] });
      expect(
        parseCreateType({
          typeName: [{ String: { sval: "empty_status" } }],
        })
      ).toEqual({ name: "empty_status", schema: undefined, values: [] });
    });

    test("returns null on unexpected parse errors", () => {
      const stmt: any = {};
      Object.defineProperty(stmt, "typeName", {
        get() {
          throw "boom";
        },
      });

      expect(parseCreateType(stmt)).toBeNull();
    });
  });

  describe("sequence parser", () => {
    test("parses sequence with full options", () => {
      const sequence = parseCreateSequence({
        sequence: { relname: "invoice_seq", schemaname: "public" },
        options: [
          {
            DefElem: {
              defname: "as",
              arg: {
                TypeName: {
                  names: [{ String: { sval: "pg_catalog" } }, { String: { sval: "int8" } }],
                },
              },
            },
          },
          { DefElem: { defname: "increment", arg: { Integer: { ival: 3 } } } },
          { DefElem: { defname: "minvalue", arg: { Float: { fval: 1.5 } } } },
          { DefElem: { defname: "maxvalue", arg: { Integer: { ival: 9000 } } } },
          { DefElem: { defname: "start", arg: { Integer: { ival: 100 } } } },
          { DefElem: { defname: "cache", arg: { Integer: { ival: 25 } } } },
          { DefElem: { defname: "cycle", arg: { Integer: { ival: 1 } } } },
          {
            DefElem: {
              defname: "owned_by",
              arg: {
                List: {
                  items: [
                    { String: { sval: "public" } },
                    { String: { sval: "users" } },
                    { String: { sval: "id" } },
                  ],
                },
              },
            },
          },
        ],
      });

      expect(sequence).toEqual({
        name: "invoice_seq",
        schema: "public",
        dataType: "BIGINT",
        increment: 3,
        minValue: 1.5,
        maxValue: 9000,
        start: 100,
        cache: 25,
        cycle: true,
        ownedBy: "public.users.id",
      });
    });

    test("handles CYCLE boolean and OWNED BY NONE", () => {
      const sequence = parseCreateSequence({
        sequence: { relname: "simple_seq" },
        options: [
          { DefElem: { defname: "as", arg: { TypeName: { names: [{ String: { sval: "smallint" } }] } } } },
          { DefElem: { defname: "cycle", arg: { Boolean: { boolval: false } } } },
          {
            DefElem: {
              defname: "owned_by",
              arg: { List: { items: [{ String: { sval: "none" } }] } },
            },
          },
        ],
      });

      expect(sequence).toEqual({
        name: "simple_seq",
        schema: undefined,
        dataType: "SMALLINT",
        increment: undefined,
        minValue: undefined,
        maxValue: undefined,
        start: undefined,
        cache: undefined,
        cycle: false,
        ownedBy: undefined,
      });
    });

    test("returns null when sequence name is missing", () => {
      expect(parseCreateSequence({ sequence: { schemaname: "public" } })).toBeNull();
    });

    test("returns null when sequence parse throws", () => {
      const stmt: any = {};
      Object.defineProperty(stmt, "sequence", {
        get() {
          throw new Error("boom");
        },
      });
      expect(parseCreateSequence(stmt)).toBeNull();
    });
  });

  describe("function parser", () => {
    test("parses function metadata and options", () => {
      const fn = parseCreateFunction({
        funcname: [{ String: { sval: "public" } }, { String: { sval: "compute_total" } }],
        parameters: [
          {
            FunctionParameter: {
              name: "a",
              mode: "FUNC_PARAM_IN",
              argType: { names: [{ String: { sval: "int4" } }] },
            },
          },
          {
            FunctionParameter: {
              name: "b",
              mode: "FUNC_PARAM_DEFAULT",
              argType: { names: [{ String: { sval: "varchar" } }] },
              defexpr: { expr: { text: "'x'" } },
            },
          },
          {
            FunctionParameter: {
              name: "out_value",
              mode: "FUNC_PARAM_OUT",
              argType: { names: [{ String: { sval: "int8" } }] },
            },
          },
        ],
        returnType: { names: [{ String: { sval: "int4" } }] },
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
          {
            DefElem: {
              defname: "as",
              arg: {
                List: {
                  items: [{ String: { sval: "SELECT 1" } }],
                },
              },
            },
          },
          { DefElem: { defname: "volatility", arg: { String: { sval: "stable" } } } },
          { DefElem: { defname: "parallel", arg: { String: { sval: "restricted" } } } },
          { DefElem: { defname: "security", arg: { Integer: { ival: 1 } } } },
          { DefElem: { defname: "strict", arg: { Integer: { ival: 1 } } } },
          { DefElem: { defname: "cost", arg: { Float: { fval: 4.2 } } } },
          { DefElem: { defname: "rows", arg: { Integer: { ival: 25 } } } },
        ],
      });

      expect(fn).toEqual({
        name: "compute_total",
        schema: "public",
        parameters: [
          { name: "a", type: "integer", mode: "IN" },
          { name: "b", type: "character varying", default: "'x'" },
          { name: "out_value", type: "bigint", mode: "OUT" },
        ],
        returnType: "integer",
        language: "sql",
        body: "SELECT 1",
        volatility: "STABLE",
        parallel: "RESTRICTED",
        leakproof: undefined,
        securityDefiner: true,
        strict: true,
        cost: 4.2,
        rows: 25,
        configuration: undefined,
      });
    });

    test("returns null when required function fields are missing", () => {
      expect(parseCreateFunction({ options: [] })).toBeNull();
      expect(
        parseCreateFunction({
          funcname: [{ String: { sval: "f" } }],
          options: [{ DefElem: { defname: "language", arg: { String: { sval: "sql" } } } }],
        })
      ).toBeNull();
      expect(
        parseCreateFunction({
          funcname: [{ String: { sval: "f" } }],
          returnType: { names: [{ String: { sval: "int4" } }] },
          options: [],
        })
      ).toBeNull();
    });

    test("handles unknown parameter type and boolean security", () => {
      const fn = parseCreateFunction({
        funcname: [{ String: { sval: "f" } }],
        parameters: [{ FunctionParameter: { name: "x", mode: "FUNC_PARAM_INOUT", argType: null } }],
        returnType: { names: [{ String: { sval: "bool" } }] },
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "plpgsql" } } } },
          { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "BEGIN END" } }] } } } },
          { DefElem: { defname: "security", arg: { Boolean: { boolval: false } } } },
          { DefElem: { defname: "parallel", arg: { String: { sval: "safe" } } } },
          { DefElem: { defname: "volatility", arg: { String: { sval: "immutable" } } } },
        ],
      });

      expect(fn?.parameters).toEqual([{ name: "x", type: "unknown", mode: "INOUT" }]);
      expect(fn?.securityDefiner).toBe(false);
      expect(fn?.parallel).toBe("SAFE");
      expect(fn?.volatility).toBe("IMMUTABLE");
      expect(fn?.returnType).toBe("boolean");
    });

    test("returns null when function parse throws", () => {
      const stmt: any = {};
      Object.defineProperty(stmt, "funcname", {
        get() {
          throw new Error("boom");
        },
      });
      expect(parseCreateFunction(stmt)).toBeNull();
    });
  });

  describe("procedure parser", () => {
    test("parses procedure metadata and options", () => {
      const proc = parseCreateProcedure({
        funcname: [{ String: { sval: "public" } }, { String: { sval: "sync_users" } }],
        parameters: [
          {
            FunctionParameter: {
              name: "p_id",
              mode: "FUNC_PARAM_IN",
              argType: { names: [{ String: { sval: "int4" } }] },
            },
          },
          {
            FunctionParameter: {
              name: "p_name",
              mode: "FUNC_PARAM_DEFAULT",
              argType: { names: [{ String: { sval: "varchar" } }] },
              defexpr: {
                A_Const: {
                  sval: { sval: "x" },
                },
              },
            },
          },
          {
            FunctionParameter: {
              name: "p_flag",
              mode: "FUNC_PARAM_INOUT",
              argType: null,
            },
          },
        ],
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "plpgsql" } } } },
          {
            DefElem: {
              defname: "as",
              arg: {
                List: {
                  items: [{ String: { sval: "BEGIN END" } }],
                },
              },
            },
          },
          { DefElem: { defname: "security", arg: { Integer: { ival: 1 } } } },
        ],
      });

      expect(proc).toBeDefined();
      expect(proc?.name).toBe("sync_users");
      expect(proc?.schema).toBe("public");
      expect(proc?.language).toBe("plpgsql");
      expect(proc?.body).toBe("BEGIN END");
      expect(proc?.securityDefiner).toBe(true);
      expect(proc?.parameters).toEqual([
        { name: "p_id", type: "integer", mode: "IN" },
        { name: "p_name", type: "character varying", default: "'x'" },
        { name: "p_flag", type: "unknown", mode: "INOUT" },
      ]);
    });

    test("returns null when required fields are missing", () => {
      expect(parseCreateProcedure({})).toBeNull();
      expect(parseCreateProcedure({ funcname: [{ String: { sval: "p" } }], options: [] })).toBeNull();
      expect(
        parseCreateProcedure({
          funcname: [{ String: { sval: "p" } }],
          options: [{ DefElem: { defname: "language", arg: { String: { sval: "sql" } } } }],
        })
      ).toBeNull();
    });

    test("handles thrown extraction paths", () => {
      const badNameNode: any = {};
      Object.defineProperty(badNameNode, "funcname", {
        get() {
          throw new Error("boom");
        },
      });
      expect(parseCreateProcedure(badNameNode)).toBeNull();

      const badLanguageNode: any = {
        funcname: [{ String: { sval: "proc" } }],
      };
      Object.defineProperty(badLanguageNode, "options", {
        get() {
          throw new Error("bad language");
        },
      });
      expect(parseCreateProcedure(badLanguageNode)).toBeNull();

      let bodyGetterCount = 0;
      const badBodyNode: any = {
        funcname: [{ String: { sval: "proc" } }],
      };
      Object.defineProperty(badBodyNode, "options", {
        get() {
          bodyGetterCount += 1;
          if (bodyGetterCount === 1) {
            return [{ DefElem: { defname: "language", arg: { String: { sval: "sql" } } } }];
          }
          throw new Error("bad body");
        },
      });
      expect(parseCreateProcedure(badBodyNode)).toBeNull();
    });

    test("continues when parameter or security extraction fails", () => {
      const badParamsNode: any = {
        funcname: [{ String: { sval: "proc_with_bad_params" } }],
        options: [
          { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
          { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
        ],
      };
      Object.defineProperty(badParamsNode, "parameters", {
        get() {
          throw new Error("bad params");
        },
      });

      const parsedWithBadParams = parseCreateProcedure(badParamsNode);
      expect(parsedWithBadParams?.parameters).toEqual([]);

      let optionsGetterCount = 0;
      const badSecurityNode: any = {
        funcname: [{ String: { sval: "proc_with_bad_security" } }],
      };
      Object.defineProperty(badSecurityNode, "options", {
        get() {
          optionsGetterCount += 1;
          if (optionsGetterCount <= 8) {
            return [
              { DefElem: { defname: "language", arg: { String: { sval: "sql" } } } },
              { DefElem: { defname: "as", arg: { List: { items: [{ String: { sval: "SELECT 1" } }] } } } },
            ];
          }
          throw new Error("bad security");
        },
      });

      const parsedWithBadSecurity = parseCreateProcedure(badSecurityNode);
      expect(parsedWithBadSecurity?.name).toBe("proc_with_bad_security");
      expect(parsedWithBadSecurity?.securityDefiner).toBeUndefined();
    });
  });

  describe("trigger parser", () => {
    test("parses trigger with full bitmasks", () => {
      const trigger = parseCreateTrigger({
        trigname: "trg_all",
        relation: { relname: "orders", schemaname: "tenant_a" },
        timing: 64,
        events: 4 | 8 | 16 | 32,
        row: true,
        funcname: [{ String: { sval: "public" } }, { String: { sval: "audit_orders" } }],
        args: [{ A_Const: { sval: { sval: "x" } } }],
      });

      expect(trigger).toEqual({
        name: "trg_all",
        tableName: "orders",
        schema: "tenant_a",
        timing: "INSTEAD OF",
        events: ["INSERT", "DELETE", "UPDATE", "TRUNCATE"],
        forEach: "ROW",
        when: undefined,
        functionName: "audit_orders",
        functionSchema: "public",
        functionArgs: ["'x'"],
      });
    });

    test("parses default timing and statement-level trigger", () => {
      const trigger = parseCreateTrigger({
        trigname: "trg_insert",
        relation: { relname: "orders" },
        timing: 0,
        events: 4,
        row: false,
        funcname: [{ String: { sval: "run" } }],
      });

      expect(trigger?.timing).toBe("AFTER");
      expect(trigger?.events).toEqual(["INSERT"]);
      expect(trigger?.forEach).toBe("STATEMENT");
    });

    test("parses trigger when clause and function args", async () => {
      const ast = await parse(`
        CREATE TRIGGER trg_with_when
        BEFORE INSERT ON orders
        FOR EACH ROW
        WHEN (NEW.id > 0)
        EXECUTE FUNCTION public.audit_orders(1, 'x');
      `);

      const stmt = ast.stmts[0]?.stmt?.CreateTrigStmt;
      const trigger = parseCreateTrigger(stmt);

      expect(trigger?.when).toBe("new.id > 0");
      expect(trigger?.functionSchema).toBe("public");
      expect(trigger?.functionArgs).toEqual(["'1'", "'x'"]);
    });

    test("returns null for missing trigger fields", () => {
      expect(parseCreateTrigger({})).toBeNull();
      expect(parseCreateTrigger({ trigname: "x", relation: { relname: "t" }, events: 4 })).toBeNull();
      expect(
        parseCreateTrigger({ trigname: "x", relation: { relname: "t" }, events: 4, funcname: [] })
      ).toBeNull();
    });

    test("returns null when trigger parse throws", () => {
      const stmt: any = {};
      Object.defineProperty(stmt, "trigname", {
        get() {
          throw new Error("boom");
        },
      });
      expect(parseCreateTrigger(stmt)).toBeNull();
    });
  });

  describe("constraint parser", () => {
    test("extracts column and table constraints", async () => {
      const ast = await parse(`
        CREATE TABLE child (
          id INT PRIMARY KEY,
          parent_id INT,
          score INT CHECK (score > 0),
          email TEXT UNIQUE,
          CONSTRAINT fk_parent FOREIGN KEY (parent_id)
            REFERENCES public.parent(id)
            ON DELETE CASCADE ON UPDATE SET NULL,
          CONSTRAINT uq_parent_email UNIQUE (parent_id, email)
        );
      `);

      const tableElts = ast.stmts[0]?.stmt?.CreateStmt?.tableElts || [];
      const constraints = extractAllConstraints(tableElts, "child");

      expect(constraints.primaryKey).toEqual({ columns: ["id"] });
      expect(constraints.foreignKeys).toHaveLength(1);
      expect(constraints.foreignKeys[0]).toEqual({
        name: "fk_parent",
        columns: ["parent_id"],
        referencedTable: "public.parent",
        referencedColumns: ["id"],
        onDelete: "CASCADE",
        onUpdate: "SET NULL",
      });
      expect(constraints.checkConstraints).toHaveLength(1);
      expect(constraints.checkConstraints[0]?.expression.toLowerCase()).toContain("score > 0");
      expect(constraints.uniqueConstraints).toEqual([
        { name: undefined, columns: ["email"] },
        { name: "uq_parent_email", columns: ["parent_id", "email"] },
      ]);
    });

    test("parses foreign key and unique/primary constraints directly", () => {
      const fk = parseForeignKey({
        conname: "fk_simple",
        fk_attrs: [{ String: { sval: "user_id" } }],
        pktable: { schemaname: "public", relname: "users" },
        pk_attrs: [{ String: { sval: "id" } }],
        fk_del_action: "a",
        fk_upd_action: "r",
        deferrable: true,
        initdeferred: true,
      });

      expect(fk).toEqual({
        name: "fk_simple",
        columns: ["user_id"],
        referencedTable: "public.users",
        referencedColumns: ["id"],
        onDelete: "NO ACTION",
        onUpdate: "RESTRICT",
        deferrable: true,
        initiallyDeferred: true,
      });

      expect(parseForeignKey({ fk_attrs: [{ String: { sval: "x" } }] })).toBeNull();
      expect(parseUniqueConstraint({ conname: "uq", keys: [{ String: { sval: "email" } }] })).toEqual({
        name: "uq",
        columns: ["email"],
      });
      expect(
        parseUniqueConstraint({
          conname: "uq_deferrable",
          keys: [{ String: { sval: "email" } }],
          deferrable: true,
          initdeferred: true,
        })
      ).toEqual({
        name: "uq_deferrable",
        columns: ["email"],
        deferrable: true,
        initiallyDeferred: true,
      });
      expect(parseTablePrimaryKey({ conname: "pk", keys: [{ String: { sval: "id" } }] })).toEqual({
        name: "pk",
        columns: ["id"],
      });
    });

    test("handles malformed nodes", () => {
      const badUnique: any = {};
      Object.defineProperty(badUnique, "keys", {
        get() {
          throw new Error("boom");
        },
      });

      const badPk: any = {};
      Object.defineProperty(badPk, "keys", {
        get() {
          throw new Error("boom");
        },
      });

      expect(parseUniqueConstraint(badUnique)).toBeNull();
      expect(parseTablePrimaryKey(badPk)).toBeNull();
    });

    test("parses deferrable foreign key and unique constraints", async () => {
      const ast = await parse(`
        CREATE TABLE child (
          id INT PRIMARY KEY,
          parent_id INT NOT NULL,
          external_id TEXT,
          CONSTRAINT fk_parent FOREIGN KEY (parent_id)
            REFERENCES parent(id)
            DEFERRABLE INITIALLY DEFERRED,
          CONSTRAINT uq_external UNIQUE (external_id)
            DEFERRABLE INITIALLY DEFERRED
        );
      `);

      const tableElts = ast.stmts[0]?.stmt?.CreateStmt?.tableElts || [];
      const constraints = extractAllConstraints(tableElts, "child");

      expect(constraints.foreignKeys).toEqual([
        {
          name: "fk_parent",
          columns: ["parent_id"],
          referencedTable: "parent",
          referencedColumns: ["id"],
          onDelete: "NO ACTION",
          onUpdate: "NO ACTION",
          deferrable: true,
          initiallyDeferred: true,
        },
      ]);

      expect(constraints.uniqueConstraints).toEqual([
        {
          name: "uq_external",
          columns: ["external_id"],
          deferrable: true,
          initiallyDeferred: true,
        },
      ]);
    });

    test("parses complex check expression text", async () => {
      const ast = await parse(`
        CREATE TABLE invoices (
          id INT PRIMARY KEY,
          amount NUMERIC(10,2),
          discount NUMERIC(10,2),
          status TEXT,
          CONSTRAINT chk_amount_logic CHECK (
            (amount IS NULL OR amount >= 0)
            AND (
              discount IS NULL
              OR (amount IS NOT NULL AND discount <= amount * 0.5)
            )
            AND status IN ('draft', 'sent', 'paid')
          )
        );
      `);

      const tableElts = ast.stmts[0]?.stmt?.CreateStmt?.tableElts || [];
      const constraints = extractAllConstraints(tableElts, "invoices");

      expect(constraints.checkConstraints).toHaveLength(1);
      expect(constraints.checkConstraints[0]?.name).toBe("chk_amount_logic");
      const expression = constraints.checkConstraints[0]?.expression
        .toLowerCase()
        .replace(/\s+/g, " ");
      expect(expression).toContain("(amount is null or amount >= 0)");
      expect(expression).toContain("discount <= (amount * 0.5)");
      expect(expression).toMatch(/status (in|= any)/);
    });
  });

  describe("migration executor helpers", () => {
    test("detects destructive operations", () => {
      const executor = new MigrationExecutor({} as any);

      expect((executor as any).isDestructiveOperation("DROP TABLE users" as string)).toBe(true);
      expect((executor as any).isDestructiveOperation("ALTER TABLE users DROP COLUMN email" as string)).toBe(true);
      expect((executor as any).isDestructiveOperation("DROP TYPE status" as string)).toBe(true);
      expect((executor as any).isDestructiveOperation("DROP VIEW active_users" as string)).toBe(true);
      expect((executor as any).isDestructiveOperation("CREATE TABLE users (id INT)" as string)).toBe(false);
    });

    test("filters destructive statements", () => {
      const executor = new MigrationExecutor({} as any);
      const filtered = (executor as any).getDestructiveOperations([
        "CREATE TABLE users (id INT)",
        "DROP TABLE users",
        "ALTER TABLE users ADD COLUMN name TEXT",
        "ALTER TABLE users DROP COLUMN name",
      ] as string[]);

      expect(filtered).toEqual(["DROP TABLE users", "ALTER TABLE users DROP COLUMN name"]);
    });
  });
});
