import { describe, test, expect } from "bun:test";
import { parseCreateType } from "../../core/schema/parser/enum-parser";

describe("Enum Parser", () => {
  test("should parse valid ENUM type", () => {
    const node = {
      name: { text: "status_type" },
      definition: {
        type: "enum_type_definition",
        values: {
          expr: {
            items: [
              { type: "string_literal", text: "'pending'" },
              { type: "string_literal", text: "'active'" },
              { type: "string_literal", text: "'inactive'" },
            ],
          },
        },
      },
    };

    const result = parseCreateType(node);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("status_type");
    expect(result!.values).toEqual(["pending", "active", "inactive"]);
  });

  test("should handle ENUM values without quotes in text", () => {
    const node = {
      name: { text: "role_type" },
      definition: {
        type: "enum_type_definition",
        values: {
          expr: {
            items: [
              { type: "string_literal", value: "admin" },
              { type: "string_literal", value: "user" },
            ],
          },
        },
      },
    };

    const result = parseCreateType(node);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("role_type");
    expect(result!.values).toEqual(["admin", "user"]);
  });

  test("should throw error for empty ENUM", () => {
    const node = {
      name: { text: "empty_enum" },
      definition: {
        type: "enum_type_definition",
        values: {
          expr: {
            items: [],
          },
        },
      },
    };

    expect(() => parseCreateType(node)).toThrow("Invalid ENUM type");
  });

  test("should return null for non-ENUM types", () => {
    const node = {
      name: { text: "custom_type" },
      definition: {
        type: "composite_type_definition", // Not an ENUM
      },
    };

    const result = parseCreateType(node);
    expect(result).toBeNull();
  });

  test("should return null if no type name", () => {
    const node = {
      definition: {
        type: "enum_type_definition",
        values: {
          expr: {
            items: [{ type: "string_literal", text: "'value'" }],
          },
        },
      },
    };

    const result = parseCreateType(node);
    expect(result).toBeNull();
  });

  test("should handle name from node.name.name", () => {
    const node = {
      name: { name: "priority_type" },
      definition: {
        type: "enum_type_definition",
        values: {
          expr: {
            items: [
              { type: "string_literal", text: "'high'" },
              { type: "string_literal", text: "'low'" },
            ],
          },
        },
      },
    };

    const result = parseCreateType(node);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("priority_type");
    expect(result!.values).toEqual(["high", "low"]);
  });
});
