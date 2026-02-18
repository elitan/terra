import { describe, expect, test } from "bun:test";
import { MigrationExecutor } from "../core/migration/executor";

describe("MigrationExecutor coverage", () => {
  test("filters destructive operations", () => {
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
});
