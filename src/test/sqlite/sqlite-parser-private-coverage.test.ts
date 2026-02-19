import { describe, expect, test } from "bun:test";
import { SQLiteParser } from "../../providers/sqlite/parser";

function createDb(handler: (sql: string) => any[]) {
  return {
    exec: function (sql: string) {
      return handler(sql);
    },
  };
}

describe("SQLiteParser private coverage", () => {
  test("parses index origins and unique constraints", () => {
    const parser = new SQLiteParser() as any;
    const db = createDb(function (sql: string) {
      if (sql.includes('PRAGMA index_list("users")')) {
        return [
          {
            values: [
              [0, "idx_users_pk", 1, "pk", 0],
              [1, "idx_users_email_unique", 1, "u", 0],
              [2, "idx_users_email", 0, "c", 1],
            ],
          },
        ];
      }

      if (sql.includes('PRAGMA index_info("idx_users_pk")')) {
        return [{ values: [[0, 0, "id"]] }];
      }

      if (sql.includes('PRAGMA index_info("idx_users_email_unique")')) {
        return [{ values: [[0, 1, "email"]] }];
      }

      if (sql.includes('PRAGMA index_info("idx_users_email")')) {
        return [{ values: [[0, 1, "email"]] }];
      }

      return [];
    });

    const indexes = parser.getIndexes(db, "users");
    expect(indexes).toEqual([
      {
        name: "idx_users_pk",
        tableName: "users",
        columns: ["id"],
        unique: true,
        type: "btree",
        constraint: { type: "p" },
      },
      {
        name: "idx_users_email_unique",
        tableName: "users",
        columns: ["email"],
        unique: true,
        type: "btree",
        constraint: { type: "u" },
      },
      {
        name: "idx_users_email",
        tableName: "users",
        columns: ["email"],
        unique: false,
        type: "btree",
      },
    ]);

    const uniques = parser.getUniqueConstraints(indexes);
    expect(uniques).toEqual([{ name: "idx_users_email_unique", columns: ["email"] }]);
  });

  test("parses check constraints and trigger metadata", async function () {
    const parser = new SQLiteParser() as any;

    const checkDb = createDb(function (sql: string) {
      if (sql.includes("SELECT sql FROM sqlite_master WHERE type = 'table'")) {
        return [{ values: [["CREATE TABLE users (age INT CHECK(age > 0), CHECK (age < 120))"]] }];
      }
      return [];
    });

    expect(parser.getCheckConstraints(checkDb, "users")).toEqual([
      { expression: "age > 0" },
      { expression: "age < 120" },
    ]);

    const triggerDb = createDb(function (sql: string) {
      if (sql.includes("WHERE type = 'trigger'")) {
        return [
          {
            values: [
              ["trg_users", "users", "CREATE TRIGGER trg_users AFTER INSERT OR UPDATE OR DELETE ON users BEGIN SELECT 1; END;"],
              ["trg_empty", "users", null],
            ],
          },
        ];
      }
      return [];
    });

    const triggers = await parser.extractTriggers(triggerDb);
    expect(triggers).toEqual([
      {
        name: "trg_users",
        tableName: "users",
        timing: "AFTER",
        events: ["INSERT", "UPDATE", "DELETE"],
        functionName: "",
      },
      {
        name: "trg_empty",
        tableName: "users",
        timing: "BEFORE",
        events: [],
        functionName: "",
      },
    ]);
  });
});
