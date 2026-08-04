import { describe, expect, test } from "bun:test";
import { SQLiteDiffer } from "../../providers/sqlite/differ";
import type { Table } from "../../types/schema";
import {
  chooseSQLiteRecreationTableName,
  hasSQLiteTableRecreation,
  isSQLiteRecreationTableStatement,
} from "../../utils/sqlite-recreation";
import {
  collectSQLiteSchemaIdentifiers,
  normalizeSQLiteIdentifier,
} from "../../utils/sqlite-identifier";
import {
  canonicalizeSQLiteDefinitionIdentifiers,
  extractSQLiteColumnCollations,
  extractSQLiteForeignKeyMatchClauses,
  isSQLiteRowidAliasColumnDefinition,
  removeSQLiteForeignKeyMatchSimpleClauses,
  removeSQLiteForeignKeyTargetColumns,
  normalizeSQLiteSchemaDefinition,
} from "../../providers/sqlite/sql-parser-utils";

function makeTable(overrides: Partial<Table> = {}): Table {
  return {
    name: "users",
    columns: [{ name: "id", type: "INTEGER", nullable: false }],
    ...overrides,
  };
}

describe("SQLiteDiffer private coverage", () => {
  test("selects and recognizes collision-safe recreation table names", function () {
    expect(normalizeSQLiteIdentifier("MiXeD_Ä")).toBe("mixed_Ä");
    expect(
      chooseSQLiteRecreationTableName(
        "users",
        new Set(["_users_new", "_UsErS_NeW_2"])
      )
    ).toBe("_users_new_3");
    expect(
      isSQLiteRecreationTableStatement(
        'CREATE TABLE "_users_new_3" (id INTEGER);'
      )
    ).toBe(true);
    expect(
      isSQLiteRecreationTableStatement(
        'CREATE VIRTUAL TABLE "_search_new_2" USING fts5(value);'
      )
    ).toBe(true);
    expect(
      isSQLiteRecreationTableStatement(
        'CREATE TABLE "_users_new_backup" (id INTEGER);'
      )
    ).toBe(false);
    expect(
      hasSQLiteTableRecreation([
        'CREATE TABLE "_users_new_3" (id INTEGER);',
        'ALTER TABLE "_UsErS_NeW_3" RENAME TO "users";',
      ])
    ).toBe(true);
    expect(
      hasSQLiteTableRecreation([
        'CREATE TABLE "_users_new_3" (id INTEGER);',
      ])
    ).toBe(false);
  });

  test("canonicalizes only actual foreign key target lists", function () {
    expect(
      removeSQLiteForeignKeyTargetColumns(
        `FOREIGN KEY (parent_id) REFERENCES "parents" /* target */ ("id") ON DELETE CASCADE`
      )
    ).toBe(
      `FOREIGN KEY (parent_id) REFERENCES "parents" ON DELETE CASCADE`
    );
    expect(
      removeSQLiteForeignKeyTargetColumns(
        `CHECK (note = 'REFERENCES parents(id)')`
      )
    ).toBe(`CHECK (note = 'REFERENCES parents(id)')`);
  });

  test("extracts only declared column collations", function () {
    const collations = extractSQLiteColumnCollations(`
      CREATE TABLE examples (
        "name" TEXT /* declared */ COLLATE [NOCASE],
        note TEXT DEFAULT ('COLLATE RTRIM'),
        CHECK (note COLLATE RTRIM <> '')
      )
    `);
    expect(Array.from(collations.entries())).toEqual([["name", "NOCASE"]]);
  });

  test("recognizes exact SQLite rowid alias column definitions", function () {
    expect(
      isSQLiteRowidAliasColumnDefinition(
        `"id" /* type */ [INTEGER] CONSTRAINT pk PRIMARY KEY ASC`
      )
    ).toBe(true);
    expect(
      isSQLiteRowidAliasColumnDefinition(`id INTEGER`)
    ).toBe(true);
    expect(
      isSQLiteRowidAliasColumnDefinition(`id INT PRIMARY KEY`)
    ).toBe(false);
    expect(
      isSQLiteRowidAliasColumnDefinition(`id INTEGER PRIMARY KEY DESC`)
    ).toBe(false);
    expect(
      isSQLiteRowidAliasColumnDefinition(`id INTEGER(8) PRIMARY KEY`)
    ).toBe(false);
    expect(
      isSQLiteRowidAliasColumnDefinition(`id TEXT PRIMARY KEY`)
    ).toBe(false);
  });

  test("canonicalizes only supported foreign key match clauses", function () {
    expect(
      extractSQLiteForeignKeyMatchClauses(`
        CREATE TABLE children (
          note TEXT CHECK (note <> 'MATCH FULL'),
          first_parent_id INTEGER
            REFERENCES parents(id) MATCH /* semantics */ SIMPLE
            CONSTRAINT match CHECK (first_parent_id > 0),
          second_parent_id INTEGER COLLATE "MATCH"
            REFERENCES parents(id) MATCH [FULL]
        )
      `)
    ).toEqual(["SIMPLE", "FULL"]);
    expect(
      removeSQLiteForeignKeyMatchSimpleClauses(
        "FOREIGN KEY (parent_id) REFERENCES parents(id) " +
        "MATCH /* semantics */ SIMPLE ON DELETE CASCADE"
      )
    ).toBe(
      "FOREIGN KEY (parent_id) REFERENCES parents(id)  ON DELETE CASCADE"
    );
    expect(
      removeSQLiteForeignKeyMatchSimpleClauses(
        "FOREIGN KEY (parent_id) REFERENCES parents(id) MATCH FULL"
      )
    ).toBe("FOREIGN KEY (parent_id) REFERENCES parents(id) MATCH FULL");
  });

  test("canonicalizes SQLite identifiers with ASCII-only folding", function () {
    expect(
      canonicalizeSQLiteDefinitionIdentifiers(
        `FOREIGN KEY ("AccountID") REFERENCES Accounts("ID") ` +
        `CHECK (note <> 'ID' AND note <> "literal")`,
        ["accountid", "accounts", "id", "note"]
      )
    ).toBe(
      `foreign key ("accountid") references "accounts"("id") ` +
      `check ("note" <> 'ID' and "note" <> "literal")`
    );
    expect(
      canonicalizeSQLiteDefinitionIdentifiers(
        `REFERENCES "Äccounts"("ID") REFERENCES "äccounts"("id")`,
        ["Äccounts", "äccounts", "id"]
      )
    ).toBe(
      `references "Äccounts"("id") references "äccounts"("id")`
    );
    expect(
      normalizeSQLiteSchemaDefinition(
        `CREATE  VIEW "StatusView" AS -- comment with 'quote'\n` +
          ` SELECT "ID", 'A   B' FROM "Users"`,
        ["statusview", "id", "users"]
      )
    ).toBe(
      `create view "statusview" as select "id", 'A   B' from "users"`
    );
  });

  test("collects identifiers used by SQLite schema objects", function () {
    const identifiers = collectSQLiteSchemaIdentifiers(
      [makeTable({
        name: "Users",
        columns: [{
          name: "ID",
          type: "INTEGER",
          nullable: false,
          collation: { name: "NoCase" },
        }],
        primaryKey: { name: "Users_PK", columns: ["ID"] },
        indexes: [{
          name: "Users_ID_IDX",
          tableName: "Users",
          columns: ["ID"],
          terms: [{ column: "ID", collation: "NoCase" }],
        }],
      })],
      [{
        name: "ActiveUsers",
        definition: "SELECT ID FROM Users",
        columnNames: ["SelectedUser"],
      }],
      [{
        name: "Users_Insert",
        tableName: "Users",
        timing: "AFTER",
        events: ["INSERT"],
        functionName: "",
      }]
    );

    expect(identifiers).toEqual(expect.arrayContaining([
      "new",
      "old",
      "Users",
      "ID",
      "NoCase",
      "Users_PK",
      "Users_ID_IDX",
      "ActiveUsers",
      "SelectedUser",
      "Users_Insert",
    ]));
  });

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
      { name: "value", type: "INTEGER", nullable: true, default: "2" },
      ["value"]
    )).toBe(true);

    const createTable = differ.generateCreateTable(
      makeTable({
        columns: [{
          name: "id",
          type: "TEXT",
          nullable: false,
          collation: { name: "NOCASE" },
        }],
        uniqueConstraints: [{
          name: "users_id_unique",
          columns: ["id"],
          collations: ["NOCASE"],
        }],
      })
    ) as string;
    expect(createTable).toContain(`"id" TEXT COLLATE "NOCASE" NOT NULL`);
    expect(createTable).toContain(
      `CONSTRAINT "users_id_unique" UNIQUE ("id" COLLATE "NOCASE")`
    );

    const createIndex = differ.generateCreateIndex({
      name: "idx_users_active",
      tableName: "users",
      columns: ["id"],
      where: "id > 0",
    }) as string;
    expect(createIndex).toContain("WHERE id > 0");

    const addColumn = differ.generateAddColumn(makeTable(), {
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
      'INSERT INTO "_users_new" ("rowid", "id") ' +
      'SELECT "rowid", "id" FROM "users";'
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

    expect(
      differ.columnsDiffer(baseColumn, changedColumn, ["display", "value"])
    ).toBe(true);
  });

  test("compares structured index terms and reuses lossless index SQL", function () {
    const differ = new SQLiteDiffer() as any;
    const createStatement = `CREATE INDEX "search index" ON users(
      lower(name || 'a   b') COLLATE NOCASE DESC
    ) WHERE active = 1`;
    const baseIndex = {
      name: "search index",
      tableName: "users",
      columns: [],
      unique: false,
      terms: [{
        expression: "lower(name || 'a   b')",
        collation: "NOCASE",
        order: "DESC",
      }],
      where: "active = 1",
      createStatement,
    };

    expect(differ.generateCreateIndex(baseIndex)).toBe(`${createStatement};`);
    const identifiers = ["users", "name", "active"];
    expect(differ.indexesDiffer(baseIndex, {
      ...baseIndex,
      terms: [{
        expression: "lower(name   ||   'a   b')",
        collation: "nocase",
        order: "DESC",
      }],
      where: "active   =   1",
    }, identifiers)).toBe(false);
    expect(differ.indexesDiffer(baseIndex, {
      ...baseIndex,
      terms: [{
        expression: "lower(name || 'a b')",
        collation: "NOCASE",
        order: "DESC",
      }],
    }, identifiers)).toBe(true);
  });

  test("compares lossless SQLite table definitions without blocking additive columns", function () {
    const differ = new SQLiteDiffer() as any;
    const current = makeTable({
      createStatement: "CREATE TABLE users(id INTEGER COLLATE BINARY, CONSTRAINT named CHECK(id > 0))",
      strict: false,
      withoutRowid: false,
    });
    const additive = makeTable({
      columns: [
        ...makeTable().columns,
        { name: "label", type: "TEXT", nullable: true },
      ],
      createStatement: "CREATE TABLE users(id INTEGER COLLATE BINARY, label TEXT COLLATE NOCASE, CONSTRAINT named CHECK(id > 0))",
      strict: false,
      withoutRowid: false,
    });
    const identifiers = [
      "users",
      "id",
      "label",
      "binary",
      "nocase",
      "named",
      "renamed",
    ];

    expect(
      differ.tableDefinitionsDiffer(additive, current, identifiers)
    ).toBe(false);
    expect(differ.tableDefinitionsDiffer({
      ...current,
      createStatement: "CREATE TABLE users(id INTEGER COLLATE NOCASE, CONSTRAINT named CHECK(id > 0))",
    }, current, identifiers)).toBe(true);
    expect(differ.tableDefinitionsDiffer({
      ...current,
      createStatement: "CREATE TABLE users(id INTEGER COLLATE BINARY, CONSTRAINT renamed CHECK(id > 0))",
    }, current, identifiers)).toBe(true);
    expect(differ.tableOptionsDiffer({ ...current, strict: true }, current)).toBe(true);
    expect(differ.tableOptionsDiffer({
      ...current,
      autoincrementColumns: ["id"],
    }, current)).toBe(true);

    const sequenceSql = differ.generateSequencePreservation("user's", "_user's_new");
    expect(sequenceSql.join("\n")).toContain("'user''s'");
    expect(sequenceSql.join("\n")).toContain("'_user''s_new'");
  });

  test("canonicalizes virtual table names without hiding module changes", function () {
    const differ = new SQLiteDiffer() as any;
    const desired = makeTable({
      name: "search docs",
      virtual: true,
      createStatement: "CREATE VIRTUAL TABLE `search docs` USING fts5(title, tokenize='porter')",
    });
    const current = makeTable({
      name: "search docs",
      virtual: true,
      createStatement: `CREATE VIRTUAL TABLE "search docs" USING fts5(title, tokenize='porter')`,
    });

    const identifiers = ["search docs", "title"];
    expect(
      differ.tableDefinitionsDiffer(desired, current, identifiers)
    ).toBe(false);
    expect(differ.tableDefinitionsDiffer({
      ...desired,
      createStatement: "CREATE VIRTUAL TABLE `search docs` USING fts5(title, tokenize='unicode61')",
    }, current, identifiers)).toBe(true);
  });
});
