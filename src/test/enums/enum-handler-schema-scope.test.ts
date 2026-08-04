import { describe, expect, test } from "bun:test";
import { EnumHandler } from "../../core/schema/handlers/enum-handler";
import type { EnumType } from "../../types/schema";

function makeEnum(overrides: Partial<EnumType> = {}): EnumType {
  return {
    name: "status",
    schema: "public",
    values: ["active", "inactive"],
    ...overrides,
  };
}

describe("Enum handler schema scope", () => {
  test("keeps same enum name isolated by schema when unchanged", () => {
    const handler = new EnumHandler();
    const desired = [
      makeEnum({ schema: "public", values: ["active", "inactive"] }),
      makeEnum({ schema: "tenant_a", values: ["pending", "done"] }),
    ];
    const current = [
      makeEnum({ schema: "public", values: ["active", "inactive"] }),
      makeEnum({ schema: "tenant_a", values: ["pending", "done"] }),
    ];

    const statements = handler.generateStatements(desired, current);
    expect(statements.transactional).toEqual([]);
    expect(statements.preTransactional).toEqual([]);
  });

  test("updates only the matching schema enum when values append", () => {
    const handler = new EnumHandler();
    const desired = [
      makeEnum({ schema: "public", values: ["active", "inactive", "pending"] }),
      makeEnum({ schema: "tenant_a", values: ["active", "inactive"] }),
    ];
    const current = [
      makeEnum({ schema: "public", values: ["active", "inactive"] }),
      makeEnum({ schema: "tenant_a", values: ["active", "inactive"] }),
    ];

    const statements = handler.generateStatements(desired, current);
    expect(statements.transactional).toEqual([]);
    expect(statements.preTransactional).toHaveLength(1);
    expect(statements.preTransactional[0]).toContain('ALTER TYPE "public"."status"');
    expect(statements.preTransactional[0]).toContain("ADD VALUE 'pending'");
  });

  test("drops only removed schema enum", () => {
    const handler = new EnumHandler();
    const desired = [makeEnum({ schema: "tenant_a" })];
    const current = [
      makeEnum({ schema: "public" }),
      makeEnum({ schema: "tenant_a" }),
    ];

    const statements = handler.generateRemovalStatements(desired, current);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('DROP TYPE "public"."status"');
  });

  test("appends mixed-case enum value without normalization drift", () => {
    const handler = new EnumHandler();
    const desired = [
      makeEnum({ schema: "public", values: ["active", "inactive", "PendingReview"] }),
    ];
    const current = [
      makeEnum({ schema: "public", values: ["active", "inactive"] }),
    ];

    const statements = handler.generateStatements(desired, current);
    expect(statements.transactional).toEqual([]);
    expect(statements.preTransactional).toHaveLength(1);
    expect(statements.preTransactional[0]).toContain("ADD VALUE 'PendingReview'");
  });

  test("adds multiple values in exact desired order with escaped literals", () => {
    const handler = new EnumHandler();
    const desired = [
      makeEnum({
        values: ["first", "can't wait", "middle", "C:\\temp", "last"],
      }),
    ];
    const current = [makeEnum({ values: ["first", "last"] })];

    const statements = handler.generateStatements(desired, current);

    expect(statements.transactional).toEqual([]);
    expect(statements.preTransactional).toEqual([
      `ALTER TYPE "public"."status" ADD VALUE 'can''t wait' BEFORE 'last';`,
      `ALTER TYPE "public"."status" ADD VALUE 'middle' BEFORE 'last';`,
      `ALTER TYPE "public"."status" ADD VALUE E'C:\\\\temp' BEFORE 'last';`,
    ]);
  });

  test("rejects reordering retained values even when adding new values", () => {
    const handler = new EnumHandler();
    const desired = [makeEnum({ values: ["inactive", "pending", "active"] })];
    const current = [makeEnum({ values: ["active", "inactive"] })];

    expect(function generateReorderedEnumStatements() {
      handler.generateStatements(desired, current);
    }).toThrow(/reordering values/);
  });

  test("fails fast on duplicate desired enum values", () => {
    const handler = new EnumHandler();
    const desired = [
      makeEnum({ schema: "public", values: ["active", "active", "inactive"] }),
    ];
    const current = [
      makeEnum({ schema: "public", values: ["active", "inactive"] }),
    ];

    expect(function () {
      handler.generateStatements(desired, current);
    }).toThrow(/duplicate values/);
  });
});
