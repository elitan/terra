import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SchemaService } from "../../core/schema/service";
import { SQLiteProvider } from "../../providers/sqlite";
import type { SQLiteConnectionConfig } from "../../providers/types";

interface SchemaOptions {
  quantityType?: "INTEGER" | "REAL";
  strict?: boolean;
  autoincrement?: boolean;
  withoutRowid?: boolean;
  addRequiredColumn?: boolean;
  eventCollation?: "NOCASE" | "BINARY";
  uniqueConflict?: "IGNORE" | "REPLACE";
  primaryConflict?: "IGNORE" | "REPLACE";
}

const eventsTableName = 'strict "events"';
const dictionaryTableName = 'dictionary "entries"';

function makeSchema(options: SchemaOptions = {}): string {
  const quantityType = options.quantityType || "INTEGER";
  const strict = options.strict ?? true;
  const autoincrement = options.autoincrement ?? true;
  const withoutRowid = options.withoutRowid ?? true;
  const eventCollation = options.eventCollation || "NOCASE";
  const uniqueConflict = options.uniqueConflict || "IGNORE";
  const primaryConflict = options.primaryConflict || "REPLACE";
  const requiredColumn = options.addRequiredColumn
    ? ',\n    "required value" TEXT NOT NULL'
    : "";
  const eventsOptions = strict ? " STRICT" : "";
  const dictionaryOptions = [
    withoutRowid ? "WITHOUT ROWID" : "",
    strict ? "STRICT" : "",
  ].filter(Boolean).join(", ");

  return `
  CREATE TABLE "strict ""events""" (
    "id ""key""" INTEGER PRIMARY KEY${autoincrement ? " AUTOINCREMENT" : ""},
    "code value" TEXT COLLATE ${eventCollation} CONSTRAINT "unique ""code""" UNIQUE ON CONFLICT ${uniqueConflict},
    quantity ${quantityType} CONSTRAINT "required quantity" NOT NULL ON CONFLICT FAIL DEFAULT 0${requiredColumn}
  )${eventsOptions};

  CREATE TABLE "dictionary ""entries""" (
    "lookup ""key""" TEXT COLLATE NOCASE,
    locale TEXT,
    payload BLOB,
    CONSTRAINT "primary ""dictionary""" PRIMARY KEY ("lookup ""key""" DESC, locale ASC) ON CONFLICT ${primaryConflict}
  )${dictionaryOptions ? ` ${dictionaryOptions}` : ""};
`;
}

async function getTableSql(
  client: Awaited<ReturnType<SQLiteProvider["createClient"]>>,
  name: string
): Promise<string> {
  const result = await client.query<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name]
  );
  return result.rows[0]?.sql || "";
}

async function getTableFlags(
  client: Awaited<ReturnType<SQLiteProvider["createClient"]>>,
  name: string
): Promise<{ strict: number; wr: number }> {
  const result = await client.query<{
    name: string;
    strict: number;
    wr: number;
  }>("PRAGMA table_list");
  const row = result.rows.find(function (candidate) {
    return candidate.name === name;
  });
  if (!row) {
    throw new Error(`expected table ${name}`);
  }
  return { strict: row.strict, wr: row.wr };
}

