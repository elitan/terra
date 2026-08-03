import { describe, expect, test } from "bun:test";
import { SQLiteParser } from "../../providers/sqlite/parser";
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
      },
    ]);
    expect(users?.checkConstraints).toEqual([
      { expression: "(age IS NULL) OR (abs(age) < 120)" },
    ]);
    expect(schema.views).toEqual([
      {
        name: "adult_users",
        definition: "SELECT id, name FROM users WHERE age >= 18",
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
});
