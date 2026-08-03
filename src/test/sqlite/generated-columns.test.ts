import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SQLiteProvider } from "../../providers/sqlite";
import type { SQLiteConnectionConfig } from "../../providers/types";

const initialSchema = `
  CREATE TABLE measurements (
    id INTEGER PRIMARY KEY,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    denominator INTEGER NOT NULL,
    area INTEGER GENERATED ALWAYS AS ((width * height) + abs(0)) STORED,
    perimeter INTEGER AS ((width + height) * 2) VIRTUAL
  );
`;

const withVirtualColumnSchema = initialSchema.replace(
  "perimeter INTEGER AS ((width + height) * 2) VIRTUAL",
  `perimeter INTEGER AS ((width + height) * 2) VIRTUAL,
    label TEXT AS (printf('%d,%d', width, height))`
);

const withStoredColumnSchema = withVirtualColumnSchema.replace(
  "label TEXT AS (printf('%d,%d', width, height))",
  `label TEXT AS (printf('%d,%d', width, height)),
    doubled_area INTEGER AS (area * 2) STORED`
);

const changedExpressionSchema = withStoredColumnSchema.replace(
  "AS ((width * height) + abs(0)) STORED",
  "AS ((width * height) + 1) STORED"
);

const failingStoredColumnSchema = changedExpressionSchema.replace(
  "doubled_area INTEGER AS (area * 2) STORED",
  `doubled_area INTEGER AS (area * 2) STORED,
    ratio INTEGER AS (
      CASE WHEN denominator = 0 THEN NULL ELSE width / denominator END
    ) STORED NOT NULL`
);

const removedVirtualColumnSchema = changedExpressionSchema.replace(
  "    label TEXT AS (printf('%d,%d', width, height)),\n",
  ""
);

async function applySchema(
  provider: SQLiteProvider,
  client: Awaited<ReturnType<SQLiteProvider["createClient"]>>,
  sql: string
) {
  const desired = await provider.parseSchema(sql);
  const current = await provider.getCurrentSchema(client);
  const plan = provider.generateMigrationPlan(desired.tables, current);
  if (plan.hasChanges) {
    await provider.executeInTransaction(client, plan.transactional);
  }
  return plan;
}