async function runTableDefinitionLifecycle(
  config: SQLiteConnectionConfig
): Promise<void> {
  const provider = new SQLiteProvider();
  const anchor = await provider.createClient(config);
  const service = new SchemaService(provider, config);
  const initialSchema = makeSchema();
  const recreatedSchema = makeSchema({ quantityType: "REAL" });

  try {
    const createPlan = await service.apply(initialSchema, ["public"], true);
    expect(createPlan.transactional.some(function (statement) {
      return statement.includes("AUTOINCREMENT");
    })).toBe(true);
    expect(await getTableFlags(anchor, eventsTableName)).toEqual({
      strict: 1,
      wr: 0,
    });
    expect(await getTableFlags(anchor, dictionaryTableName)).toEqual({
      strict: 1,
      wr: 1,
    });

    await expect(
      anchor.query(
        'INSERT INTO "strict ""events""" ("code value", quantity) VALUES (?, ?)',
        ["bad", "not-a-number"]
      )
    ).rejects.toThrow();
    await anchor.query(
      'INSERT INTO "strict ""events""" ("code value", quantity) VALUES (?, ?)',
      ["Alpha", 1]
    );
    await anchor.query(
      'INSERT INTO "strict ""events""" ("code value", quantity) VALUES (?, ?)',
      ["Beta", 2]
    );
    await anchor.query(
      'DELETE FROM "strict ""events""" WHERE "id ""key""" = 2'
    );

    await anchor.query(
      'INSERT INTO "dictionary ""entries""" ("lookup ""key""", locale, payload) VALUES (?, ?, ?)',
      ["Term", "en", Uint8Array.from([1])]
    );
    await anchor.query(
      'INSERT INTO "dictionary ""entries""" ("lookup ""key""", locale, payload) VALUES (?, ?, ?)',
      ["term", "en", Uint8Array.from([2])]
    );
    const dictionaryRows = await anchor.query<{ payload: string }>(
      'SELECT hex(payload) AS payload FROM "dictionary ""entries"""'
    );
    expect(dictionaryRows.rows).toHaveLength(1);
    expect(dictionaryRows.rows[0]?.payload).toBe("02");
    await expect(
      anchor.query('SELECT rowid FROM "dictionary ""entries"""')
    ).rejects.toThrow("no such column: rowid");
    expect((await service.plan(initialSchema)).hasChanges).toBe(false);

    const recreation = await service.apply(recreatedSchema, ["public"], true);
    expect(recreation.transactional.some(function (statement) {
      return statement.includes('_strict ""events""_new');
    })).toBe(true);
    const recreatedSql = await getTableSql(anchor, eventsTableName);
    expect(recreatedSql).toContain("AUTOINCREMENT");
    expect(recreatedSql).toMatch(/\)\s*STRICT$/i);

    await anchor.query(
      'INSERT INTO "strict ""events""" ("code value", quantity) VALUES (?, ?)',
      ["Gamma", 3]
    );
    const ids = await anchor.query<{ id: number }>(
      'SELECT "id ""key""" AS id FROM "strict ""events""" ORDER BY id'
    );
    expect(ids.rows.map(function (row) {
      return row.id;
    })).toEqual([1, 3]);

    await anchor.query(
      'INSERT INTO "strict ""events""" ("code value", quantity) VALUES (?, ?)',
      ["alpha", 4]
    );
    const count = await anchor.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM "strict ""events"""'
    );
    expect(count.rows[0]?.count).toBe(2);
    expect((await service.plan(recreatedSchema)).hasChanges).toBe(false);

    const conflictSchema = makeSchema({
      quantityType: "REAL",
      uniqueConflict: "REPLACE",
      primaryConflict: "IGNORE",
    });
    const conflictPlan = await service.apply(conflictSchema, ["public"], true);
    expect(conflictPlan.transactional.filter(function (statement) {
      return statement.startsWith("CREATE TABLE");
    }).length).toBe(2);
    await anchor.query(
      'INSERT INTO "strict ""events""" ("code value", quantity) VALUES (?, ?)',
      ["alpha", 99]
    );
    const replaced = await anchor.query<{ quantity: number }>(
      'SELECT quantity FROM "strict ""events""" WHERE "code value" = ? COLLATE NOCASE',
      ["alpha"]
    );
    expect(replaced.rows).toEqual([{ quantity: 99 }]);
    await anchor.query(
      'INSERT INTO "dictionary ""entries""" ("lookup ""key""", locale, payload) VALUES (?, ?, ?)',
      ["TERM", "en", Uint8Array.from([3])]
    );
    const ignoredDictionary = await anchor.query<{ payload: string }>(
      'SELECT hex(payload) AS payload FROM "dictionary ""entries"""'
    );
    expect(ignoredDictionary.rows).toEqual([{ payload: "02" }]);
    expect((await service.plan(conflictSchema)).hasChanges).toBe(false);

    const binaryCollationSchema = makeSchema({
      quantityType: "REAL",
      eventCollation: "BINARY",
      uniqueConflict: "REPLACE",
      primaryConflict: "IGNORE",
    });
    const collationPlan = await service.apply(
      binaryCollationSchema,
      ["public"],
      true
    );
    expect(collationPlan.transactional.some(function (statement) {
      return statement.includes('_strict ""events""_new');
    })).toBe(true);
    await anchor.query(
      'INSERT INTO "strict ""events""" ("code value", quantity) VALUES (?, ?)',
      ["ALPHA", 5]
    );
    const binaryCount = await anchor.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM "strict ""events"""'
    );
    expect(binaryCount.rows[0]?.count).toBe(3);
    expect((await service.plan(binaryCollationSchema)).hasChanges).toBe(false);

    const invalidSchema = makeSchema({
      quantityType: "REAL",
      strict: false,
      addRequiredColumn: true,
      eventCollation: "BINARY",
      uniqueConflict: "REPLACE",
      primaryConflict: "IGNORE",
    });
    await expect(
      service.apply(invalidSchema, ["public"], true)
    ).rejects.toThrow("NOT NULL constraint failed");
    expect(await getTableFlags(anchor, eventsTableName)).toEqual({
      strict: 1,
      wr: 0,
    });
    expect(await getTableSql(anchor, eventsTableName)).toContain("AUTOINCREMENT");
    expect((await service.plan(binaryCollationSchema)).hasChanges).toBe(false);

    const relaxedSchema = makeSchema({
      quantityType: "REAL",
      strict: false,
      autoincrement: false,
      withoutRowid: false,
      eventCollation: "BINARY",
      uniqueConflict: "REPLACE",
      primaryConflict: "IGNORE",
    });
    const relaxedPlan = await service.apply(relaxedSchema, ["public"], true);
    expect(relaxedPlan.transactional.filter(function (statement) {
      return statement.startsWith("CREATE TABLE");
    }).length).toBe(2);
    expect(await getTableFlags(anchor, eventsTableName)).toEqual({
      strict: 0,
      wr: 0,
    });
    expect(await getTableFlags(anchor, dictionaryTableName)).toEqual({
      strict: 0,
      wr: 0,
    });
    expect(await getTableSql(anchor, eventsTableName)).not.toContain(
      "AUTOINCREMENT"
    );

    await anchor.query(
      'INSERT INTO "strict ""events""" ("code value", quantity) VALUES (?, ?)',
      ["Loose", "not-a-number"]
    );
    const looseType = await anchor.query<{ type: string }>(
      'SELECT typeof(quantity) AS type FROM "strict ""events""" WHERE "code value" = ?',
      ["Loose"]
    );
    expect(looseType.rows[0]?.type).toBe("text");
    const rowids = await anchor.query<{ rowid: number }>(
      'SELECT rowid FROM "dictionary ""entries"""'
    );
    expect(rowids.rows).toHaveLength(1);
    expect((await service.plan(relaxedSchema)).hasChanges).toBe(false);
  } finally {
    await anchor.end();
  }
}

