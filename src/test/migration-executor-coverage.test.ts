import { describe, expect, test, mock } from "bun:test";
import { buildStatementMetadata } from "../cli/statement-metadata";

let promptAnswer = "yes";

mock.module("readline", function () {
  return {
    createInterface: function () {
      return {
        question: function (_message: string, callback: (value: string) => void) {
          callback(promptAnswer);
        },
        close: function () {},
      };
    },
  };
});

async function loadExecutor() {
  const mod = await import("../core/migration/executor");
  return mod.MigrationExecutor;
}

describe("MigrationExecutor coverage", () => {
  test("reports statement metadata in execution order", function () {
    const metadata = buildStatementMetadata({
      preTransactional: ["ALTER EXTENSION vector UPDATE TO '1.0';"],
      transactional: ["ALTER VIEW public.items SET (security_barrier=true);"],
      concurrent: ["ALTER INDEX public.items_idx SET TABLESPACE fast_space;"],
      deferred: ["ALTER EVENT TRIGGER audit_ddl ENABLE ALWAYS;"],
      hasChanges: true,
    });

    expect(metadata.map(function selectExecutionFields(item) {
      return [item.order, item.channel, item.category, item.sql];
    })).toEqual([
      [
        1,
        "pre-transactional",
        "extension",
        "ALTER EXTENSION vector UPDATE TO '1.0';",
      ],
      [
        2,
        "transactional",
        "view",
        "ALTER VIEW public.items SET (security_barrier=true);",
      ],
      [
        3,
        "concurrent",
        "index",
        "ALTER INDEX public.items_idx SET TABLESPACE fast_space;",
      ],
      [
        4,
        "deferred",
        "trigger",
        "ALTER EVENT TRIGGER audit_ddl ENABLE ALWAYS;",
      ],
    ]);
  });

  test("retains categories for PostgreSQL replacement statements", function () {
    const metadata = buildStatementMetadata({
      transactional: [
        "CREATE OR REPLACE VIEW public.items AS SELECT 1 AS id;",
        "CREATE OR REPLACE FUNCTION public.item_count() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;",
        "CREATE OR REPLACE PROCEDURE public.refresh_items() LANGUAGE sql AS $$ SELECT 1 $$;",
      ],
      concurrent: [],
      deferred: [],
      hasChanges: true,
    });

    expect(metadata.map(function selectCategory(item) {
      return item.category;
    })).toEqual(["view", "function", "procedure"]);
  });

  test("retains categories for PostgreSQL unlogged relations", function () {
    const metadata = buildStatementMetadata({
      transactional: [
        "CREATE UNLOGGED TABLE public.items (id integer);",
        "CREATE UNLOGGED SEQUENCE public.item_id_seq AS integer;",
      ],
      concurrent: [],
      deferred: [],
      hasChanges: true,
    });

    expect(metadata.map(function selectCategory(item) {
      return item.category;
    })).toEqual(["table", "sequence"]);
  });

  test("retains categories and risk for PostgreSQL authorization statements", function () {
    const metadata = buildStatementMetadata({
      transactional: [
        'CREATE ROLE "app reader" WITH LOGIN;',
        'GRANT SELECT ON TABLE public.items TO "app reader";',
        'ALTER DEFAULT PRIVILEGES FOR ROLE "app owner" GRANT SELECT ON TABLES TO "app reader";',
        'ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;',
        'CREATE POLICY "reader policy" ON public.items FOR SELECT TO "app reader" USING (true);',
        'CREATE SERVER "reporting" FOREIGN DATA WRAPPER "postgres_fdw";',
        'REVOKE SELECT ON TABLE public.items FROM "app reader" RESTRICT;',
        'ALTER DEFAULT PRIVILEGES FOR ROLE "app owner" REVOKE SELECT ON TABLES FROM "app reader" RESTRICT;',
        'ALTER TABLE public.items DISABLE ROW LEVEL SECURITY;',
        'DROP SERVER IF EXISTS "reporting" RESTRICT;',
      ],
      concurrent: [],
      deferred: [],
      hasChanges: true,
    });

    expect(metadata.map(function selectClassification(item) {
      return [item.category, item.risk];
    })).toEqual([
      ["role", "safe"],
      ["grant", "safe"],
      ["default-privilege", "safe"],
      ["policy", "safe"],
      ["policy", "safe"],
      ["foreign-server", "safe"],
      ["grant", "destructive"],
      ["default-privilege", "destructive"],
      ["policy", "destructive"],
      ["foreign-server", "destructive"],
    ]);
  });

  test("ignores metadata keywords inside statement content", function () {
    const metadata = buildStatementMetadata({
      transactional: [
        "CREATE OR REPLACE VIEW public.items AS SELECT 'DROP CONSTRAINT'::text AS label;",
        "ALTER TABLE public.items ALTER COLUMN note SET DEFAULT 'SET UNLOGGED';",
      ],
      concurrent: [],
      deferred: [],
      hasChanges: true,
    });

    expect(metadata.map(function selectClassification(item) {
      return [item.category, item.risk];
    })).toEqual([
      ["view", "safe"],
      ["table", "safe"],
    ]);
  });

  test("filters destructive operations", async function () {
    const MigrationExecutor = await loadExecutor();
    const executor = new MigrationExecutor({} as any);
    const destructive = (executor as any).getDestructiveOperations([
      "CREATE TABLE users (id INT)",
      "DROP TABLE users",
      "ALTER TABLE users DROP COLUMN email",
      "DROP VIEW v_users",
    ]);

    expect(destructive).toEqual([
      "DROP TABLE users",
      "ALTER TABLE users DROP COLUMN email",
      "DROP VIEW v_users",
    ]);
  });

  test("handles prompt confirmation answers", async function () {
    const MigrationExecutor = await loadExecutor();
    const executor = new MigrationExecutor({} as any);
    promptAnswer = "Y";
    expect(await (executor as any).promptConfirmation("continue?")).toBe(true);
    promptAnswer = "yes";
    expect(await (executor as any).promptConfirmation("continue?")).toBe(true);
    promptAnswer = "no";
    expect(await (executor as any).promptConfirmation("continue?")).toBe(false);
  });

  test("executes prerequisite, main, concurrent, and dependent phases in order", async function () {
    const MigrationExecutor = await loadExecutor();
    const calls: string[] = [];
    const executor = new MigrationExecutor({
      executeInTransaction: async function (_client: unknown, statements: string[]) {
        calls.push(...statements.map(function (statement) {
          return `transaction:${statement}`;
        }));
      },
    } as any);
    const client = {
      query: async function (statement: string) {
        calls.push(`query:${statement}`);
        return { rows: [] };
      },
    } as any;

    await executor.executePlan(
      client,
      {
        preTransactional: ["PRE"],
        transactional: ["TX"],
        deferred: ["DEFER"],
        concurrent: ["CONCURRENT"],
        hasChanges: true,
      },
      true
    );

    expect(calls).toEqual([
      "transaction:PRE",
      "transaction:TX",
      "query:CONCURRENT",
      "transaction:DEFER",
    ]);
  });
});
