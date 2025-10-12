import { describe, test, expect } from "bun:test";
import { parseCreateIndex } from "../../core/schema/parser/index-parser";

describe("Index Parser", () => {
  test("should parse basic index", () => {
    const node = {
      name: { text: "idx_users_email" },
      table: { text: "users" },
      columns: {
        expr: {
          items: [
            {
              type: "index_specification",
              expr: { type: "identifier", text: "email" },
            },
          ],
        },
      },
    };

    const result = parseCreateIndex(node);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("idx_users_email");
    expect(result!.tableName).toBe("users");
    expect(result!.columns).toEqual(["email"]);
    expect(result!.type).toBe("btree");
    expect(result!.unique).toBe(false);
    expect(result!.concurrent).toBe(false);
  });

  test("should parse unique index", () => {
    const node = {
      name: { text: "idx_unique" },
      table: { text: "users" },
      indexTypeKw: { name: "UNIQUE" },
      columns: {
        expr: {
          items: [
            {
              type: "index_specification",
              expr: { type: "identifier", text: "email" },
            },
          ],
        },
      },
    };

    const result = parseCreateIndex(node);
    expect(result).not.toBeNull();
    expect(result!.unique).toBe(true);
  });

  test("should parse concurrent index", () => {
    const node = {
      name: { text: "idx_concurrent" },
      table: { text: "users" },
      concurrentlyKw: { name: "CONCURRENTLY" },
      columns: {
        expr: {
          items: [
            {
              type: "index_specification",
              expr: { type: "identifier", text: "email" },
            },
          ],
        },
      },
    };

    const result = parseCreateIndex(node);
    expect(result).not.toBeNull();
    expect(result!.concurrent).toBe(true);
  });

  test("should parse GIN index type", () => {
    const node = {
      name: { text: "idx_gin" },
      table: { text: "documents" },
      using: {
        method: { text: "gin" },
      },
      columns: {
        expr: {
          items: [
            {
              type: "index_specification",
              expr: { type: "identifier", text: "content" },
            },
          ],
        },
      },
    };

    const result = parseCreateIndex(node);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("gin");
  });

  test("should parse partial index with WHERE clause", () => {
    const node = {
      name: { text: "idx_partial" },
      table: { text: "users" },
      columns: {
        expr: {
          items: [
            {
              type: "index_specification",
              expr: { type: "identifier", text: "email" },
            },
          ],
        },
      },
      clauses: [
        {
          type: "where_clause",
          expr: {
            type: "binary_expr",
            left: { type: "identifier", name: "active" },
            operator: "=",
            right: { type: "boolean_literal", value: true },
          },
        },
      ],
    };

    const result = parseCreateIndex(node);
    expect(result).not.toBeNull();
    expect(result!.where).toBe("active = true");
  });

  test("should parse expression index", () => {
    const node = {
      name: { text: "idx_lower_email" },
      table: { text: "users" },
      columns: {
        expr: {
          items: [
            {
              type: "index_specification",
              expr: {
                type: "function_call",
                name: { text: "LOWER" },
                args: {
                  expr: {
                    items: [{ type: "identifier", name: "email" }],
                  },
                },
              },
            },
          ],
        },
      },
    };

    const result = parseCreateIndex(node);
    expect(result).not.toBeNull();
    expect(result!.columns).toEqual([]);
    expect(result!.expression).toBe("LOWER(email)");
  });

  test("should parse multi-column index", () => {
    const node = {
      name: { text: "idx_multi" },
      table: { text: "users" },
      columns: {
        expr: {
          items: [
            {
              type: "index_specification",
              expr: { type: "identifier", text: "last_name" },
            },
            {
              type: "index_specification",
              expr: { type: "identifier", text: "first_name" },
            },
          ],
        },
      },
    };

    const result = parseCreateIndex(node);
    expect(result).not.toBeNull();
    expect(result!.columns).toEqual(["last_name", "first_name"]);
  });

  test("should parse index with storage parameters", () => {
    const node = {
      name: { text: "idx_with_params" },
      table: { text: "users" },
      columns: {
        expr: {
          items: [
            {
              type: "index_specification",
              expr: { type: "identifier", text: "email" },
            },
          ],
        },
      },
      clauses: [
        {
          type: "postgresql_with_options",
          options: {
            expr: {
              items: [
                {
                  type: "table_option",
                  name: { text: "fillfactor" },
                  value: { text: "70" },
                },
              ],
            },
          },
        },
      ],
    };

    const result = parseCreateIndex(node);
    expect(result).not.toBeNull();
    expect(result!.storageParameters).toEqual({ fillfactor: "70" });
  });

  test("should return null if no index name", () => {
    const node = {
      table: { text: "users" },
      columns: {
        expr: {
          items: [
            {
              type: "index_specification",
              expr: { type: "identifier", text: "email" },
            },
          ],
        },
      },
    };

    const result = parseCreateIndex(node);
    expect(result).toBeNull();
  });

  test("should return null if no table name", () => {
    const node = {
      name: { text: "idx_test" },
      columns: {
        expr: {
          items: [
            {
              type: "index_specification",
              expr: { type: "identifier", text: "email" },
            },
          ],
        },
      },
    };

    const result = parseCreateIndex(node);
    expect(result).toBeNull();
  });

  test("should return null if no columns or expression", () => {
    const node = {
      name: { text: "idx_empty" },
      table: { text: "users" },
      columns: {
        expr: {
          items: [],
        },
      },
    };

    const result = parseCreateIndex(node);
    expect(result).toBeNull();
  });
});