describe("SQLite table definition fidelity", function () {
  test("parses storage options and lossless table SQL", async function () {
    const provider = new SQLiteProvider();
    const parsed = await provider.parseSchema(makeSchema());
    const events = parsed.tables.find(function (table) {
      return table.name === eventsTableName;
    });
    const dictionary = parsed.tables.find(function (table) {
      return table.name === dictionaryTableName;
    });
    if (!events || !dictionary) {
      throw new Error("expected parsed table definitions");
    }

    expect(events.strict).toBe(true);
    expect(events.withoutRowid).toBe(false);
    expect(events.autoincrementColumns).toEqual(['id "key"']);
    expect(events.createStatement).toContain("AUTOINCREMENT");
    expect(dictionary.strict).toBe(true);
    expect(dictionary.withoutRowid).toBe(true);
    expect(dictionary.createStatement).toContain("ON CONFLICT REPLACE");
    expect(dictionary.createStatement).toContain('CONSTRAINT "primary ""dictionary"""');
  });

  test("preserves table semantics through recreation, rollback, and option removal", async function () {
    const dbPath = path.join(
      os.tmpdir(),
      `terradb-table-definition-${Date.now()}.db`
    );
    const memoryName = `terradb-table-definition-${Date.now()}`;

    try {
      await runTableDefinitionLifecycle({
        dialect: "sqlite",
        filename: `file:${memoryName}?mode=memory&cache=shared`,
      });
      await runTableDefinitionLifecycle({ dialect: "sqlite", filename: dbPath });
    } finally {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    }
  });
});
