import { describe, expect, test } from "bun:test";
import { SequenceHandler } from "../../core/schema/handlers/sequence-handler";
import type { Sequence } from "../../types/schema";

function makeSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    name: "invoice_seq",
    schema: "public",
    increment: 1,
    minValue: 1,
    maxValue: 1000,
    start: 1,
    cache: 10,
    cycle: false,
    ...overrides,
  };
}

describe("sequence handler schema scope", function () {
  test("drops only removed schema sequence when names match", function () {
    const handler = new SequenceHandler();

    const statements = handler.generateStatements(
      [makeSequence({ schema: "public" })],
      [makeSequence({ schema: "public" }), makeSequence({ schema: "tenant_a" })]
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('DROP SEQUENCE IF EXISTS "tenant_a"."invoice_seq"');
    expect(statements[0]).not.toContain('"public"."invoice_seq"');
  });

  test("keeps same-name cross-schema sequences isolated in no-op plan", function () {
    const handler = new SequenceHandler();

    const statements = handler.generateStatements(
      [
        makeSequence({ schema: "public", increment: 1 }),
        makeSequence({ schema: "tenant_a", increment: 7 }),
      ],
      [
        makeSequence({ schema: "tenant_a", increment: 7 }),
        makeSequence({ schema: "public", increment: 1 }),
      ]
    );

    expect(statements).toEqual([]);
  });
});
