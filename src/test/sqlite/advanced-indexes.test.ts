import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SchemaService } from "../../core/schema/service";
import { SQLiteProvider } from "../../providers/sqlite";
import type { SQLiteConnectionConfig } from "../../providers/types";

function makeSchema(
  scoreType: "INTEGER" | "REAL" = "INTEGER",
  expressionOrder: "ASC" | "DESC" = "DESC",
  scoreOrder: "ASC" | "DESC" = "ASC",
  uniqueScore: boolean = false,
  includeSearchIndex: boolean = true
): string {
  const searchIndex = includeSearchIndex
    ? `
  CREATE UNIQUE INDEX "idx people search" ON people (
    lower(trim(last || ', ' || first)) COLLATE NOCASE ${expressionOrder},
    score ${scoreOrder}
  ) WHERE active = 1 AND instr(last, ')') = 0;
`
    : "";
  const scoreIndexKind = uniqueScore ? "UNIQUE " : "";

  return `
  CREATE TABLE people (
    id INTEGER PRIMARY KEY,
    first TEXT NOT NULL,
    last TEXT NOT NULL,
    score ${scoreType} NOT NULL,
    active INTEGER NOT NULL
  );

  ${searchIndex}
  CREATE ${scoreIndexKind}INDEX idx_people_score ON people(score DESC);
`;
}

const initialSchema = makeSchema();
const recreatedTableSchema = makeSchema("REAL");
const changedIndexSchema = makeSchema("REAL", "ASC", "DESC");
const uniqueScoreSchema = makeSchema("REAL", "ASC", "DESC", true);
const removedSearchIndexSchema = makeSchema("REAL", "ASC", "DESC", false, false);

async function getIndexSql(
  client: Awaited<ReturnType<SQLiteProvider["createClient"]>>,
  name: string
): Promise<string | null> {
  const result = await client.query<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    [name]
  );
  return result.rows[0]?.sql || null;
}

async function expectSearchIndexUsed(
  provider: SQLiteProvider,
  config: SQLiteConnectionConfig
): Promise<void> {
  const client = await provider.createClient(config);
  try {
    const plan = await client.query<{ detail: string }>(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM people
      WHERE active = 1
        AND instr(last, ')') = 0
        AND lower(trim(last || ', ' || first)) COLLATE NOCASE = 'doe, alice'
        AND score = 10
    `);
    expect(plan.rows.some(function (row) {
      return row.detail.includes("idx people search");
    })).toBe(true);
  } finally {
    await client.end();
  }
}

async function runAdvancedIndexLifecycle(config: SQLiteConnectionConfig): Promise<void> {
  const provider = new SQLiteProvider();
  const anchor = await provider.createClient(config);
  const service = new SchemaService(provider, config);

  try {
    const createPlan = await service.apply(initialSchema, ["public"], true);
    expect(createPlan.transactional.some(function (statement) {
      return statement.includes(
        "lower(trim(last || ', ' || first)) COLLATE NOCASE DESC"
      );
    })).toBe(true);

    await anchor.query(
      "INSERT INTO people(id, first, last, score, active) VALUES (?, ?, ?, ?, ?)",
      [1, "Alice", "Doe", 10, 1]
    );
    await anchor.query(
      "INSERT INTO people(id, first, last, score, active) VALUES (?, ?, ?, ?, ?)",
      [2, "Bob", "Smith", 10, 0]
    );
    await expect(
      anchor.query(
        "INSERT INTO people(id, first, last, score, active) VALUES (?, ?, ?, ?, ?)",
        [3, "ALICE", "DOE", 10, 1]
      )
    ).rejects.toThrow("UNIQUE constraint failed");

    await expectSearchIndexUsed(provider, config);
    expect((await service.plan(initialSchema)).hasChanges).toBe(false);

    const recreationPlan = await service.apply(
      recreatedTableSchema,
      ["public"],
      true
    );
    expect(recreationPlan.transactional.some(function (statement) {
      return statement.startsWith('CREATE TABLE "_people_new"');
    })).toBe(true);
    expect(await getIndexSql(anchor, "idx people search")).toContain(
      "COLLATE NOCASE DESC"
    );
    await expectSearchIndexUsed(provider, config);
    expect((await service.plan(recreatedTableSchema)).hasChanges).toBe(false);

    const changedIndexPlan = await service.apply(
      changedIndexSchema,
      ["public"],
      true
    );
    expect(changedIndexPlan.transactional).toContain(
      'DROP INDEX IF EXISTS "idx people search";'
    );
    expect(await getIndexSql(anchor, "idx people search")).toContain(
      "COLLATE NOCASE ASC"
    );
    const xinfo = await anchor.query<{ desc: number; key: number }>(
      'PRAGMA index_xinfo("idx people search")'
    );
    expect(xinfo.rows.filter(function (row) {
      return row.key === 1;
    }).map(function (row) {
      return row.desc;
    })).toEqual([0, 1]);
    expect((await service.plan(changedIndexSchema)).hasChanges).toBe(false);

    await expect(
      service.apply(uniqueScoreSchema, ["public"], true)
    ).rejects.toThrow("UNIQUE constraint failed");
    const indexList = await anchor.query<{ name: string; unique: number }>(
      "PRAGMA index_list(people)"
    );
    expect(indexList.rows.find(function (index) {
      return index.name === "idx_people_score";
    })?.unique).toBe(0);
    expect((await service.plan(changedIndexSchema)).hasChanges).toBe(false);

    const removalPlan = await service.apply(
      removedSearchIndexSchema,
      ["public"],
      true
    );
    expect(removalPlan.transactional).toContain(
      'DROP INDEX IF EXISTS "idx people search";'
    );
    expect(await getIndexSql(anchor, "idx people search")).toBeNull();
    expect((await service.plan(removedSearchIndexSchema)).hasChanges).toBe(false);
  } finally {
    await anchor.end();
  }
}

describe("SQLite advanced indexes", function () {
  test("parses complete mixed expression index metadata", async function () {
    const provider = new SQLiteProvider();
    const parsed = await provider.parseSchema(initialSchema);
    const index = parsed.tables[0]?.indexes?.find(function (candidate) {
      return candidate.name === "idx people search";
    });
    if (!index) {
      throw new Error("expected parsed advanced index");
    }

    expect(index.columns).toEqual(["score"]);
    expect(index.sortOrders).toEqual(["DESC", "ASC"]);
    expect(index.terms).toEqual([
      {
        expression: "lower(trim(last || ', ' || first))",
        collation: "NOCASE",
        order: "DESC",
      },
      {
        column: "score",
        collation: "BINARY",
        order: "ASC",
      },
    ]);
    expect(index.where).toBe("active = 1 AND instr(last, ')') = 0");
    expect(index.createStatement).toContain(
      "lower(trim(last || ', ' || first)) COLLATE NOCASE DESC"
    );
  });

  test("preserves advanced indexes through lifecycle and failed replacement", async function () {
    const dbPath = path.join(os.tmpdir(), `terradb-indexes-${Date.now()}.db`);
    const memoryName = `terradb-indexes-${Date.now()}`;

    try {
      await runAdvancedIndexLifecycle({
        dialect: "sqlite",
        filename: `file:${memoryName}?mode=memory&cache=shared`,
      });
      await runAdvancedIndexLifecycle({ dialect: "sqlite", filename: dbPath });
    } finally {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    }
  });
});
