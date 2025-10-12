import { describe, test, expect } from "bun:test";
import { serializeExpression, serializeDefaultValue } from "../../core/schema/parser/expressions";

describe("Expression Serializer", () => {
  describe("Literals", () => {
    test("should serialize number literal", () => {
      const expr = { type: "number_literal", value: 42 };
      expect(serializeExpression(expr)).toBe("42");
    });

    test("should serialize string literal", () => {
      const expr = { type: "string_literal", text: "'hello'" };
      expect(serializeExpression(expr)).toBe("'hello'");
    });

    test("should serialize boolean literal", () => {
      const expr = { type: "boolean_literal", value: true };
      expect(serializeExpression(expr)).toBe("true");
    });

    test("should serialize NULL literal", () => {
      const expr = { type: "null_literal" };
      expect(serializeExpression(expr)).toBe("NULL");
    });

    test("should serialize keyword", () => {
      const expr = { type: "keyword", text: "CURRENT_TIMESTAMP" };
      expect(serializeExpression(expr)).toBe("CURRENT_TIMESTAMP");
    });
  });

  describe("Operators", () => {
    test("should serialize binary expression", () => {
      const expr = {
        type: "binary_expr",
        left: { type: "identifier", name: "age" },
        operator: ">",
        right: { type: "number_literal", value: 18 },
      };
      expect(serializeExpression(expr)).toBe("age > 18");
    });

    test("should serialize unary expression", () => {
      const expr = {
        type: "unary_op_expr",
        operator: { text: "NOT" },
        expr: { type: "identifier", name: "active" },
      };
      expect(serializeExpression(expr)).toBe("NOT active");
    });

    test("should serialize cast expression", () => {
      const expr = {
        type: "cast_expr",
        left: { type: "string_literal", text: "'123'" },
        right: { type: "named_data_type", name: { text: "INTEGER" } },
      };
      expect(serializeExpression(expr)).toBe("'123'::INTEGER");
    });

    test("should serialize IS NULL expression", () => {
      const expr = {
        type: "is_expr",
        expr: { type: "identifier", name: "email" },
        not: false,
        test: { text: "NULL" },
      };
      expect(serializeExpression(expr)).toBe("email IS NULL");
    });

    test("should serialize IS NOT NULL expression", () => {
      const expr = {
        type: "is_expr",
        expr: { type: "identifier", name: "email" },
        not: true,
        test: { text: "NULL" },
      };
      expect(serializeExpression(expr)).toBe("email IS NOT NULL");
    });
  });

  describe("Functions", () => {
    test("should serialize function call with no args", () => {
      const expr = {
        type: "function_call",
        name: { text: "NOW" },
        args: { expr: { items: [] } },
      };
      expect(serializeExpression(expr)).toBe("NOW()");
    });

    test("should serialize function call with args", () => {
      const expr = {
        type: "function_call",
        name: { text: "LOWER" },
        args: {
          expr: {
            items: [{ type: "identifier", name: "email" }],
          },
        },
      };
      expect(serializeExpression(expr)).toBe("LOWER(email)");
    });

    test("should serialize PostgreSQL keyword functions without parens", () => {
      const expr = {
        type: "function_call",
        name: { text: "CURRENT_DATE" },
      };
      expect(serializeExpression(expr)).toBe("CURRENT_DATE");
    });
  });

  describe("Column References", () => {
    test("should serialize identifier", () => {
      const expr = { type: "identifier", name: "user_id" };
      expect(serializeExpression(expr)).toBe("user_id");
    });

    test("should serialize column_ref", () => {
      const expr = { type: "column_ref", name: "posts.id" };
      expect(serializeExpression(expr)).toBe("posts.id");
    });
  });

  describe("Complex Expressions", () => {
    test("should serialize nested binary expressions", () => {
      const expr = {
        type: "binary_expr",
        left: {
          type: "binary_expr",
          left: { type: "identifier", name: "age" },
          operator: ">",
          right: { type: "number_literal", value: 18 },
        },
        operator: { text: "AND" },
        right: {
          type: "binary_expr",
          left: { type: "identifier", name: "status" },
          operator: "=",
          right: { type: "string_literal", text: "'active'" },
        },
      };
      expect(serializeExpression(expr)).toBe("age > 18 AND status = 'active'");
    });

    test("should serialize parenthesized expressions", () => {
      const expr = {
        type: "paren_expr",
        expr: {
          type: "binary_expr",
          left: { type: "identifier", name: "a" },
          operator: "+",
          right: { type: "identifier", name: "b" },
        },
      };
      expect(serializeExpression(expr)).toBe("(a + b)");
    });
  });

  describe("serializeDefaultValue", () => {
    test("should serialize number default", () => {
      const expr = { type: "number_literal", value: 0 };
      expect(serializeDefaultValue(expr)).toBe("0");
    });

    test("should serialize string default", () => {
      const expr = { type: "string_literal", text: "'default'" };
      expect(serializeDefaultValue(expr)).toBe("'default'");
    });

    test("should serialize function default", () => {
      const expr = {
        type: "function_call",
        name: { text: "NOW" },
      };
      expect(serializeDefaultValue(expr)).toBe("NOW()");
    });

    test("should serialize CURRENT_TIMESTAMP without parens", () => {
      const expr = {
        type: "function_call",
        name: { text: "CURRENT_TIMESTAMP" },
      };
      expect(serializeDefaultValue(expr)).toBe("CURRENT_TIMESTAMP");
    });
  });

  describe("Edge Cases", () => {
    test("should handle string expressions", () => {
      expect(serializeExpression("raw_string")).toBe("raw_string");
    });

    test("should handle expressions with direct text", () => {
      const expr = { text: "some_column" };
      expect(serializeExpression(expr)).toBe("some_column");
    });

    test("should handle unknown expressions", () => {
      const expr = { type: "unknown_type_xyz" };
      expect(serializeExpression(expr)).toBe("unknown_expression");
    });
  });
});
