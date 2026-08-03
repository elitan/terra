import { describe, expect, test } from "bun:test";
import { SQLiteInspector } from "../../providers/sqlite/inspector";
import { parseSQLiteTriggerMetadata } from "../../providers/sqlite/sql-parser-utils";

function createMockClient(
  handler: (sql: string, params?: unknown[]) => { rows: unknown[] }
): any {
  return {
    query: async (sql: string, params?: unknown[]) => handler(sql, params),
  };
}

describe("SQLiteInspector unit coverage", () => {
  test("parses schema branches for indexes, constraints, and defaults", async () => {
    const inspector = new SQLiteInspector();
    const client = createMockClient((sql, params) => {
      if (sql.includes("FROM sqlite_master") && sql.includes("type = 'table'") && sql.includes("name NOT LIKE")) {
        return {
          rows: [
            {
              type: "table",
              name: "users",
              tbl_name: "users",
              sql: "CREATE TABLE users (id INT, age INT CHECK(age > 0), CHECK (id > 0))",
            },
          ],
        };
      }

      if (sql.includes('PRAGMA table_xinfo("users")')) {
        return {
          rows: [
            { cid: 0, name: "id", type: "INT", notnull: 0, dflt_value: null, pk: 1 },
            { cid: 1, name: "email", type: "TEXT", notnull: 0, dflt_value: "'x'", pk: 0 },
          ],
        };
      }

      if (sql === "PRAGMA table_list") {
        return {
          rows: [
            { schema: "main", name: "users", type: "table", wr: 0, strict: 0 },
          ],
        };
      }

      if (sql.includes('PRAGMA foreign_key_list("users")')) {
        return {
          rows: [
            {
              id: 0,
              seq: 0,
              table: "accounts",
              from: "id",
              to: "id",
              on_update: "RESTRICT",
              on_delete: "SET DEFAULT",
              match: "NONE",
            },
            {
              id: 1,
              seq: 0,
              table: "profiles",
              from: "email",
              to: "email",
              on_update: "UNKNOWN_ACTION",
              on_delete: "CASCADE",
              match: "NONE",
            },
          ],
        };
      }

      if (sql.includes('PRAGMA index_list("users")')) {
        return {
          rows: [
            { seq: 0, name: "sqlite_autoindex_users_1", unique: 1, origin: "u", partial: 0 },
            { seq: 1, name: "idx_users_email", unique: 1, origin: "c", partial: 0 },
            { seq: 2, name: "idx_users_pk_custom", unique: 1, origin: "pk", partial: 0 },
            { seq: 3, name: "idx_users_partial", unique: 0, origin: "c", partial: 1 },
          ],
        };
      }

      if (sql.includes('PRAGMA index_info("sqlite_autoindex_users_1")')) {
        return { rows: [{ seqno: 0, cid: 1, name: "email" }] };
      }

      if (sql.includes('PRAGMA index_info("idx_users_email")')) {
        return { rows: [{ seqno: 0, cid: 1, name: "email" }] };
      }

      if (sql.includes('PRAGMA index_xinfo("idx_users_email")')) {
        return {
          rows: [
            { seqno: 0, cid: 1, name: "email", desc: 0, coll: "BINARY", key: 1 },
            { seqno: 1, cid: -1, name: null, desc: 0, coll: "BINARY", key: 0 },
          ],
        };
      }

      if (sql.includes('PRAGMA index_info("idx_users_pk_custom")')) {
        return { rows: [{ seqno: 0, cid: 0, name: "id" }] };
      }

      if (sql.includes('PRAGMA index_info("idx_users_partial")')) {
        return { rows: [{ seqno: 0, cid: 1, name: "email" }] };
      }

      if (sql.includes('PRAGMA index_xinfo("idx_users_partial")')) {
        return {
          rows: [
            { seqno: 0, cid: 1, name: "email", desc: 0, coll: "BINARY", key: 1 },
            { seqno: 1, cid: -1, name: null, desc: 0, coll: "BINARY", key: 0 },
          ],
        };
      }

      if (sql.includes("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")) {
        if (params?.[0] === "idx_users_email") {
          return {
            rows: [
              {
                type: "index",
                name: "idx_users_email",
                tbl_name: "users",
                sql: "CREATE UNIQUE INDEX idx_users_email ON users(email)",
              },
            ],
          };
        }
        if (params?.[0] === "idx_users_partial") {
          return {
            rows: [
              {
                type: "index",
                name: "idx_users_partial",
                tbl_name: "users",
                sql: "CREATE INDEX idx_users_partial ON users(email) WHERE email IS NOT NULL",
              },
            ],
          };
        }
      }

      if (sql.includes("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")) {
        return {
          rows: [
            {
              type: "table",
              name: "users",
              tbl_name: "users",
              sql: "CREATE TABLE users (id INT, age INT CHECK(age > 0), CHECK (id > 0))",
            },
          ],
        };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const tables = await inspector.getCurrentSchema(client);
    expect(tables).toHaveLength(1);

    const users = tables[0]!;
    expect(users.primaryKey).toEqual({ columns: ["id"] });
    expect(users.columns[0]?.type).toBe("INTEGER");
    expect(users.columns[1]?.default).toBe("'x'");
    expect(users.foreignKeys).toHaveLength(2);
    expect(users.foreignKeys?.[0]?.onDelete).toBe("SET DEFAULT");
    expect(users.foreignKeys?.[0]?.onUpdate).toBe("RESTRICT");
    expect(users.foreignKeys?.[1]?.onUpdate).toBe("NO ACTION");
    expect(users.uniqueConstraints).toEqual([{ columns: ["email"] }]);
    expect(users.indexes).toEqual([
      {
        name: "idx_users_email",
        tableName: "users",
        columns: ["email"],
        unique: true,
        type: "btree",
        sortOrders: ["ASC"],
        terms: [{ column: "email", collation: "BINARY", order: "ASC" }],
        createStatement: "CREATE UNIQUE INDEX idx_users_email ON users(email)",
      },
      {
        name: "idx_users_partial",
        tableName: "users",
        columns: ["email"],
        unique: false,
        type: "btree",
        sortOrders: ["ASC"],
        terms: [{ column: "email", collation: "BINARY", order: "ASC" }],
        createStatement: "CREATE INDEX idx_users_partial ON users(email) WHERE email IS NOT NULL",
        where: "email IS NOT NULL",
      },
    ]);
    expect(users.checkConstraints).toEqual([
      { expression: "age > 0" },
      { expression: "id > 0" },
    ]);
  });

  test("handles empty primary key and missing table sql", async () => {
    const inspector = new SQLiteInspector();
    const client = createMockClient((sql, params) => {
      if (sql.includes("FROM sqlite_master") && sql.includes("type = 'table'") && sql.includes("name NOT LIKE")) {
        return {
          rows: [{ type: "table", name: "logs", tbl_name: "logs", sql: null }],
        };
      }

      if (sql.includes('PRAGMA table_xinfo("logs")')) {
        return {
          rows: [{ cid: 0, name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 }],
        };
      }
      if (sql === "PRAGMA table_list") {
        return {
          rows: [
            { schema: "main", name: "logs", type: "table", wr: 0, strict: 0 },
          ],
        };
      }

      if (sql.includes('PRAGMA foreign_key_list("logs")')) {
        return { rows: [] };
      }

      if (sql.includes('PRAGMA index_list("logs")')) {
        return { rows: [] };
      }

      if (sql.includes("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")) {
        expect(params).toEqual(["logs"]);
        return { rows: [{ type: "table", name: "logs", tbl_name: "logs", sql: null }] };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const tables = await inspector.getCurrentSchema(client);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.primaryKey).toBeUndefined();
    expect(tables[0]?.checkConstraints).toBeUndefined();
    expect(tables[0]?.uniqueConstraints).toBeUndefined();
  });

  test("distinguishes generated columns from virtual-table hidden columns", function () {
    const inspector = new SQLiteInspector() as any;
    const columns = inspector.getColumns(
      [
        { cid: 0, name: "base", type: "INT", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
        { cid: 1, name: "dynamic", type: "INT", notnull: 0, dflt_value: null, pk: 0, hidden: 2 },
        { cid: 2, name: "materialized", type: "INT", notnull: 1, dflt_value: null, pk: 0, hidden: 3 },
        { cid: 3, name: "internal", type: "", notnull: 0, dflt_value: null, pk: 0, hidden: 1 },
      ],
      "computed",
      "CREATE TABLE computed (base INT, dynamic INT AS (base + 1), materialized INT AS ((base * 2) + abs(base)) STORED NOT NULL)"
    );

    expect(columns).toEqual([
      {
        name: "base",
        type: "INTEGER",
        nullable: true,
        default: undefined,
        generated: undefined,
      },
      {
        name: "dynamic",
        type: "INTEGER",
        nullable: true,
        default: undefined,
        generated: {
          always: true,
          expression: "base + 1",
          stored: false,
        },
      },
      {
        name: "materialized",
        type: "INTEGER",
        nullable: false,
        default: undefined,
        generated: {
          always: true,
          expression: "(base * 2) + abs(base)",
          stored: true,
        },
      },
    ]);

    expect(function () {
      inspector.getColumns(
        [{ cid: 0, name: "lost", type: "INT", notnull: 0, dflt_value: null, pk: 0, hidden: 2 }],
        "computed",
        "CREATE TABLE computed (base INT)"
      );
    }).toThrow("Unable to inspect generated expression");
  });

  test("parses view and trigger metadata", async () => {
    const inspector = new SQLiteInspector();
    const client = createMockClient((sql) => {
      if (sql.includes("FROM sqlite_master") && sql.includes("type = 'view'")) {
        return {
          rows: [
            { type: "view", name: "v_users", tbl_name: "v_users", sql: "CREATE VIEW v_users AS SELECT id FROM users" },
            { type: "view", name: "v_empty", tbl_name: "v_empty", sql: null },
          ],
        };
      }

      if (sql.includes("FROM sqlite_master") && sql.includes("type = 'trigger'")) {
        return {
          rows: [
            {
              type: "trigger",
              name: "trg_users",
              tbl_name: "users",
              sql: "CREATE TRIGGER trg_users INSTEAD OF UPDATE OF name ON users BEGIN INSERT INTO audit VALUES (NEW.id); DELETE FROM stale_audit; END;",
            },
            {
              type: "trigger",
              name: "trg_default",
              tbl_name: "users",
              sql: null,
            },
            {
              type: "trigger",
              name: "after",
              tbl_name: "users",
              sql: 'CREATE TRIGGER IF NOT EXISTS main."after" /* header DELETE */ DELETE ON users BEGIN UPDATE users SET name = OLD.name; END;',
            },
          ],
        };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const views = await inspector.getCurrentViews(client);
    expect(views).toEqual([
      {
        name: "v_users",
        definition: "SELECT id FROM users",
        createStatement: "CREATE VIEW v_users AS SELECT id FROM users",
      },
      { name: "v_empty", definition: "", createStatement: undefined },
    ]);

    const triggers = await inspector.getCurrentTriggers(client);
    expect(triggers).toEqual([
      {
        name: "trg_users",
        tableName: "users",
        timing: "INSTEAD OF",
        events: ["UPDATE"],
        functionName: "",
        definition: "CREATE TRIGGER trg_users INSTEAD OF UPDATE OF name ON users BEGIN INSERT INTO audit VALUES (NEW.id); DELETE FROM stale_audit; END",
      },
      {
        name: "trg_default",
        tableName: "users",
        timing: "BEFORE",
        events: [],
        functionName: "",
        definition: "",
      },
      {
        name: "after",
        tableName: "users",
        timing: "BEFORE",
        events: ["DELETE"],
        functionName: "",
        definition: 'CREATE TRIGGER IF NOT EXISTS main."after" /* header DELETE */ DELETE ON users BEGIN UPDATE users SET name = OLD.name; END',
      },
    ]);
  });
});

describe("SQLite trigger header parser", function () {
  test("parses timing and event across valid SQLite header variants", function () {
    expect(
      parseSQLiteTriggerMetadata(
        "CREATE TEMPORARY TRIGGER `insert` AFTER DELETE ON users BEGIN INSERT INTO audit VALUES (1); END"
      )
    ).toEqual({ timing: "AFTER", events: ["DELETE"] });
    expect(
      parseSQLiteTriggerMetadata(
        "CREATE TEMP TRIGGER [delete] BEFORE INSERT ON users BEGIN DELETE FROM audit; END"
      )
    ).toEqual({ timing: "BEFORE", events: ["INSERT"] });
    expect(
      parseSQLiteTriggerMetadata(
        "CREATE TRIGGER 'update' INSTEAD /* comment */ OF UPDATE OF name ON users BEGIN SELECT 1; END"
      )
    ).toEqual({ timing: "INSTEAD OF", events: ["UPDATE"] });
    expect(
      parseSQLiteTriggerMetadata(
        "CREATE -- header comment\nTRIGGER plain DELETE ON users BEGIN UPDATE users SET id = id; END"
      )
    ).toEqual({ timing: "BEFORE", events: ["DELETE"] });
  });

  test("returns safe metadata for absent or malformed headers", function () {
    const malformedHeaders = [
      "",
      "SELECT 1",
      "CREATE VIEW example AS SELECT 1",
      "CREATE TRIGGER",
      "CREATE TRIGGER IF EXISTS example INSERT ON users BEGIN SELECT 1; END",
      "CREATE TRIGGER IF NOT example INSERT ON users BEGIN SELECT 1; END",
      "CREATE TRIGGER main. INSERT ON users BEGIN SELECT 1; END",
      "CREATE TRIGGER example INSTEAD INSERT ON users BEGIN SELECT 1; END",
      "CREATE TRIGGER example DURING INSERT ON users BEGIN SELECT 1; END",
      "CREATE /* unterminated comment",
      'CREATE TRIGGER "unterminated',
    ];

    for (const sql of malformedHeaders) {
      expect(parseSQLiteTriggerMetadata(sql)).toEqual({
        timing: "BEFORE",
        events: [],
      });
    }
  });
});
