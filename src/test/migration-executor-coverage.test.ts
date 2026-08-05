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
