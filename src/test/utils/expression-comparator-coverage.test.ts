import { describe, expect, test } from "bun:test";
import { expressionsEqual } from "../../utils/expression-comparator";

describe("Expression comparator coverage", () => {
  test("matches fast-path equivalent strings", () => {
    expect(expressionsEqual("status = 'active'", " status   =   'active' ")).toBe(true);
  });

  test("normalizes BETWEEN against explicit range checks", () => {
    expect(expressionsEqual("age BETWEEN 18 AND 65", "age >= 18 AND age <= 65")).toBe(true);
  });

  test("normalizes ANY and IN forms", () => {
    expect(expressionsEqual("status = ANY (ARRAY['a', 'b'])", "status IN ('a', 'b')")).toBe(true);
  });

  test("normalizes ALL and NOT IN forms", () => {
    expect(expressionsEqual("status <> ALL (ARRAY['a', 'b'])", "status NOT IN ('a', 'b')")).toBe(true);
  });

  test("normalizes LIKE and ILIKE operation shapes", () => {
    expect(expressionsEqual("name LIKE 'jo%'", "name ~~ 'jo%'")).toBe(true);
    expect(expressionsEqual("name ILIKE 'jo%'", "name ~~* 'jo%'")).toBe(true);
  });

  test("normalizes numeric casts and fallback parse failures", () => {
    expect(expressionsEqual("id = '1'::integer", "id = 1")).toBe(true);
    expect(expressionsEqual("id =", "id =")).toBe(true);
    expect(expressionsEqual("id =", "name =")).toBe(false);
  });
});
