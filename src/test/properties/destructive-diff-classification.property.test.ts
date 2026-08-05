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
      "REFRESH MATERIALIZED VIEW public.summary",
      'REFRESH MATERIALIZED VIEW "WITH NO DATA" WITH DATA',
      "REFRESH MATERIALIZED VIEW CONCURRENTLY public.summary WITH DATA",
      "COMMENT ON TABLE users IS 'test'",
      `COMMENT ON TABLE "IS NULL" IS 'text containing IS NULL'`,
      'ALTER TABLE "SET WITHOUT CLUSTER" CLUSTER ON "CLUSTER ON"',
      'ALTER MATERIALIZED VIEW public.summary CLUSTER ON summary_order',
      'ALTER VIEW "RESET" SET (check_option = cascaded, security_barrier = true, security_invoker = true)',
      'ALTER VIEW public.items SET (check_option = local)',
      "CREATE TYPE mood AS ENUM ('sad', 'ok')",
      "ALTER TYPE mood ADD VALUE 'happy'",
      "ALTER DEFAULT PRIVILEGES FOR ROLE owner GRANT SELECT ON TABLES TO reader",
      "ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active'",
      "ALTER TABLE users ALTER COLUMN email SET NOT NULL",
      "ALTER DOMAIN public.score SET DEFAULT 1",
      "ALTER DOMAIN public.score SET NOT NULL",
      `ALTER DOMAIN "DROP DEFAULT" SET DEFAULT 'DROP NOT NULL'`,
      "ALTER TABLE users ALTER COLUMN payload SET STORAGE EXTERNAL",
      "ALTER TABLE users ALTER COLUMN payload SET COMPRESSION pglz",
      'ALTER TABLE users ALTER COLUMN "COMPRESSION default" SET COMPRESSION pglz',
      'ALTER TABLE "SET ACCESS METHOD heap" SET (fillfactor=80)',
      'ALTER MATERIALIZED VIEW "SET ACCESS METHOD heap" SET (fillfactor=80)',
      'ALTER TABLE "SET TABLESPACE fast" SET (fillfactor=80)',
      'ALTER MATERIALIZED VIEW "SET TABLESPACE fast" SET (fillfactor=80)',
      'ALTER TABLE "RESET (fillfactor)" SET (fillfactor=80)',
      'ALTER MATERIALIZED VIEW "RESET" SET (fillfactor=80)',
      'ALTER TABLE public.metrics ALTER COLUMN "RESET" SET (n_distinct=1)',
      "ALTER INDEX users_email_idx ALTER COLUMN 1 SET STATISTICS 500",
      'ALTER MATERIALIZED VIEW public.summary ALTER COLUMN payload SET STATISTICS 500',
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
      "ALTER TABLE users INHERIT public.parent_users",
      'ALTER TABLE "Odd Parent" ATTACH PARTITION "Odd Child" FOR VALUES FROM (0) TO (100)',
      'ALTER TABLE "DETACH PARTITION" ATTACH PARTITION "FINALIZE" DEFAULT',
      'CREATE SCHEMA "Odd Schema" AUTHORIZATION "Odd Owner"',
      'ALTER SCHEMA "OWNER TO" RENAME TO "Renamed Schema"',
      `ALTER SERVER "DROP Server" VERSION 'DROP "version"' OPTIONS (SET "host" 'DROP "dbname"', ADD "DROP" 'value')`,
      `ALTER SERVER "OWNER TO" OPTIONS (SET "owner" 'OWNER TO')`,
      `ALTER SERVER "VERSION NULL" VERSION 'NULL'`,
      'ALTER SEQUENCE "OWNED BY NONE" OWNED BY "public"."users"."id"',
      'ALTER SEQUENCE "CYCLE" NO CYCLE',
      'ALTER SEQUENCE "AS SMALLINT" CACHE 2',
      'ALTER TABLE public.events ALTER COLUMN "CYCLE" SET NO CYCLE',
      'ALTER TABLE public.events ALTER COLUMN "BY DEFAULT" SET GENERATED ALWAYS',
      "ALTER ROLE app_user WITH LOGIN SUPERUSER CREATEDB CREATEROLE INHERIT REPLICATION BYPASSRLS CONNECTION LIMIT 5",
      'ALTER ROLE "CONNECTION LIMIT -1" WITH LOGIN CONNECTION LIMIT 4',
      'ALTER ROLE "NOLOGIN Role" WITH LOGIN',
      "ALTER ROLE app_user SET application_name TO 'NOLOGIN'",
      'ALTER ROLE app_user RENAME TO "NOREPLICATION"',
      "ALTER ROLE app_user RESET ALL",
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
      'REFRESH MATERIALIZED VIEW "Odd Schema"."Odd Summary" WITH NO DATA',
      "ALTER TABLE users DROP COLUMN age",
      "ALTER TABLE users DROP CONSTRAINT users_pkey",
      "ALTER TABLE users ALTER COLUMN age TYPE BIGINT",
      "ALTER TABLE users ALTER COLUMN age SET DATA TYPE BIGINT",
      'ALTER TABLE users ALTER COLUMN "odd column" TYPE BIGINT',
      "ALTER TABLE users ALTER COLUMN status DROP DEFAULT",
      'ALTER TABLE users ALTER COLUMN "odd default" DROP DEFAULT',
      "ALTER TABLE users ALTER COLUMN email DROP NOT NULL",
      'ALTER DOMAIN "Odd Schema"."Odd Domain" DROP DEFAULT',
      'ALTER DOMAIN "Odd Schema"."Odd Domain" DROP NOT NULL',
      'ALTER TABLE IF EXISTS ONLY "Odd Schema"."Odd Table" RESET (fillfactor, toast.autovacuum_enabled)',
      'ALTER MATERIALIZED VIEW IF EXISTS "Odd Schema"."Odd Summary" RESET (autovacuum_enabled)',
      'ALTER TABLE ONLY "Odd Schema"."Odd Table" ALTER COLUMN "Odd Column" RESET (n_distinct, n_distinct_inherited)',
      'ALTER MATERIALIZED VIEW "Odd Schema"."Odd Summary" ALTER "Odd Column" RESET (n_distinct)',
      'ALTER TABLE IF EXISTS ONLY "Odd Schema"."Odd Table" ALTER COLUMN "Odd Column" SET COMPRESSION default',
      'ALTER TABLE IF EXISTS ONLY "Odd Schema"."Odd Table" SET ACCESS METHOD "Odd Method"',
      'ALTER MATERIALIZED VIEW IF EXISTS "Odd Schema"."Odd Summary" SET ACCESS METHOD "Odd Method"',
      'ALTER TABLE IF EXISTS ONLY "Odd Schema"."Odd Table" SET TABLESPACE "Odd Space"',
      'ALTER MATERIALIZED VIEW IF EXISTS "Odd Schema"."Odd Summary" SET TABLESPACE "Odd Space"',
      'ALTER TABLE ONLY "Odd Schema"."Odd Table" ALTER COLUMN "Odd Column" SET STATISTICS -1',
      'ALTER MATERIALIZED VIEW "Odd Schema"."Odd Summary" ALTER COLUMN "Odd Column" SET STATISTICS -1',
      'ALTER INDEX IF EXISTS "Odd Schema"."Odd Index" ALTER COLUMN 1 SET STATISTICS -1',
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
      'ALTER TABLE "Odd Child" NO INHERIT "Odd Schema"."Odd Parent"',
      'ALTER TABLE "Odd Schema"."Odd Parent" DETACH PARTITION "Odd Schema"."Odd Child"',
      "ALTER TABLE partition_parent DETACH PARTITION partition_child CONCURRENTLY",
      "ALTER TABLE IF EXISTS partition_parent DETACH PARTITION partition_child FINALIZE",
      'ALTER SCHEMA "Odd Schema" OWNER TO "Odd Owner"',
      `ALTER SERVER "Remote Server" VERSION '15' OPTIONS (DROP "dbname", SET "host" 'db.internal', ADD "fetch_size" '1000')`,
      'ALTER SERVER "Odd Server" OWNER TO "Odd Owner"',
      'ALTER SERVER "Odd Server" VERSION NULL',
      'ALTER SERVER server_name VERSION NULL OPTIONS (DROP option_name)',
      'ALTER SEQUENCE IF EXISTS "Odd Schema"."Odd Sequence" OWNED BY NONE',
      'ALTER SEQUENCE IF EXISTS "Odd Schema"."Odd Sequence" CYCLE',
      'ALTER SEQUENCE IF EXISTS "Odd Schema"."Odd Sequence" AS SMALLINT INCREMENT BY 2 MINVALUE 1 MAXVALUE 1000 CACHE 2',
      'ALTER TABLE IF EXISTS ONLY "Odd Schema"."Odd Table" ALTER COLUMN "Odd Identity" SET CYCLE',
      'ALTER TABLE IF EXISTS ONLY "Odd Schema"."Odd Table" ALTER COLUMN "Odd Identity" SET GENERATED BY DEFAULT',
      'COMMENT ON COLUMN "Odd Schema"."Odd Table"."Odd Column" IS NULL',
      'ALTER TABLE IF EXISTS ONLY "Odd Schema"."Odd Table" SET WITHOUT CLUSTER',
      'ALTER MATERIALIZED VIEW IF EXISTS "Odd Schema"."Odd Summary" SET WITHOUT CLUSTER',
      'ALTER VIEW IF EXISTS "Odd Schema"."Odd View" RESET (check_option, security_barrier, security_invoker)',
      'ALTER VIEW "Odd Schema"."Odd View" SET (check_option = cascaded, security_invoker = true, security_barrier = false)',
      'ALTER ROLE "Odd Role" WITH NOLOGIN',
      'ALTER ROLE "Odd Role" NOSUPERUSER',
      'ALTER ROLE "Odd Role" WITH NOCREATEDB',
      'ALTER ROLE "Odd Role" NOCREATEROLE',
      'ALTER ROLE "Odd Role" WITH NOINHERIT',
      'ALTER ROLE "Odd Role" NOREPLICATION',
      'ALTER ROLE "Odd Role" WITH NOBYPASSRLS',
      'ALTER ROLE "Odd Role" WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      'ALTER ROLE "Odd Role" WITH LOGIN CONNECTION LIMIT -1',
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

  test("classifies supported native operations by their managed object", function () {
    const scenarios = [
      {
        category: "index",
        statements: [
          'ALTER INDEX "Odd Schema"."Odd Index" ALTER COLUMN 1 SET STATISTICS 500;',
        ],
      },
      {
        category: "materialized-view",
        statements: [
          'ALTER MATERIALIZED VIEW "Odd Schema"."Odd Summary" SET TABLESPACE "Odd Space";',
          'REFRESH MATERIALIZED VIEW "Odd Schema"."Odd Summary" WITH DATA;',
        ],
      },
      {
        category: "view",
        statements: [
          'ALTER VIEW "Odd Schema"."Odd View" SET (security_barrier=true);',
        ],
      },
      {
        category: "schema",
        statements: ['ALTER SCHEMA "Odd Schema" OWNER TO "Odd Owner";'],
      },
      {
        category: "extension",
        statements: [
          'ALTER EXTENSION "Odd Extension" UPDATE TO \'2.0\';',
          'ALTER EXTENSION "Odd Extension" SET SCHEMA "Odd Schema";',
        ],
      },
      {
        category: "trigger",
        statements: [
          'CREATE CONSTRAINT TRIGGER "Odd Trigger" AFTER INSERT ON "Odd Schema"."Odd Table" DEFERRABLE FOR EACH ROW EXECUTE FUNCTION public.audit_row();',
          'CREATE EVENT TRIGGER "Odd Event Trigger" ON ddl_command_end EXECUTE FUNCTION public.audit_ddl();',
          'DROP EVENT TRIGGER IF EXISTS "Odd Event Trigger";',
          'ALTER EVENT TRIGGER "Odd Trigger" ENABLE ALWAYS;',
          'ALTER TABLE "Odd Schema"."Odd Table" ENABLE TRIGGER "Odd Trigger";',
        ],
      },
    ] as const;

    for (const scenario of scenarios) {
      for (const statement of scenario.statements) {
        expect(getStatementCategory(statement)).toBe(scenario.category);
      }
    }
  });

  test("classifies emitted PostgreSQL replacements by their managed object", function () {
    expect(
      getStatementCategory(
        'CREATE OR REPLACE VIEW "Odd Schema"."Odd View" AS SELECT 1 AS id;'
      )
    ).toBe("view");
    expect(
      getStatementCategory(
        'CREATE OR REPLACE FUNCTION "Odd Schema"."Odd Function"() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;'
      )
    ).toBe("function");
    expect(
      getStatementCategory(
        'CREATE OR REPLACE PROCEDURE "Odd Schema"."Odd Procedure"() LANGUAGE sql AS $$ SELECT 1 $$;'
      )
    ).toBe("procedure");
  });

  test("classifies emitted unlogged relations by their managed object", function () {
    expect(
      getStatementCategory(
        'CREATE UNLOGGED TABLE "Odd Schema"."Odd Table" (id integer);'
      )
    ).toBe("table");
    expect(
      getStatementCategory(
        'CREATE UNLOGGED SEQUENCE "Odd Schema"."Odd Sequence" AS integer;'
      )
    ).toBe("sequence");
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
