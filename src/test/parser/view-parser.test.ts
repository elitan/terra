import { describe, test, expect } from "bun:test";
import { parseCreateView } from "../../core/schema/parser/view-parser";

describe("View Parser", () => {
  const sampleSql = "CREATE VIEW test_view AS SELECT * FROM users";

  test("should parse basic view", () => {
    const node = {
      name: { text: "test_view" },
      clauses: [
        {
          type: "as_clause",
          expr: {
            type: "select_stmt",
            range: [24, 49], // "SELECT * FROM users"
          },
        },
      ],
    };

    const result = parseCreateView(node, sampleSql);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("test_view");
    expect(result!.definition).toBe("SELECT * FROM users");
    expect(result!.materialized).toBe(false);
  });

  test("should parse materialized view", () => {
    const node = {
      name: { text: "mat_view" },
      kinds: [
        {
          type: "relation_kind",
          kindKw: { name: "MATERIALIZED" },
        },
      ],
      clauses: [
        {
          type: "as_clause",
          expr: {
            type: "select_stmt",
            range: [24, 49],
          },
        },
      ],
    };

    const result = parseCreateView(node, sampleSql);
    expect(result).not.toBeNull();
    expect(result!.materialized).toBe(true);
  });

  test("should parse view with CHECK OPTION", () => {
    const node = {
      name: { text: "checked_view" },
      clauses: [
        {
          type: "as_clause",
          expr: {
            type: "select_stmt",
            range: [24, 49],
          },
        },
        {
          type: "with_check_option_clause",
        },
      ],
    };

    const result = parseCreateView(node, sampleSql);
    expect(result).not.toBeNull();
    expect(result!.checkOption).toBe("CASCADED");
  });

  test("should parse view with LOCAL CHECK OPTION", () => {
    const node = {
      name: { text: "local_view" },
      clauses: [
        {
          type: "as_clause",
          expr: {
            type: "select_stmt",
            range: [24, 49],
          },
        },
        {
          type: "with_check_option_clause",
          levelKw: { name: "LOCAL" },
        },
      ],
    };

    const result = parseCreateView(node, sampleSql);
    expect(result).not.toBeNull();
    expect(result!.checkOption).toBe("LOCAL");
  });

  test("should parse view with security_barrier", () => {
    const node = {
      name: { text: "secure_view" },
      clauses: [
        {
          type: "as_clause",
          expr: {
            type: "select_stmt",
            range: [24, 49],
          },
        },
        {
          type: "postgresql_with_options",
          options: {
            expr: {
              items: [
                {
                  type: "table_option",
                  name: { name: "security_barrier" },
                  value: { value: true },
                },
              ],
            },
          },
        },
      ],
    };

    const result = parseCreateView(node, sampleSql);
    expect(result).not.toBeNull();
    expect(result!.securityBarrier).toBe(true);
  });

  test("should handle quoted view names", () => {
    const node = {
      name: { text: '"Quoted View"' },
      clauses: [
        {
          type: "as_clause",
          expr: {
            type: "select_stmt",
            range: [24, 49],
          },
        },
      ],
    };

    const result = parseCreateView(node, sampleSql);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Quoted View");
  });

  test("should return null if no view name", () => {
    const node = {
      clauses: [
        {
          type: "as_clause",
          expr: {
            type: "select_stmt",
            range: [24, 49],
          },
        },
      ],
    };

    const result = parseCreateView(node, sampleSql);
    expect(result).toBeNull();
  });

  test("should return null if no definition", () => {
    const node = {
      name: { text: "no_def_view" },
      clauses: [],
    };

    const result = parseCreateView(node, sampleSql);
    expect(result).toBeNull();
  });

  test("should handle name from node.name.name", () => {
    const node = {
      name: { name: "alt_view" },
      clauses: [
        {
          type: "as_clause",
          expr: {
            type: "select_stmt",
            range: [24, 49],
          },
        },
      ],
    };

    const result = parseCreateView(node, sampleSql);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("alt_view");
  });
});
