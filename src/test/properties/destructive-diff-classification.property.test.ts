import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { configurePropertyTests } from "./property-test-options";
import {
  getStatementCategory,
  getStatementRisk,
  isDestructiveStatement,
  type StatementChannel,
} from "../../utils/statement-classifier";

configurePropertyTests();

type Decoration = {
  leading: string;
  trailing: string;
  mode: "original" | "upper" | "lower" | "mixed";
  bitPattern: boolean[];
};

function applyCaseMode(input: string, mode: Decoration["mode"], bitPattern: boolean[]): string {
  if (mode === "upper") return input.toUpperCase();
  if (mode === "lower") return input.toLowerCase();
  if (mode === "original") return input;

  let index = 0;
  return input
    .split("")
    .map(function (char) {
      if (!/[a-zA-Z]/.test(char)) {
        return char;
      }
      const makeUpper = bitPattern[index % bitPattern.length] ?? false;
      index += 1;
      return makeUpper ? char.toUpperCase() : char.toLowerCase();
    })
    .join("");
}

function decorateStatement(statement: string, decoration: Decoration): string {
  const body = applyCaseMode(statement, decoration.mode, decoration.bitPattern);
  return `${decoration.leading}${body}${decoration.trailing}`;
}

function buildDecorationArbitrary() {
  return fc.record({
    leading: fc.constantFrom("", " ", "\n", "\n  "),
    trailing: fc.constantFrom("", " ", "\n", ";\n"),
    mode: fc.constantFrom("original", "upper", "lower", "mixed"),
    bitPattern: fc.array(fc.boolean(), { minLength: 1, maxLength: 64 }),
  });
}

describe("Property-Based: Destructive Diff Classification", function () {
  test("property: known-safe statements are never destructive", async function () {
    const safeStatements = [
      "CREATE TABLE users (id INT)",
      "ALTER TABLE users ADD COLUMN age INT",
      "CREATE INDEX idx_users_age ON users(age)",
      "CREATE VIEW users_v AS SELECT id FROM users",
      "COMMENT ON TABLE users IS 'test'",
      "CREATE TYPE mood AS ENUM ('sad', 'ok')",
      "ALTER TYPE mood ADD VALUE 'happy'",
    ];

    await fc.assert(
      fc.property(
        fc.constantFrom(...safeStatements),
        buildDecorationArbitrary(),
        function (statement, decoration) {
          const candidate = decorateStatement(statement, decoration as Decoration);
          expect(isDestructiveStatement(candidate)).toBe(false);
        }
      ),
      { numRuns: 200, verbose: false }
    );
  });

  test("property: known-destructive statements are always destructive", async function () {
    const destructiveStatements = [
      "DROP TABLE users",
      "DROP TYPE mood",
      "ALTER TABLE users DROP COLUMN age",
      "ALTER TABLE users DROP CONSTRAINT users_pkey",
      "ALTER TABLE users ALTER COLUMN age TYPE BIGINT",
      "ALTER TABLE users ALTER COLUMN age SET DATA TYPE BIGINT",
    ];

    await fc.assert(
      fc.property(
        fc.constantFrom(...destructiveStatements),
        buildDecorationArbitrary(),
        function (statement, decoration) {
          const candidate = decorateStatement(statement, decoration as Decoration);
          expect(isDestructiveStatement(candidate)).toBe(true);
        }
      ),
      { numRuns: 200, verbose: false }
    );
  });

  test("property: concurrent channel is always concurrent risk", async function () {
    const anyStatement = fc.string({ minLength: 1, maxLength: 120 });
    const anyChannel = fc.constantFrom("transactional", "deferred", "concurrent");

    await fc.assert(
      fc.property(
        anyStatement,
        anyChannel,
        function (statement, channel) {
          const typedChannel = channel as StatementChannel;
          const risk = getStatementRisk(statement, typedChannel);
          if (typedChannel === "concurrent") {
            expect(risk).toBe("concurrent");
          }
        }
      ),
      { numRuns: 150, verbose: false }
    );
  });

  test("classifies native domain alterations as type statements", function () {
    expect(getStatementCategory("ALTER DOMAIN public.score SET DEFAULT 1;")).toBe(
      "type"
    );
    expect(getStatementCategory("ALTER DOMAIN public.score SET NOT NULL;")).toBe(
      "type"
    );
    expect(
      getStatementCategory(
        "ALTER DOMAIN public.score VALIDATE CONSTRAINT positive;"
      )
    ).toBe("constraint");
  });

  test("property: failing destructive assertion shrinks to a small reproducible case", function () {
    const result = fc.check(
      fc.property(
        fc.constantFrom("DROP TABLE users", "ALTER TABLE users DROP COLUMN age"),
        buildDecorationArbitrary(),
        function (statement, decoration) {
          const candidate = decorateStatement(statement, decoration as Decoration);
          return !isDestructiveStatement(candidate);
        }
      ),
      { seed: 20260222, numRuns: 100, verbose: false }
    );

    expect(result.failed).toBe(true);
    expect(result.counterexample).toBeDefined();

    const counterexample = result.counterexample as [string, Decoration];
    const candidate = decorateStatement(counterexample[0], counterexample[1]);

    expect(candidate.trim().length).toBeLessThanOrEqual("DROP TABLE users".length);
    expect(counterexample[1].bitPattern.length).toBeLessThanOrEqual(2);
  });
});
