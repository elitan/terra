import { describe, expect, test } from "bun:test";
import { SQLiteDiffer } from "../../providers/sqlite/differ";
import type { Table } from "../../types/schema";

function makeTable(overrides: Partial<Table> = {}): Table {
  return {
    name: "users",
    columns: [{ name: "id", type: "INTEGER", nullable: false }],
    ...overrides,
  };
}

describe("SQLiteDiffer private coverage", () => {
  test("detectChanges marks check constraint changes for recreation", () => {
    const differ = new SQLiteDiffer() as any;
    const desired = makeTable({
      checkConstraints: [{ expression: "id > 0" }],
    });
    const current = makeTable({
      checkConstraints: [{ expression: "id >= 0" }],
    });

    const changes = differ.detectChanges(desired, current);
    expect(changes.requiresRecreate).toBe(true);
    expect(changes.checkConstraintsChanged).toBe(true);
  });

  test("private SQL builders include unique where not-null and default branches", () => {
    const differ = new SQLiteDiffer() as any;

    expect(differ.columnsDiffer(
      { name: "value", type: "INTEGER", nullable: true, default: "1" },
      { name: "value", type: "INTEGER", nullable: true, default: "2" }
    )).toBe(true);

    const createTable = differ.generateCreateTable(
      makeTable({
        uniqueConstraints: [{ columns: ["id"] }],
      })
    ) as string;
    expect(createTable).toContain("UNIQUE (\"id\")");

    const createIndex = differ.generateCreateIndex({
      name: "idx_users_active",
      tableName: "users",
      columns: ["id"],
      where: "id > 0",
    }) as string;
    expect(createIndex).toContain("WHERE id > 0");

    const addColumn = differ.generateAddColumn("users", {
      name: "email",
      type: "TEXT",
      nullable: false,
      default: "'x'",
    }) as string;
    expect(addColumn).toContain("NOT NULL");
    expect(addColumn).toContain("DEFAULT 'x'");
  });
});
