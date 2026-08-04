import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SchemaService } from "../../core/schema/service";
import { SQLiteProvider } from "../../providers/sqlite";
import { SQLiteParser } from "../../providers/sqlite/parser";
import type { SQLiteConnectionConfig } from "../../providers/types";
import { ParserError } from "../../types/errors";

describe("SQLiteParser execution-runtime parity", function () {
  test("parses tables, indexes, checks, views, and triggers", async function () {
    const parser = new SQLiteParser();
    const schema = await parser.parseSchema(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        age INTEGER CHECK ((age IS NULL) OR (abs(age) < 120))
      );
      CREATE TABLE user_audit (user_id INTEGER, action TEXT);
      CREATE UNIQUE INDEX idx_users_name ON users (name);
      CREATE VIEW adult_users AS SELECT id, name FROM users WHERE age >= 18;
      CREATE TRIGGER trg_users_insert
        AFTER INSERT ON users
        BEGIN
          UPDATE users SET name = trim(NEW.name) WHERE id = NEW.id;
        END;
      CREATE TRIGGER trg_users_update
        UPDATE OF name ON users
        BEGIN
          INSERT INTO user_audit (user_id, action) VALUES (NEW.id, 'update');
        END;
    `);

    expect(schema.tables).toHaveLength(2);
    const users = schema.tables.find(function (table) {
      return table.name === "users";
    });
    expect(users?.indexes).toEqual([
      {
        name: "idx_users_name",
        tableName: "users",
        columns: ["name"],
        unique: true,
        type: "btree",
        sortOrders: ["ASC"],
        terms: [{ column: "name", collation: "BINARY", order: "ASC" }],
        createStatement: "CREATE UNIQUE INDEX idx_users_name ON users (name)",
      },
    ]);
    expect(users?.checkConstraints).toEqual([
      { expression: "(age IS NULL) OR (abs(age) < 120)" },
    ]);
    expect(schema.views).toEqual([
      {
        name: "adult_users",
        definition: "SELECT id, name FROM users WHERE age >= 18",
        createStatement: "CREATE VIEW adult_users AS SELECT id, name FROM users WHERE age >= 18",
        columnNames: ["id", "name"],
      },
    ]);
    expect(schema.triggers).toHaveLength(2);
    expect(schema.triggers[0]).toMatchObject({
      name: "trg_users_insert",
      timing: "AFTER",
      events: ["INSERT"],
    });
    expect(schema.triggers[0]?.definition).toContain("UPDATE users SET name");
    expect(schema.triggers[1]).toMatchObject({
      name: "trg_users_update",
      timing: "BEFORE",
      events: ["UPDATE"],
    });
  });

  test("includes the schema path in runtime syntax errors", async function () {
    const parser = new SQLiteParser();

    try {
      await parser.parseSchema("CREATE TABLE broken (id INTEGER", "schema.sql");
      throw new Error("expected schema parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ParserError);
      expect((error as ParserError).filePath).toBe("schema.sql");
    }
  });

  test("rejects connection-local temporary schema objects", async function () {
    const parser = new SQLiteParser();
    const schemas = [
      "CREATE TEMP TABLE session_cache (id INTEGER);",
      `CREATE TABLE users (id INTEGER);
       CREATE TEMP VIEW current_users AS SELECT id FROM users;`,
      `CREATE TABLE users (id INTEGER);
       CREATE TEMP TRIGGER users_insert AFTER INSERT ON users BEGIN
         SELECT NEW.id;
       END;`,
      "CREATE VIRTUAL TABLE temp.search_docs USING fts5(body);",
    ];

    for (const sql of schemas) {
      await expect(parser.parseSchema(sql, "temporary.sql")).rejects.toThrow(
        "Temporary SQLite schema objects are not supported"
      );
    }
  });

  test("rejects external-database statements before they can write files", async function () {
    const parser = new SQLiteParser();
    const attachedPath = path.join(
      os.tmpdir(),
      `terradb-parser-attached-${Date.now()}.db`
    );
    const vacuumPath = path.join(
      os.tmpdir(),
      `terradb-parser-vacuum-${Date.now()}.db`
    );
    const sqlPath = attachedPath.replace(/'/g, "''");
    const vacuumSqlPath = vacuumPath.replace(/'/g, "''");

    try {
      await expect(parser.parseSchema(
        `attach database '${sqlPath}' AS auxiliary;
         CREATE TABLE auxiliary.users (id INTEGER);`,
        "attached.sql"
      )).rejects.toThrow("ATTACH is not supported in SQLite desired schemas");
      expect(fs.existsSync(attachedPath)).toBe(false);
      await expect(parser.parseSchema(
        `CREATE TABLE users (id INTEGER);
         VACUUM INTO '${vacuumSqlPath}';`,
        "vacuum.sql"
      )).rejects.toThrow("VACUUM is not supported in SQLite desired schemas");
      expect(fs.existsSync(vacuumPath)).toBe(false);
      await expect(
        parser.parseSchema("DETACH DATABASE auxiliary;", "detached.sql")
      ).rejects.toThrow("DETACH is not supported in SQLite desired schemas");
    } finally {
      if (fs.existsSync(attachedPath)) {
        fs.unlinkSync(attachedPath);
      }
      if (fs.existsSync(vacuumPath)) {
        fs.unlinkSync(vacuumPath);
      }
    }
  });

  test("does not mistake comments identifiers or literals for ATTACH statements", async function () {
    const parser = new SQLiteParser();
    const schema = await parser.parseSchema(`
      -- ATTACH DATABASE 'ignored.db' AS auxiliary;
      CREATE TABLE "attach" (
        "detach" TEXT DEFAULT 'ATTACH DATABASE literal AS auxiliary'
      );
      CREATE TABLE audit_log (message TEXT);
      CREATE TRIGGER log_attach
        AFTER INSERT ON "attach"
        BEGIN
          INSERT INTO audit_log(message)
          VALUES (CASE WHEN NEW."detach" IS NULL THEN 'DETACH auxiliary' ELSE 'value' END);
          UPDATE audit_log SET message = trim(message);
        END;
    `);

    expect(schema.tables.map(function (table) {
      return table.name;
    })).toEqual(["attach", "audit_log"]);
    expect(schema.triggers.map(function (trigger) {
      return trigger.name;
    })).toEqual(["log_attach"]);
  });

  test("rejects imperative top-level statements in declarative schemas", async function () {
    const parser = new SQLiteParser();
    const statements = [
      ["ALTER TABLE users ADD COLUMN name TEXT;", "ALTER"],
      ["ANALYZE;", "ANALYZE"],
      ["BEGIN TRANSACTION;", "BEGIN"],
      ["COMMIT;", "COMMIT"],
      ["DELETE FROM users;", "DELETE"],
      ["DROP TABLE users;", "DROP"],
      ["END TRANSACTION;", "END"],
      ["EXPLAIN SELECT 1;", "EXPLAIN"],
      ["INSERT INTO users(id) VALUES (1);", "INSERT"],
      ["PRAGMA user_version = 1;", "PRAGMA"],
      ["REINDEX;", "REINDEX"],
      ["RELEASE savepoint_name;", "RELEASE"],
      ["REPLACE INTO users(id) VALUES (1);", "REPLACE"],
      ["ROLLBACK;", "ROLLBACK"],
      ["SAVEPOINT savepoint_name;", "SAVEPOINT"],
      ["SELECT 1;", "SELECT"],
      ["UPDATE users SET id = 2;", "UPDATE"],
      ["VALUES (1);", "VALUES"],
      ["WITH value(x) AS (VALUES (1)) SELECT x FROM value;", "WITH"],
    ];

    for (const [sql, keyword] of statements) {
      await expect(parser.parseSchema(sql, "imperative.sql")).rejects.toThrow(
        `${keyword} is not supported in SQLite desired schemas`
      );
    }
  });

  test("rejects every query-derived table spelling", async function () {
    const parser = new SQLiteParser();
    const schemas = [
      "CREATE TABLE derived AS SELECT 1 AS id;",
      `CREATE TABLE IF NOT EXISTS main."Derived Table"
         AS WITH seed(value) AS (VALUES (2)) SELECT value FROM seed;`,
      "CREATE TABLE [values table] AS VALUES (3), (4);",
      `CREATE /* comment */ TEMPORARY TABLE \`session derived\`
         AS SELECT 5 UNION ALL SELECT 6;`,
    ];

    for (const sql of schemas) {
      await expect(
        parser.parseSchema(sql, "query-derived.sql")
      ).rejects.toMatchObject({
        code: "PARSER_ERROR",
        filePath: "query-derived.sql",
        message: expect.stringContaining(
          "CREATE TABLE AS SELECT is not supported"
        ),
      });
    }
  });

  test("does not mistake valid AS clauses, comments, or literals for query-derived tables", async function () {
    const parser = new SQLiteParser();
    const schema = await parser.parseSchema(`
      -- CREATE TABLE ignored AS SELECT 1;
      CREATE TABLE ordinary (
        id INTEGER,
        "as" TEXT DEFAULT 'CREATE TABLE literal AS SELECT 1'
      );
      CREATE TABLE generated_values (
        base INTEGER,
        derived INTEGER AS (base + 1)
      );
      CREATE TABLE audit_log (message TEXT);
      CREATE VIEW ordinary_view AS SELECT id FROM ordinary;
      CREATE TRIGGER ordinary_insert AFTER INSERT ON ordinary BEGIN
        INSERT INTO audit_log(message)
        VALUES ('CREATE TABLE trigger_literal AS SELECT 1');
      END;
    `);

    expect(schema.tables.map(function getTableName(table) {
      return table.name;
    })).toEqual(["audit_log", "generated_values", "ordinary"]);
    expect(schema.views.map(function getViewName(view) {
      return view.name;
    })).toEqual(["ordinary_view"]);
    expect(schema.triggers.map(function getTriggerName(trigger) {
      return trigger.name;
    })).toEqual(["ordinary_insert"]);
  });

  test("rejects query-derived tables before mutating file and shared-memory targets", async function () {
    const filePath = path.join(
      os.tmpdir(),
      `terradb-query-derived-${Date.now()}.db`
    );
    const memoryName = `terradb-query-derived-${Date.now()}`;
    const configs: SQLiteConnectionConfig[] = [
      { dialect: "sqlite", filename: filePath },
      {
        dialect: "sqlite",
        filename: `file:${memoryName}?mode=memory&cache=shared`,
      },
    ];

    try {
      for (const config of configs) {
        const provider = new SQLiteProvider();
        const keeper = await provider.createClient(config);
        try {
          await keeper.query(
            "CREATE TABLE marker (id INTEGER PRIMARY KEY, value TEXT)"
          );
          await keeper.query(
            "INSERT INTO marker(id, value) VALUES (1, 'preserved')"
          );
          const service = new SchemaService(provider, config);

          await expect(service.apply(`
            CREATE TABLE should_not_exist (id INTEGER);
            CREATE TABLE derived AS SELECT 7 AS id;
          `, ["public"], true)).rejects.toMatchObject({
            code: "PARSER_ERROR",
          });

          const tables = await provider.getCurrentSchema(keeper);
          expect(tables.map(function getTableName(table) {
            return table.name;
          })).toEqual(["marker"]);
          expect(
            (await keeper.query("SELECT id, value FROM marker")).rows
          ).toEqual([{ id: 1, value: "preserved" }]);
        } finally {
          await keeper.end();
        }
      }
    } finally {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });
});
