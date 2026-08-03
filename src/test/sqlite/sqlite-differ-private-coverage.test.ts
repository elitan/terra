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

  test("detectChanges marks unique constraint changes for recreation", function () {
    const differ = new SQLiteDiffer() as any;
    const desired = makeTable({
      uniqueConstraints: [{ columns: ["id"] }],
    });
    const current = makeTable();

    const changes = differ.detectChanges(desired, current);
    expect(changes.requiresRecreate).toBe(true);
    expect(changes.uniqueConstraintsChanged).toBe(true);
  });

  test("private SQL builders include unique where not-null and default branches", () => {
    const differ = new SQLiteDiffer() as any;

    expect(differ.columnsDiffer(
      { name: "value", type: "INTEGER", nullable: true, default: "1" },
      { name: "value", type: "INTEGER", nullable: true, default: "2" }
    )).toBe(true);

    const createTable = differ.generateCreateTable(
      makeTable({
        uniqueConstraints: [{ name: "users_id_unique", columns: ["id"] }],
      })
    ) as string;
    expect(createTable).toContain("CONSTRAINT \"users_id_unique\" UNIQUE (\"id\")");

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

  test("generated columns select additive and recreation paths safely", function () {
    const differ = new SQLiteDiffer() as any;
    const virtualColumn = {
      name: "virtual_value",
      type: "TEXT",
      nullable: true,
      generated: {
        always: true,
        expression: "value || ' virtual'",
        stored: false,
      },
    };
    const storedColumn = {
      name: "stored_value",
      type: "TEXT",
      nullable: false,
      generated: {
        always: true,
        expression: "value || ' stored'",
        stored: true,
      },
    };

    expect(differ.detectChanges(
      makeTable({ columns: [...makeTable().columns, virtualColumn] }),
      makeTable()
    ).requiresRecreate).toBe(false);
    expect(differ.detectChanges(
      makeTable({ columns: [...makeTable().columns, storedColumn] }),
      makeTable()
    ).requiresRecreate).toBe(true);

    const createSql = differ.generateCreateTable(
      makeTable({ columns: [...makeTable().columns, storedColumn] })
    ) as string;
    expect(createSql).toContain(
      '"stored_value" TEXT GENERATED ALWAYS AS (value || \' stored\') STORED NOT NULL'
    );

    const recreation = differ.generateTableRecreation(
      makeTable({ columns: [...makeTable().columns, storedColumn] }),
      makeTable()
    ) as string[];
    expect(recreation[1]).toBe(
      'INSERT INTO "_users_new" ("id") SELECT "id" FROM "users";'
    );
  });

  test("does not collapse meaningful whitespace inside generated literals", function () {
    const differ = new SQLiteDiffer() as any;
    const baseColumn = {
      name: "display",
      type: "TEXT",
      nullable: true,
      generated: {
        always: true,
        expression: "value || 'a   b'",
        stored: false,
      },
    };
    const changedColumn = {
      ...baseColumn,
      generated: {
        ...baseColumn.generated,
        expression: "value || 'a b'",
      },
    };

    expect(differ.columnsDiffer(baseColumn, changedColumn)).toBe(true);
  });
});
