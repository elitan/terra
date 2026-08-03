import { describe, expect, test } from "bun:test";
import { SQLiteClient } from "../../providers/sqlite/client";

describe("SQLiteClient coverage", () => {
  test("covers select pragma write raw and close paths", async function () {
    const client = await SQLiteClient.create({ dialect: "sqlite", filename: ":memory:" } as any);

    expect(client.raw).toBeDefined();

    await client.query("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    await client.query("INSERT INTO users (id, name) VALUES (?, ?)", [1, "johan"]);

    const selected = await client.query<{ id: number; name: string }>(
      "SELECT id, name FROM users WHERE id = ?",
      [1]
    );
    expect(selected.rows).toEqual([{ id: 1, name: "johan" }]);

    const pragma = await client.query<{ name: string }>("PRAGMA table_info(users)");
    expect(pragma.rows.length).toBeGreaterThan(0);

    const plan = await client.query<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT id FROM users WHERE id = ?",
      [1]
    );
    expect(plan.rows[0]?.detail).toContain("INTEGER PRIMARY KEY");

    client.execMultiple("INSERT INTO users (id, name) VALUES (2, 'other');");
    const txCount = client.inTransaction(function () {
      return client.raw.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
    });
    expect(txCount.count).toBe(2);

    await client.end();
  });
});
