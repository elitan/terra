import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SchemaService } from "../../core/schema/service";
import { SQLiteProvider } from "../../providers/sqlite";
import type { SQLiteConnectionConfig } from "../../providers/types";

const searchTable = 'search "docs"';
const boxesTable = 'geo "boxes"';

function makeSchema(includeCategory: boolean = false): string {
  const category = includeCategory ? ",\n    category UNINDEXED" : "";
  return `
  CREATE VIRTUAL TABLE "search ""docs""" USING fts5(
    title,
    body${category},
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE VIRTUAL TABLE "geo ""boxes""" USING rtree(
    id,
    min_x,
    max_x,
    min_y,
    max_y
  );

  CREATE VIEW search_titles AS
    SELECT rowid, title FROM "search ""docs""";
`;
}

const initialSchema = makeSchema();
const changedSchema = makeSchema(true);
const failingSchema = changedSchema.replace(
  /CREATE VIRTUAL TABLE "search ""docs""" USING fts5\([\s\S]*?\n  \);/,
  `CREATE VIRTUAL TABLE "search ""docs""" USING rtree(
    title,
    body,
    category
  );`
);
const removedSearchSchema = `
  CREATE VIRTUAL TABLE "geo ""boxes""" USING rtree(
    id,
    min_x,
    max_x,
    min_y,
    max_y
  );
`;

async function getTableKinds(
  client: Awaited<ReturnType<SQLiteProvider["createClient"]>>
): Promise<Array<{ name: string; type: string }>> {
  const result = await client.query<{ name: string; type: string; schema: string }>(
    "PRAGMA table_list"
  );
  return result.rows
    .filter(function (row) {
      return row.schema === "main" && !row.name.startsWith("sqlite_");
    })
    .map(function (row) {
      return { name: row.name, type: row.type };
    });
}

