import { describe, expect, test } from "bun:test";
import { parse } from "pgsql-parser";
import {
  extractAllConstraints,
  parseCheckConstraint,
  parseForeignKey,
} from "../core/schema/parser/tables/constraint-parser";

describe("Constraint parser coverage", () => {
  test("handles extractAllConstraints failures gracefully", () => {
    const badElement: any = {};
    Object.defineProperty(badElement, "ColumnDef", {
      get: function () {
        throw new Error("boom");
      },
    });

    const parsed = extractAllConstraints([badElement], "users");
    expect(parsed.primaryKey).toBeUndefined();
    expect(parsed.foreignKeys).toEqual([]);
    expect(parsed.checkConstraints).toEqual([]);
    expect(parsed.uniqueConstraints).toEqual([]);
  });

  test("parses and rejects check constraints across edge paths", async function () {
    const ast = await parse("CREATE TABLE t (x INT CHECK (x > 0));");
    const checkNode =
      ast.stmts[0]?.stmt?.CreateStmt?.tableElts?.[0]?.ColumnDef?.constraints?.[0]?.Constraint;
    const parsed = parseCheckConstraint(checkNode);
    expect(parsed?.expression).toContain("x > 0");

    const metadata = parseCheckConstraint({
      ...checkNode,
      is_no_inherit: true,
      skip_validation: true,
    });
    expect(metadata?.noInherit).toBe(true);
    expect(metadata?.notValid).toBe(true);

    expect(parseCheckConstraint({ raw_expr: null })).toBeNull();

    const badNode: any = {};
    Object.defineProperty(badNode, "raw_expr", {
      get: function () {
        throw new Error("bad raw expr");
      },
    });
    expect(parseCheckConstraint(badNode)).toBeNull();
  });

  test("handles foreign key missing fields and thrown accessors", () => {
    expect(
      parseForeignKey({
        fk_attrs: [{ String: { sval: "user_id" } }],
        pktable: { relname: "users" },
        pk_attrs: [],
      })
    ).toBeNull();

    const badNode: any = {};
    Object.defineProperty(badNode, "pktable", {
      get: function () {
        throw new Error("bad pktable");
      },
    });

    expect(parseForeignKey(badNode)).toBeNull();
  });
});
