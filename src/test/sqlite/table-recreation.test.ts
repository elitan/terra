import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteProvider } from "../../providers/sqlite";
import { SchemaService } from "../../core/schema/service";
import type {
  DatabaseClient,
  SQLiteConnectionConfig,
} from "../../providers/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

async function getForeignKeysSetting(client: DatabaseClient): Promise<number> {
  const result = await client.query<{ foreign_keys: number }>(
    "PRAGMA foreign_keys"
  );
  return result.rows[0]?.foreign_keys ?? -1;
}

describe("SQLite Table Recreation", () => {
  let provider: SQLiteProvider;
  let dbPath: string;
  let config: SQLiteConnectionConfig;
  let schemaService: SchemaService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-recreation-${Date.now()}.db`);
    config = { dialect: "sqlite", filename: dbPath };
    provider = new SQLiteProvider();
    schemaService = new SchemaService(provider, config);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {}
  });

  test("should recreate table when column type changes", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age INTEGER
      );
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age TEXT
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    const ageCol = tables[0].columns.find(c => c.name === "age");
    expect(ageCol?.type).toBe("TEXT");
  });

  test("should recreate table when column is dropped", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT,
        email TEXT
      );
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].columns).toHaveLength(2);
    expect(tables[0].columns.find(c => c.name === "email")).toBeUndefined();
  });

  test("should preserve data during table recreation", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    await client.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`);
    await client.query(`INSERT INTO users (id, name) VALUES (2, 'Bob')`);
    await client?.end();

    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      );
    `, ['public'], true);

    const client2 = await provider.createClient(config);
    const result = await client2.query<{id: number, name: string}>(`SELECT id, name FROM users ORDER BY id`);
    await client2.end();

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].name).toBe("Alice");
    expect(result.rows[1].name).toBe("Bob");
  });

  test("should recreate referenced table with existing child rows", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age INTEGER
      );

      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `, ['public'], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(`INSERT INTO users (id, age) VALUES (1, 10)`);
    await seedClient.query(`INSERT INTO posts (id, user_id) VALUES (1, 1)`);
    await seedClient.end();

    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age TEXT
      );

      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const users = await client.query<{ id: number; age: string }>(`SELECT id, age FROM users ORDER BY id`);
    const posts = await client.query<{ id: number; user_id: number }>(`SELECT id, user_id FROM posts ORDER BY id`);
    const fkCheck = await client.query<{ table: string; rowid: number; parent: string; fkid: number }>(
      `PRAGMA foreign_key_check`
    );
    await client.end();

    expect(users.rows).toEqual([{ id: 1, age: "10" }]);
    expect(posts.rows).toEqual([{ id: 1, user_id: 1 }]);
    expect(fkCheck.rows).toEqual([]);
  });

  test("should enforce foreign keys after recreation migration", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age INTEGER
      );

      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `, ['public'], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(`INSERT INTO users (id, age) VALUES (1, 10)`);
    await seedClient.end();

    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age TEXT
      );

      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    await expect(
      client.query(`INSERT INTO posts (id, user_id) VALUES (2, 999)`)
    ).rejects.toThrow("FOREIGN KEY constraint failed");
    await client.end();
  });

  test("should restore the caller's foreign_keys setting after success and rollback", async function () {
    const initialSchema = `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age INTEGER
      );

      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `;
    const desired = await provider.parseSchema(
      initialSchema.replace("age INTEGER", "age TEXT")
    );

    for (const initialSetting of [0, 1]) {
      const client = await provider.createClient({
        dialect: "sqlite",
        filename: ":memory:",
      });
      await client.query("CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER)");
      await client.query(`
        CREATE TABLE posts (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
      await client.query("INSERT INTO users(id, age) VALUES (1, 10)");
      await client.query("INSERT INTO posts(id, user_id) VALUES (1, 1)");

      const current = await provider.getCurrentSchema(client);
      const migration = provider.generateMigrationPlan(desired.tables, current);
      await client.query(`PRAGMA foreign_keys = ${initialSetting}`);
      if (initialSetting === 0) {
        await client.query("UPDATE posts SET user_id = 999 WHERE id = 1");
      }

      await provider.executeInTransaction(client, migration.transactional);
      expect(await getForeignKeysSetting(client)).toBe(initialSetting);
      const violations = await client.query("PRAGMA foreign_key_check");
      expect(violations.rows).toHaveLength(initialSetting === 0 ? 1 : 0);

      const failingStatements = [...migration.transactional];
      failingStatements.splice(
        failingStatements.length - 1,
        0,
        "INSERT INTO missing_table DEFAULT VALUES;"
      );
      await expect(
        provider.executeInTransaction(client, failingStatements)
      ).rejects.toThrow("missing_table");
      expect(await getForeignKeysSetting(client)).toBe(initialSetting);

      if (initialSetting === 1) {
        const integrityFailureStatements = [...migration.transactional];
        integrityFailureStatements.splice(
          integrityFailureStatements.length - 1,
          0,
          "UPDATE posts SET user_id = 999 WHERE id = 1;"
        );
        await expect(
          provider.executeInTransaction(client, integrityFailureStatements)
        ).rejects.toThrow("Foreign key integrity check failed");
        expect(await getForeignKeysSetting(client)).toBe(1);
      }

      const rows = await client.query(`
        SELECT users.id, users.age, posts.user_id
        FROM users
        JOIN posts ON posts.id = users.id
        ORDER BY users.id
      `);
      expect(rows.rows).toEqual([
        {
          id: 1,
          age: "10",
          user_id: initialSetting === 0 ? 999 : 1,
        },
      ]);
      await client.end();
    }
  });

  test("should avoid collisions with user tables named like recreation artifacts", async function () {
    const initialSchema = `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        age INTEGER
      );

      CREATE TABLE "_users_new" (
        id INTEGER PRIMARY KEY,
        note TEXT NOT NULL
      );

      CREATE TABLE "_users_new_2" (
        id INTEGER PRIMARY KEY,
        note TEXT NOT NULL
      );

      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE INDEX "_UsErS_NeW_3" ON posts(user_id);

      CREATE TABLE audit_log (
        user_id INTEGER NOT NULL
      );

      CREATE VIEW user_ages AS
        SELECT id, age FROM users;

      CREATE TRIGGER users_insert_audit
      AFTER INSERT ON users
      BEGIN
        INSERT INTO audit_log(user_id) VALUES (NEW.id);
      END;
    `;
    const changedSchema = initialSchema.replace("age INTEGER", "age TEXT");

    await schemaService.apply(initialSchema, ["public"], true);
    const seedClient = await provider.createClient(config);
    await seedClient.query("INSERT INTO users(id, age) VALUES (1, 10)");
    await seedClient.query(
      'INSERT INTO "_users_new"(id, note) VALUES (?, ?)',
      [1, "keep me"]
    );
    await seedClient.query(
      'INSERT INTO "_users_new_2"(id, note) VALUES (?, ?)',
      [1, "keep me too"]
    );
    await seedClient.query("INSERT INTO posts(id, user_id) VALUES (1, 1)");
    await seedClient.end();

    const migration = await schemaService.apply(
      changedSchema,
      ["public"],
      true
    );
    expect(migration.transactional).toContainEqual(
      expect.stringMatching(/^CREATE TABLE "_users_new_4"/)
    );

    const client = await provider.createClient(config);
    await client.query("INSERT INTO users(id, age) VALUES (2, '20')");
    const users = await client.query("SELECT id, age FROM users ORDER BY id");
    const reservedNameTable = await client.query(
      'SELECT id, note FROM "_users_new"'
    );
    const secondReservedNameTable = await client.query(
      'SELECT id, note FROM "_users_new_2"'
    );
    const posts = await client.query("SELECT id, user_id FROM posts");
    const foreignKeyCheck = await client.query("PRAGMA foreign_key_check");
    const auditRows = await client.query(
      "SELECT user_id FROM audit_log ORDER BY user_id"
    );
    const viewRows = await client.query(
      "SELECT id, age FROM user_ages ORDER BY id"
    );
    const temporaryArtifacts = await client.query<{
      name: string;
      type: string;
    }>(`
      SELECT name, type
      FROM sqlite_master
      WHERE name = '_users_new_4'
    `);
    const reservedNameIndex = await client.query<{ name: string; type: string }>(`
      SELECT name, type
      FROM sqlite_master
      WHERE lower(name) = lower('_users_new_3')
    `);
    await client.end();

    expect(users.rows).toEqual([
      { id: 1, age: "10" },
      { id: 2, age: "20" },
    ]);
    expect(reservedNameTable.rows).toEqual([{ id: 1, note: "keep me" }]);
    expect(secondReservedNameTable.rows).toEqual([
      { id: 1, note: "keep me too" },
    ]);
    expect(posts.rows).toEqual([{ id: 1, user_id: 1 }]);
    expect(foreignKeyCheck.rows).toEqual([]);
    expect(auditRows.rows).toEqual([{ user_id: 1 }, { user_id: 2 }]);
    expect(viewRows.rows).toEqual([
      { id: 1, age: "10" },
      { id: 2, age: "20" },
    ]);
    expect(temporaryArtifacts.rows).toEqual([]);
    expect(reservedNameIndex.rows).toEqual([
      { name: "_UsErS_NeW_3", type: "index" },
    ]);
    expect((await schemaService.plan(changedSchema)).hasChanges).toBe(false);
  });

  test("should recreate table when primary key changes", async () => {
    await schemaService.apply(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        code TEXT
      );
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE items (
        id INTEGER,
        code TEXT PRIMARY KEY
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    expect(tables[0].primaryKey?.columns).toEqual(["code"]);
  });

  test("should recreate table when foreign key is added", async () => {
    await schemaService.apply(`
      CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);
    `, ['public'], true);

    await schemaService.apply(`
      CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        name TEXT,
        category_id INTEGER,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      );
    `, ['public'], true);

    const client = await provider.createClient(config);
    const tables = await provider.getCurrentSchema(client);
    await client?.end();

    const products = tables.find(t => t.name === "products");
    expect(products?.foreignKeys).toHaveLength(1);
    expect(products?.foreignKeys?.[0].referencedTable).toBe("categories");
  });

  test("should rollback failed recreation without leaking temp table", async () => {
    await schemaService.apply(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT
      );
    `, ['public'], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(`INSERT INTO users (id, email) VALUES (1, NULL)`);
    await seedClient.end();

    await expect(
      schemaService.apply(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
      `, ['public'], true)
    ).rejects.toThrow("NOT NULL");

    const client = await provider.createClient(config);
    const tables = await client.query<{ name: string }>(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('users', '_users_new')
      ORDER BY name
    `);
    const rows = await client.query<{ id: number; email: string | null }>(
      `SELECT id, email FROM users ORDER BY id`
    );
    await client.end();

    expect(tables.rows).toEqual([{ name: "users" }]);
    expect(rows.rows).toEqual([{ id: 1, email: null }]);
  });
});