async function runGeneratedColumnLifecycle(config: SQLiteConnectionConfig): Promise<void> {
  const provider = new SQLiteProvider();
  const client = await provider.createClient(config);

  try {
    const initial = await applySchema(provider, client, initialSchema);
    expect(initial.hasChanges).toBe(true);
    await client.query(
      "INSERT INTO measurements (id, width, height, denominator) VALUES (?, ?, ?, ?)",
      [1, 3, 4, 0]
    );
    expect(
      (await client.query(
        "SELECT area, perimeter FROM measurements WHERE id = 1"
      )).rows
    ).toEqual([{ area: 12, perimeter: 14 }]);

    const initialReapply = await applySchema(provider, client, initialSchema);
    expect(initialReapply.hasChanges).toBe(false);

    const virtualAddition = await applySchema(provider, client, withVirtualColumnSchema);
    expect(virtualAddition.transactional).toHaveLength(1);
    expect(virtualAddition.transactional[0]).toContain(
      'ALTER TABLE "measurements" ADD COLUMN "label"'
    );
    expect(
      (await client.query(
        "SELECT label FROM measurements WHERE id = 1"
      )).rows
    ).toEqual([{ label: "3,4" }]);
    expect((await applySchema(provider, client, withVirtualColumnSchema)).hasChanges).toBe(false);

    const storedAddition = await applySchema(provider, client, withStoredColumnSchema);
    expect(storedAddition.transactional[0]).toContain(
      'CREATE TABLE "_measurements_new"'
    );
    expect(
      (await client.query(
        "SELECT area, perimeter, label, doubled_area FROM measurements WHERE id = 1"
      )).rows
    ).toEqual([{ area: 12, perimeter: 14, label: "3,4", doubled_area: 24 }]);
    expect((await applySchema(provider, client, withStoredColumnSchema)).hasChanges).toBe(false);

    const expressionChange = await applySchema(provider, client, changedExpressionSchema);
    expect(expressionChange.transactional[0]).toContain(
      'CREATE TABLE "_measurements_new"'
    );
    expect(
      (await client.query(
        "SELECT area, doubled_area FROM measurements WHERE id = 1"
      )).rows
    ).toEqual([{ area: 13, doubled_area: 26 }]);
    expect((await applySchema(provider, client, changedExpressionSchema)).hasChanges).toBe(false);

    const failingDesired = await provider.parseSchema(failingStoredColumnSchema);
    const current = await provider.getCurrentSchema(client);
    const failingPlan = provider.generateMigrationPlan(failingDesired.tables, current);
    expect(failingPlan.hasChanges).toBe(true);
    expect(failingPlan.transactional[0]).toContain(
      'CREATE TABLE "_measurements_new"'
    );
    await expect(
      provider.executeInTransaction(client, failingPlan.transactional)
    ).rejects.toThrow("NOT NULL");

    const tables = await provider.getCurrentSchema(client);
    expect(tables[0]?.columns.some(function (column) {
      return column.name === "ratio";
    })).toBe(false);
    expect(
      (await client.query(
        "SELECT id, width, height, denominator, area, doubled_area FROM measurements"
      )).rows
    ).toEqual([
      { id: 1, width: 3, height: 4, denominator: 0, area: 13, doubled_area: 26 },
    ]);
    expect(
      (await client.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_measurements_new'"
      )).rows
    ).toEqual([]);

    const removal = await applySchema(provider, client, removedVirtualColumnSchema);
    expect(removal.transactional[0]).toContain(
      'CREATE TABLE "_measurements_new"'
    );
    const afterRemoval = await provider.getCurrentSchema(client);
    expect(afterRemoval[0]?.columns.some(function (column) {
      return column.name === "label";
    })).toBe(false);
    expect(
      (await client.query(
        "SELECT area, perimeter, doubled_area FROM measurements WHERE id = 1"
      )).rows
    ).toEqual([{ area: 13, perimeter: 14, doubled_area: 26 }]);
    expect((await applySchema(provider, client, removedVirtualColumnSchema)).hasChanges).toBe(false);
  } finally {
    await client.end();
  }
}

describe("SQLite generated columns", function () {
  test("parses virtual and stored metadata with nested expressions", async function () {
    const provider = new SQLiteProvider();
    const parsed = await provider.parseSchema(`
      CREATE TABLE "computed values" (
        "base value" INTEGER NOT NULL,
        scale INTEGER,
        "virtual label" TEXT AS (printf('%d,%d', "base value", scale)),
        stored_total INTEGER GENERATED ALWAYS AS (
          (("base value" + scale) * abs(scale))
        ) STORED NOT NULL
      );
    `);

    expect(parsed.tables[0]?.columns).toEqual([
      { name: "base value", type: "INTEGER", nullable: false },
      { name: "scale", type: "INTEGER", nullable: true },
      {
        name: "virtual label",
        type: "TEXT",
        nullable: true,
        generated: {
          always: true,
          expression: "printf('%d,%d', \"base value\", scale)",
          stored: false,
        },
      },
      {
        name: "stored_total",
        type: "INTEGER",
        nullable: false,
        generated: {
          always: true,
          expression: '(("base value" + scale) * abs(scale))',
          stored: true,
        },
      },
    ]);
  });

  test("preserves computed behavior through add, recreate, reapply, and rollback", async function () {
    const dbPath = path.join(os.tmpdir(), `terradb-generated-${Date.now()}.db`);

    try {
      await runGeneratedColumnLifecycle({ dialect: "sqlite", filename: ":memory:" });
      await runGeneratedColumnLifecycle({ dialect: "sqlite", filename: dbPath });
    } finally {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    }
  });
});
