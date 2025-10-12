import { describe, test, expect } from "bun:test";
import { normalizeDefault, columnsAreDifferent } from "../../utils/sql";
import type { Column } from "../../types/schema";

describe("normalizeDefault", () => {
  test("should return undefined for null input", () => {
    expect(normalizeDefault(null)).toBeUndefined();
  });

  test("should return undefined for undefined input", () => {
    expect(normalizeDefault(undefined)).toBeUndefined();
  });

  test("should strip ::integer type cast", () => {
    expect(normalizeDefault("100::integer")).toBe("100");
  });

  test("should strip ::character varying type cast", () => {
    expect(normalizeDefault("'John'::character varying")).toBe("'John'");
  });

  test("should strip ::boolean type cast", () => {
    expect(normalizeDefault("true::boolean")).toBe("true");
  });

  test("should strip ::text type cast", () => {
    expect(normalizeDefault("'hello'::text")).toBe("'hello'");
  });

  test("should strip ::numeric type cast with params", () => {
    expect(normalizeDefault("0.00::numeric(10,2)")).toBe("0.00");
  });

  test("should strip ::timestamp type cast", () => {
    expect(normalizeDefault("'2024-01-01'::timestamp")).toBe("'2024-01-01'");
  });

  test("should handle values without type casts", () => {
    expect(normalizeDefault("CURRENT_TIMESTAMP")).toBe("CURRENT_TIMESTAMP");
    expect(normalizeDefault("100")).toBe("100");
    expect(normalizeDefault("'hello'")).toBe("'hello'");
  });

  test("should strip ::timestamp without time zone", () => {
    expect(normalizeDefault("CURRENT_TIMESTAMP::timestamp without time zone")).toBe("CURRENT_TIMESTAMP");
  });

  test("should handle nextval function calls", () => {
    expect(normalizeDefault("nextval('users_id_seq'::regclass)")).toBe("nextval('users_id_seq'::regclass)");
  });

  test("should trim whitespace", () => {
    expect(normalizeDefault("  100::integer  ")).toBe("100");
  });
});

describe("columnsAreDifferent - default value comparison", () => {
  test("should detect no difference when defaults match after normalization", () => {
    const desired: Column = {
      name: "name",
      type: "VARCHAR(255)",
      nullable: true,
      default: "'John'",
    };

    const current: Column = {
      name: "name",
      type: "character varying(255)",
      nullable: true,
      default: "'John'::character varying",
    };

    expect(columnsAreDifferent(desired, current)).toBe(false);
  });

  test("should detect no difference for integer defaults", () => {
    const desired: Column = {
      name: "age",
      type: "INTEGER",
      nullable: true,
      default: "0",
    };

    const current: Column = {
      name: "age",
      type: "integer",
      nullable: true,
      default: "0::integer",
    };

    expect(columnsAreDifferent(desired, current)).toBe(false);
  });

  test("should detect no difference for boolean defaults", () => {
    const desired: Column = {
      name: "active",
      type: "BOOLEAN",
      nullable: true,
      default: "true",
    };

    const current: Column = {
      name: "active",
      type: "boolean",
      nullable: true,
      default: "true::boolean",
    };

    expect(columnsAreDifferent(desired, current)).toBe(false);
  });

  test("should detect no difference when both defaults are null/undefined", () => {
    const desired: Column = {
      name: "col",
      type: "INTEGER",
      nullable: true,
      default: undefined,
    };

    const current: Column = {
      name: "col",
      type: "integer",
      nullable: true,
      default: null,
    };

    expect(columnsAreDifferent(desired, current)).toBe(false);
  });

  test("should detect difference when defaults actually differ", () => {
    const desired: Column = {
      name: "status",
      type: "VARCHAR(50)",
      nullable: true,
      default: "'active'",
    };

    const current: Column = {
      name: "status",
      type: "character varying(50)",
      nullable: true,
      default: "'pending'::character varying",
    };

    expect(columnsAreDifferent(desired, current)).toBe(true);
  });

  test("should detect difference when one has default and other doesn't", () => {
    const desired: Column = {
      name: "count",
      type: "INTEGER",
      nullable: true,
      default: "0",
    };

    const current: Column = {
      name: "count",
      type: "integer",
      nullable: true,
      default: undefined,
    };

    expect(columnsAreDifferent(desired, current)).toBe(true);
  });

  test("should handle CURRENT_TIMESTAMP defaults", () => {
    const desired: Column = {
      name: "created_at",
      type: "TIMESTAMP",
      nullable: true,
      default: "CURRENT_TIMESTAMP",
    };

    const current: Column = {
      name: "created_at",
      type: "timestamp without time zone",
      nullable: true,
      default: "CURRENT_TIMESTAMP",
    };

    expect(columnsAreDifferent(desired, current)).toBe(false);
  });
});