async function runVirtualTableLifecycle(
  config: SQLiteConnectionConfig
): Promise<void> {
  const provider = new SQLiteProvider();
  const anchor = await provider.createClient(config);
  const service = new SchemaService(provider, config);

  try {
    const createPlan = await service.apply(initialSchema, ["public"], true);
    expect(createPlan.transactional.filter(function (statement) {
      return /^CREATE VIRTUAL TABLE/i.test(statement.trim());
    })).toHaveLength(2);
    expect(createPlan.transactional.some(function (statement) {
      return /CREATE TABLE\s+['"]?(?:search|geo).*_(?:data|idx|content|node|rowid|parent)/i.test(statement);
    })).toBe(false);

    const managed = await provider.getCurrentSchema(anchor);
    expect(managed.map(function (table) {
      return { name: table.name, virtual: table.virtual };
    })).toEqual([
      { name: boxesTable, virtual: true },
      { name: searchTable, virtual: true },
    ]);

    const kinds = await getTableKinds(anchor);
    expect(kinds.filter(function (table) {
      return table.type === "virtual";
    })).toEqual(expect.arrayContaining([
      { name: searchTable, type: "virtual" },
      { name: boxesTable, type: "virtual" },
    ]));
    expect(kinds.some(function (table) {
      return table.type === "shadow";
    })).toBe(true);

    await anchor.query(
      'INSERT INTO "search ""docs""" (title, body) VALUES (?, ?)',
      ["Résumé guide", "A needle in searchable text"]
    );
    await anchor.query(
      'INSERT INTO "search ""docs""" (title, body) VALUES (?, ?)',
      ["Résumé guide", "Another needle in the index"]
    );
    await anchor.query(
      'INSERT INTO "geo ""boxes""" (id, min_x, max_x, min_y, max_y) VALUES (?, ?, ?, ?, ?)',
      [1, 10, 20, 30, 40]
    );
    const matches = await anchor.query<{ title: string }>(
      'SELECT title FROM "search ""docs""" WHERE "search ""docs""" MATCH ?',
      ["resume AND needle"]
    );
    expect(matches.rows).toEqual([
      { title: "Résumé guide" },
      { title: "Résumé guide" },
    ]);
    const intersections = await anchor.query<{ id: number }>(
      'SELECT id FROM "geo ""boxes""" WHERE min_x <= ? AND max_x >= ? AND min_y <= ? AND max_y >= ?',
      [15, 15, 35, 35]
    );
    expect(intersections.rows).toEqual([{ id: 1 }]);
    expect((await service.plan(initialSchema)).hasChanges).toBe(false);

    await expect(
      service.apply(changedSchema, ["public"], true, undefined, false, true)
    ).rejects.toThrow("Strict mode blocked destructive migration statements");
    expect((await service.plan(initialSchema)).hasChanges).toBe(false);

    const recreation = await service.apply(changedSchema, ["public"], true);
    const dropView = recreation.transactional.findIndex(function (statement) {
      return /^DROP VIEW/i.test(statement.trim());
    });
    const createTemporaryTable = recreation.transactional.findIndex(function (statement) {
      return /^CREATE VIRTUAL TABLE\s+"_search/i.test(statement.trim());
    });
    const createView = recreation.transactional.findIndex(function (statement) {
      return /^CREATE VIEW/i.test(statement.trim());
    });
    expect(dropView).toBeGreaterThanOrEqual(0);
    expect(createTemporaryTable).toBeGreaterThan(dropView);
    expect(createView).toBeGreaterThan(createTemporaryTable);
    expect((await service.plan(changedSchema)).hasChanges).toBe(false);

    const preserved = await anchor.query<{ title: string; category: string | null }>(
      'SELECT title, category FROM "search ""docs""" WHERE "search ""docs""" MATCH ?',
      ["needle"]
    );
    expect(preserved.rows).toEqual([
      { title: "Résumé guide", category: null },
      { title: "Résumé guide", category: null },
    ]);
    expect((await anchor.query<{ title: string }>(
      "SELECT title FROM search_titles"
    )).rows).toEqual([
      { title: "Résumé guide" },
      { title: "Résumé guide" },
    ]);

    await expect(
      service.apply(failingSchema, ["public"], true)
    ).rejects.toThrow();
    expect((await service.plan(changedSchema)).hasChanges).toBe(false);
    expect((await anchor.query<{ title: string }>(
      'SELECT title FROM "search ""docs""" WHERE "search ""docs""" MATCH ?',
      ["needle"]
    )).rows).toEqual([
      { title: "Résumé guide" },
      { title: "Résumé guide" },
    ]);
    expect((await anchor.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name LIKE ? ORDER BY name",
      ['_search "docs"_new%']
    )).rows).toEqual([]);

    const removal = await service.apply(removedSearchSchema, ["public"], true);
    expect(removal.transactional).toContain(
      'DROP TABLE IF EXISTS "search ""docs""";'
    );
    expect((await service.plan(removedSearchSchema)).hasChanges).toBe(false);
    const remainingKinds = await getTableKinds(anchor);
    expect(remainingKinds.some(function (table) {
      return table.name === searchTable || table.name.startsWith(`${searchTable}_`);
    })).toBe(false);
    expect(remainingKinds.some(function (table) {
      return table.name === boxesTable && table.type === "virtual";
    })).toBe(true);
  } finally {
    await anchor.end();
  }
}

describe("SQLite virtual tables", function () {
  test("parses virtual tables without exposing implementation shadow tables", async function () {
    const provider = new SQLiteProvider();
    const parsed = await provider.parseSchema(initialSchema);

    expect(parsed.tables.map(function (table) {
      return { name: table.name, virtual: table.virtual };
    })).toEqual([
      { name: boxesTable, virtual: true },
      { name: searchTable, virtual: true },
    ]);
    expect(parsed.tables.every(function (table) {
      return table.createStatement?.startsWith("CREATE VIRTUAL TABLE");
    })).toBe(true);
  });

  test("preserves FTS5 and RTree semantics through lifecycle and rollback", async function () {
    const dbPath = path.join(os.tmpdir(), `terradb-virtual-${Date.now()}.db`);
    const memoryName = `terradb-virtual-${Date.now()}`;

    try {
      await runVirtualTableLifecycle({
        dialect: "sqlite",
        filename: `file:${memoryName}?mode=memory&cache=shared`,
      });
      await runVirtualTableLifecycle({ dialect: "sqlite", filename: dbPath });
    } finally {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    }
  });
});
