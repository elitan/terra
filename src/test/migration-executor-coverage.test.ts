import { describe, expect, test, mock } from "bun:test";

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

  test("executes prerequisite transactions before the main and deferred phases", async function () {
    const MigrationExecutor = await loadExecutor();
    const calls: string[][] = [];
    const executor = new MigrationExecutor({
      executeInTransaction: async function (_client: unknown, statements: string[]) {
        calls.push([...statements]);
      },
    } as any);
    const client = {
      query: async function () {
        return { rows: [] };
      },
    } as any;

    await executor.executePlan(
      client,
      {
        preTransactional: ["PRE"],
        transactional: ["TX"],
        deferred: ["DEFER"],
        concurrent: [],
        hasChanges: true,
      },
      true
    );

    expect(calls).toEqual([["PRE"], ["TX"], ["DEFER"]]);
  });
});
