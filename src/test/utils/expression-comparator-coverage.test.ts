import { beforeAll, describe, expect, test } from "bun:test";
import { loadModule } from "pgsql-parser";
import { expressionsEqual } from "../../utils/expression-comparator";

describe("Expression comparator coverage", () => {
  beforeAll(async () => {
    await loadModule();
  });

  test("matches fast-path equivalent strings", () => {
    expect(expressionsEqual("status = 'active'", " status   =   'active' ")).toBe(true);
  });

  test("normalizes BETWEEN against explicit range checks", () => {
    expect(expressionsEqual("age BETWEEN 18 AND 65", "age >= 18 AND age <= 65")).toBe(true);
  });

  test("normalizes ANY and IN forms", () => {
    expect(expressionsEqual("status = ANY (ARRAY['a', 'b'])", "status IN ('a', 'b')")).toBe(true);
  });

  test("normalizes ANY and ALL forms with explicit array type casts", () => {
    expect(expressionsEqual("status = ANY (ARRAY['a', 'b']::text[])", "status IN ('a', 'b')")).toBe(true);
    expect(expressionsEqual("status <> ALL (ARRAY['a', 'b']::text[])", "status NOT IN ('a', 'b')")).toBe(true);
  });

  test("normalizes ALL and NOT IN forms", () => {
    expect(expressionsEqual("status <> ALL (ARRAY['a', 'b'])", "status NOT IN ('a', 'b')")).toBe(true);
  });

  test("handles ANY and ALL with subquery right-hand side", () => {
    expect(expressionsEqual("status = ANY(SELECT status FROM t)", "status = ANY (SELECT status FROM t)")).toBe(true);
    expect(expressionsEqual("status <> ALL(SELECT status FROM t)", "status <> ALL (SELECT status FROM t)")).toBe(true);
  });

  test("normalizes LIKE and ILIKE operation shapes", () => {
    expect(expressionsEqual("name LIKE 'jo%'", "name ~~ 'jo%'")).toBe(true);
    expect(expressionsEqual("name ILIKE 'jo%'", "name ~~* 'jo%'")).toBe(true);
  });

  test("normalizes non-numeric type casts to inner values", () => {
    expect(expressionsEqual("name = 'abc'::text", "name = 'abc'")).toBe(true);
  });

  test("normalizes numeric casts and fallback parse failures", () => {
    expect(expressionsEqual("id = '1'::integer", "id = 1")).toBe(true);
    expect(expressionsEqual("id =", "id =")).toBe(true);
    expect(expressionsEqual("id =", "name =")).toBe(false);
  });
});
