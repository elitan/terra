import { describe, test, expect } from "bun:test";
import { parseCreateTable } from "../../core/schema/parser/tables/table-parser";

describe("Table Parser", () => {
  test("should parse basic table with columns", () => {
    const node = {
      name: { text: "users" },
      columns: {
        expr: {
          items: [
            {
              type: "column_definition",
              name: { text: "id" },
              dataType: { name: { text: "INTEGER" } },
              constraints: [],
            },
            {
              type: "column_definition",
              name: { text: "email" },
              dataType: {
                name: { text: "VARCHAR" },
                params: { expr: { items: [{ text: "255" }] } },
              },
              constraints: [],
            },
          ],
        },
      },
    };

    const result = parseCreateTable(node);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("users");
    expect(result!.columns).toHaveLength(2);
    expect(result!.columns[0]!.name).toBe("id");
    expect(result!.columns[0]!.type).toBe("INTEGER");
    expect(result!.columns[1]!.name).toBe("email");
    expect(result!.columns[1]!.type).toBe("VARCHAR(255)");
  });

  test("should parse table with column-level PRIMARY KEY", () => {
    const node = {
      name: { text: "users" },
      columns: {
        expr: {
          items: [
            {
              type: "column_definition",
              name: { text: "id" },
              dataType: { name: { text: "INTEGER" } },
              constraints: [{ type: "constraint_primary_key" }],
            },
          ],
        },
      },
    };

    const result = parseCreateTable(node);
    expect(result).not.toBeNull();
    expect(result!.primaryKey).toBeDefined();
    expect(result!.primaryKey!.columns).toEqual(["id"]);
  });

  test("should parse table with table-level PRIMARY KEY", () => {
    const node = {
      name: { text: "users" },
      columns: {
        expr: {
          items: [
            {
              type: "column_definition",
              name: { text: "id" },
              dataType: { name: { text: "INTEGER" } },
              constraints: [],
            },
            {
              type: "constraint_primary_key",
              columns: {
                expr: {
                  items: [
                    {
                      type: "index_specification",
                      expr: { text: "id" },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    };

    const result = parseCreateTable(node);
    expect(result).not.toBeNull();
    expect(result!.primaryKey).toBeDefined();
    expect(result!.primaryKey!.columns).toEqual(["id"]);
  });

  test("should parse table with FOREIGN KEY", () => {
    const node = {
      name: { text: "posts" },
      columns: {
        expr: {
          items: [
            {
              type: "column_definition",
              name: { text: "id" },
              dataType: { name: { text: "INTEGER" } },
              constraints: [],
            },
            {
              type: "column_definition",
              name: { text: "user_id" },
              dataType: { name: { text: "INTEGER" } },
              constraints: [],
            },
            {
              type: "constraint_foreign_key",
              columns: {
                expr: {
                  items: [
                    {
                      type: "index_specification",
                      expr: { text: "user_id" },
                    },
                  ],
                },
              },
              references: {
                table: { text: "users" },
                columns: {
                  expr: {
                    items: [
                      {
                        type: "index_specification",
                        expr: { text: "id" },
                      },
                    ],
                  },
                },
                options: [],
              },
            },
          ],
        },
      },
    };

    const result = parseCreateTable(node);
    expect(result).not.toBeNull();
    expect(result!.foreignKeys).toBeDefined();
    expect(result!.foreignKeys).toHaveLength(1);
    expect(result!.foreignKeys![0]!.columns).toEqual(["user_id"]);
    expect(result!.foreignKeys![0]!.referencedTable).toBe("users");
    expect(result!.foreignKeys![0]!.referencedColumns).toEqual(["id"]);
  });

  test("should parse table with CHECK constraint", () => {
    const node = {
      name: { text: "products" },
      columns: {
        expr: {
          items: [
            {
              type: "column_definition",
              name: { text: "price" },
              dataType: { name: { text: "NUMERIC" } },
              constraints: [],
            },
            {
              type: "constraint_check",
              expr: {
                type: "binary_expr",
                left: { type: "identifier", name: "price" },
                operator: ">",
                right: { type: "number_literal", value: 0 },
              },
            },
          ],
        },
      },
    };

    const result = parseCreateTable(node);
    expect(result).not.toBeNull();
    expect(result!.checkConstraints).toBeDefined();
    expect(result!.checkConstraints).toHaveLength(1);
    expect(result!.checkConstraints![0]!.expression).toBe("price > 0");
  });

  test("should parse table with UNIQUE constraint", () => {
    const node = {
      name: { text: "users" },
      columns: {
        expr: {
          items: [
            {
              type: "column_definition",
              name: { text: "email" },
              dataType: { name: { text: "VARCHAR" } },
              constraints: [],
            },
            {
              type: "constraint_unique",
              columns: {
                expr: {
                  items: [
                    {
                      type: "index_specification",
                      expr: { text: "email" },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    };

    const result = parseCreateTable(node);
    expect(result).not.toBeNull();
    expect(result!.uniqueConstraints).toBeDefined();
    expect(result!.uniqueConstraints).toHaveLength(1);
    expect(result!.uniqueConstraints![0]!.columns).toEqual(["email"]);
  });

  test("should parse column with NOT NULL", () => {
    const node = {
      name: { text: "users" },
      columns: {
        expr: {
          items: [
            {
              type: "column_definition",
              name: { text: "email" },
              dataType: { name: { text: "VARCHAR" } },
              constraints: [{ type: "constraint_not_null" }],
            },
          ],
        },
      },
    };

    const result = parseCreateTable(node);
    expect(result).not.toBeNull();
    expect(result!.columns[0]!.nullable).toBe(false);
  });

  test("should parse column with DEFAULT", () => {
    const node = {
      name: { text: "users" },
      columns: {
        expr: {
          items: [
            {
              type: "column_definition",
              name: { text: "active" },
              dataType: { name: { text: "BOOLEAN" } },
              constraints: [
                {
                  type: "constraint_default",
                  expr: { type: "boolean_literal", value: true },
                },
              ],
            },
          ],
        },
      },
    };

    const result = parseCreateTable(node);
    expect(result).not.toBeNull();
    expect(result!.columns[0]!.default).toBe("true");
  });

  test("should return null if no table name", () => {
    const node = {
      columns: {
        expr: {
          items: [
            {
              type: "column_definition",
              name: { text: "id" },
              dataType: { name: { text: "INTEGER" } },
              constraints: [],
            },
          ],
        },
      },
    };

    const result = parseCreateTable(node);
    expect(result).toBeNull();
  });
});
