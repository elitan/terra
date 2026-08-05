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
      "ALTER DEFAULT PRIVILEGES FOR ROLE owner GRANT SELECT ON TABLES TO reader",
      "ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active'",
      "ALTER TABLE users ALTER COLUMN email SET NOT NULL",
      "ALTER TABLE users ALTER COLUMN payload SET STORAGE EXTERNAL",
      "ALTER TABLE users ALTER COLUMN payload SET COMPRESSION pglz",
      "ALTER INDEX users_email_idx ALTER COLUMN 1 SET STATISTICS 500",
      "ALTER TABLE users ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE users FORCE ROW LEVEL SECURITY",
      "ALTER TABLE users SET LOGGED",
      "ALTER SEQUENCE user_id_seq SET LOGGED",
      "ALTER TABLE users ENABLE TRIGGER audit_users",
      "ALTER TABLE users ENABLE ALWAYS TRIGGER audit_users",
      "ALTER EVENT TRIGGER audit_ddl ENABLE",
      "ALTER EVENT TRIGGER audit_ddl ENABLE ALWAYS",
      "ALTER TABLE users REPLICA IDENTITY DEFAULT",
      "ALTER TABLE users REPLICA IDENTITY FULL",
      "ALTER TABLE users REPLICA IDENTITY USING INDEX users_replica_key",
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
      'ALTER TABLE users ALTER COLUMN "odd column" TYPE BIGINT',
      "ALTER TABLE users ALTER COLUMN status DROP DEFAULT",
      'ALTER TABLE users ALTER COLUMN "odd default" DROP DEFAULT',
      "ALTER TABLE users ALTER COLUMN email DROP NOT NULL",
      "ALTER TABLE users ALTER COLUMN id DROP IDENTITY",
      "ALTER TABLE users ALTER COLUMN total DROP EXPRESSION",
      "ALTER TABLE users DISABLE ROW LEVEL SECURITY",
      "ALTER TABLE users NO FORCE ROW LEVEL SECURITY",
      "ALTER TABLE users SET UNLOGGED",
      "ALTER SEQUENCE user_id_seq SET UNLOGGED",
      "ALTER TABLE users DISABLE TRIGGER audit_users",
      "ALTER TABLE users ENABLE REPLICA TRIGGER audit_users",
      "ALTER EVENT TRIGGER audit_ddl DISABLE",
      "ALTER EVENT TRIGGER audit_ddl ENABLE REPLICA",
      'ALTER TABLE ONLY "Odd Table" REPLICA IDENTITY NOTHING',
      "REVOKE SELECT ON TABLE users FROM reader RESTRICT",
      "ALTER DEFAULT PRIVILEGES FOR ROLE owner REVOKE SELECT ON TABLES FROM reader RESTRICT",
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

  test("classifies unique index creation across supported dialect forms", function () {
    const statements = [
      "CREATE UNIQUE INDEX users_email_idx ON users (email);",
      "CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);",
      "CREATE UNIQUE INDEX CONCURRENTLY users_email_idx ON users (email);",
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_email_idx ON users (email);",
    ];

    for (const statement of statements) {
      expect(getStatementCategory(statement)).toBe("index");
    }
  });

  test("distinguishes table constraint actions from other table statements", function () {
    const constraintActions = [
      "ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);",
      "ALTER TABLE users ALTER CONSTRAINT users_team_fkey DEFERRABLE;",
      "ALTER TABLE users VALIDATE CONSTRAINT users_team_fkey;",
      "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_team_fkey RESTRICT;",
      "ALTER TABLE users RENAME CONSTRAINT users_email_key TO users_login_key;",
    ];

    for (const statement of constraintActions) {
      expect(getStatementCategory(statement)).toBe("constraint");
    }
    expect(
      getStatementCategory(
        "CREATE TABLE users (email text CONSTRAINT users_email_key UNIQUE);"
      )
    ).toBe("table");
    expect(
      getStatementCategory(
        "ALTER TABLE users ADD COLUMN email text CONSTRAINT email_required NOT NULL;"
      )
    ).toBe("table");
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
