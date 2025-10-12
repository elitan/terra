import { describe, test, expect } from "bun:test";
import {
  findNodeByType,
  findNodesByType,
  extractTableNameFromCST,
  extractStringValueFromCST,
} from "../../core/schema/parser/cst-utils";

describe("CST Utils", () => {
  describe("findNodeByType", () => {
    test("should find node by type", () => {
      const tree = {
        type: "root",
        children: [
          { type: "table", name: "users" },
          {
            type: "column",
            children: [{ type: "constraint", name: "pk" }],
          },
        ],
      };

      const result = findNodeByType(tree, "constraint");
      expect(result).toEqual({ type: "constraint", name: "pk" });
    });

    test("should return null if not found", () => {
      const tree = { type: "root", children: [] };
      const result = findNodeByType(tree, "missing");
      expect(result).toBeNull();
    });
  });

  describe("findNodesByType", () => {
    test("should find all nodes of type", () => {
      const tree = {
        type: "root",
        children: [
          { type: "table", name: "users" },
          { type: "table", name: "posts" },
          { type: "index", name: "idx" },
        ],
      };

      const results = findNodesByType(tree, "table");
      expect(results).toHaveLength(2);
      expect(results[0]!.name).toBe("users");
      expect(results[1]!.name).toBe("posts");
    });

    test("should return empty array if none found", () => {
      const tree = { type: "root", children: [] };
      const results = findNodesByType(tree, "missing");
      expect(results).toEqual([]);
    });
  });

  describe("extractTableNameFromCST", () => {
    test("should extract table name from node.name.text", () => {
      const node = { name: { text: "users" } };
      expect(extractTableNameFromCST(node)).toBe("users");
    });

    test("should extract table name from node.name.name", () => {
      const node = { name: { name: "posts" } };
      expect(extractTableNameFromCST(node)).toBe("posts");
    });

    test("should return null if no name found", () => {
      const node = { foo: "bar" };
      expect(extractTableNameFromCST(node)).toBeNull();
    });
  });

  describe("extractStringValueFromCST", () => {
    test("should extract string value from string_literal", () => {
      const node = { type: "string_literal", text: "'hello'" };
      expect(extractStringValueFromCST(node)).toBe("hello");
    });

    test("should handle string without quotes", () => {
      const node = { type: "string_literal", value: "world" };
      expect(extractStringValueFromCST(node)).toBe("world");
    });

    test("should extract from direct text property", () => {
      const node = { text: "'test'" };
      expect(extractStringValueFromCST(node)).toBe("test");
    });

    test("should return null if no value found", () => {
      const node = { type: "unknown" };
      expect(extractStringValueFromCST(node)).toBeNull();
    });
  });
});
