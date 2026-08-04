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

async function getIgnoreCheckConstraintsSetting(
  client: DatabaseClient
): Promise<number> {
  const result = await client.query<{ ignore_check_constraints: number }>(
    "PRAGMA ignore_check_constraints"
  );
  return result.rows[0]?.ignore_check_constraints ?? -1;
}

async function getDeferredForeignKeysSetting(
  client: DatabaseClient
): Promise<number> {
  const result = await client.query<{ defer_foreign_keys: number }>(
    "PRAGMA defer_foreign_keys"
  );
  return result.rows[0]?.defer_foreign_keys ?? -1;
}

async function getWritableSchemaSetting(
  client: DatabaseClient
): Promise<number> {
  const result = await client.query<{ writable_schema: number }>(
    "PRAGMA writable_schema"
  );
  return result.rows[0]?.writable_schema ?? -1;
}

async function createReferencedUsersMigration(
  provider: SQLiteProvider,
  filename = ":memory:"
): Promise<{ client: DatabaseClient; statements: string[] }> {
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
  const client = await provider.createClient({
    dialect: "sqlite",
    filename,
  });
  await client.query(
    "CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER)"
  );
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
  return { client, statements: migration.transactional };
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

  test("should not drop duplicate rows through schema conflict policies", async function () {
    const initialSchema = `
      CREATE TABLE conflict_items (
        id INTEGER PRIMARY KEY,
        lookup TEXT,
        payload TEXT
      );
    `;
    await schemaService.apply(initialSchema, ["public"], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(
      "INSERT INTO conflict_items(id, lookup, payload) VALUES (?, ?, ?), (?, ?, ?)",
      [1, "duplicate", "first", 2, "duplicate", "second"]
    );
    await seedClient.end();

    for (const policy of ["IGNORE", "REPLACE"]) {
      const desiredSchema = `
        CREATE TABLE conflict_items (
          id INTEGER PRIMARY KEY,
          lookup TEXT UNIQUE ON CONFLICT ${policy},
          payload TEXT
        );
      `;
      await expect(
        schemaService.apply(desiredSchema, ["public"], true)
      ).rejects.toMatchObject({
        code: "MIGRATION_ERROR",
        statement: expect.stringContaining("INSERT OR ABORT INTO"),
      });

      const client = await provider.createClient(config);
      const definition = await client.query<{ sql: string }>(`
        SELECT sql FROM sqlite_schema
        WHERE type = 'table' AND name = 'conflict_items'
      `);
      const rows = await client.query(
        "SELECT id, lookup, payload FROM conflict_items ORDER BY id"
      );
      const artifacts = await client.query<{ name: string }>(`
        SELECT name FROM sqlite_schema
        WHERE name GLOB '_conflict_items_new*'
      `);
      await client.end();

      expect(definition.rows[0]?.sql).not.toContain("UNIQUE");
      expect(rows.rows).toEqual([
        { id: 1, lookup: "duplicate", payload: "first" },
        { id: 2, lookup: "duplicate", payload: "second" },
      ]);
      expect(artifacts.rows).toEqual([]);
    }
  });

  test("should not rewrite nulls through schema conflict policies", async function () {
    const initialSchema = `
      CREATE TABLE conflict_values (
        id INTEGER PRIMARY KEY,
        value TEXT,
        marker INTEGER
      );
    `;
    const desiredSchema = `
      CREATE TABLE conflict_values (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'filled',
        marker TEXT
      );
    `;
    await schemaService.apply(initialSchema, ["public"], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(
      "INSERT INTO conflict_values(id, value, marker) VALUES (?, ?, ?)",
      [1, null, 7]
    );
    await seedClient.end();

    await expect(
      schemaService.apply(desiredSchema, ["public"], true)
    ).rejects.toMatchObject({
      code: "MIGRATION_ERROR",
      statement: expect.stringContaining("INSERT OR ABORT INTO"),
    });

    const client = await provider.createClient(config);
    const definition = await client.query<{ sql: string }>(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'conflict_values'
    `);
    const rows = await client.query(
      "SELECT id, value, marker, typeof(marker) AS marker_type " +
        "FROM conflict_values"
    );
    const artifacts = await client.query<{ name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE name GLOB '_conflict_values_new*'
    `);
    await client.end();

    expect(definition.rows[0]?.sql).not.toContain("NOT NULL");
    expect(rows.rows).toEqual([{
      id: 1,
      value: null,
      marker: 7,
      marker_type: "integer",
    }]);
    expect(artifacts.rows).toEqual([]);
  });

  test("should preserve hidden rowids during table recreation", async function () {
    await schemaService.apply(`
      CREATE TABLE notes (
        body TEXT NOT NULL,
        obsolete TEXT
      );
    `, ["public"], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(
      `INSERT INTO notes(rowid, body, obsolete) VALUES (7, 'first', 'x')`
    );
    await seedClient.query(
      `INSERT INTO notes(rowid, body, obsolete) VALUES (42, 'second', 'y')`
    );
    await seedClient.end();

    await schemaService.apply(`
      CREATE TABLE notes (
        body TEXT NOT NULL
      );
    `, ["public"], true);

    const client = await provider.createClient(config);
    const rows = await client.query<{ rowid: number; body: string }>(
      "SELECT rowid, body FROM notes ORDER BY rowid"
    );
    await client.end();

    expect(rows.rows).toEqual([
      { rowid: 7, body: "first" },
      { rowid: 42, body: "second" },
    ]);
  });

  test("should preserve rowids through shadowed names and descending primary keys", async function () {
    const initialSchema = `
      CREATE TABLE shadowed_names (
        rowid TEXT NOT NULL,
        oid TEXT NOT NULL,
        body TEXT NOT NULL,
        obsolete TEXT
      );

      CREATE TABLE descending_primary_key (
        id INTEGER PRIMARY KEY DESC,
        body TEXT NOT NULL,
        obsolete TEXT
      );
    `;
    await schemaService.apply(initialSchema, ["public"], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(`
      INSERT INTO shadowed_names(_rowid_, rowid, oid, body, obsolete)
      VALUES (17, 'declared rowid', 'declared oid', 'shadowed', 'x')
    `);
    await seedClient.query(`
      INSERT INTO descending_primary_key(rowid, id, body, obsolete)
      VALUES (23, 900, 'descending', 'y')
    `);
    await seedClient.end();

    await schemaService.apply(
      initialSchema.replaceAll(",\n        obsolete TEXT", ""),
      ["public"],
      true
    );

    const client = await provider.createClient(config);
    const shadowedRows = await client.query(
      `SELECT _rowid_ AS hidden_rowid, rowid, oid, body FROM shadowed_names`
    );
    const descendingRows = await client.query(
      `SELECT rowid AS hidden_rowid, id, body FROM descending_primary_key`
    );
    await client.end();

    expect(shadowedRows.rows).toEqual([{
      hidden_rowid: 17,
      rowid: "declared rowid",
      oid: "declared oid",
      body: "shadowed",
    }]);
    expect(descendingRows.rows).toEqual([{
      hidden_rowid: 23,
      id: 900,
      body: "descending",
    }]);
  });

  test("should preserve named values across INT and INTEGER primary keys", async function () {
    const initialSchema = `
      CREATE TABLE items (
        id INT PRIMARY KEY,
        obsolete TEXT
      );
    `;
    const rowidAliasSchema = `
      CREATE TABLE items (
        id INTEGER PRIMARY KEY
      );
    `;
    const intPrimaryKeySchema = `
      CREATE TABLE items (
        id INT PRIMARY KEY NOT NULL
      );
    `;
    await schemaService.apply(initialSchema, ["public"], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(
      `INSERT INTO items(rowid, id, obsolete) VALUES (7, 100, 'remove')`
    );
    await seedClient.end();

    await schemaService.apply(rowidAliasSchema, ["public"], true);

    const client = await provider.createClient(config);
    const rowidAliasRows = await client.query(
      "SELECT rowid AS hidden_rowid, id FROM items"
    );
    await client.end();

    expect(rowidAliasRows.rows).toEqual([{ hidden_rowid: 100, id: 100 }]);

    await schemaService.apply(intPrimaryKeySchema, ["public"], true);
    const reversedClient = await provider.createClient(config);
    const intPrimaryKeyRows = await reversedClient.query(
      "SELECT rowid AS hidden_rowid, id FROM items"
    );
    await expect(
      reversedClient.query("INSERT INTO items(id) VALUES (NULL)")
    ).rejects.toThrow("NOT NULL constraint failed");
    const tables = await provider.getCurrentSchema(reversedClient);
    await reversedClient.end();

    expect(intPrimaryKeyRows.rows).toEqual([{ hidden_rowid: 100, id: 100 }]);
    expect(tables[0]?.columns[0]).toMatchObject({
      name: "id",
      type: "INT",
      nullable: false,
    });
    expect((await schemaService.plan(intPrimaryKeySchema)).hasChanges)
      .toBe(false);
  });

  test("should reject rowid alias promotion when nullable keys exist", async function () {
    const initialSchema = `
      CREATE TABLE nullable_keys (
        id INT PRIMARY KEY,
        payload TEXT
      );
      CREATE TABLE "_nullable_keys_rowid_guard_new" (
        marker TEXT NOT NULL
      );
    `;
    const rowidAliasSchema = `
      CREATE TABLE nullable_keys (
        id INTEGER PRIMARY KEY,
        payload TEXT
      );
      CREATE TABLE "_nullable_keys_rowid_guard_new" (
        marker TEXT NOT NULL
      );
    `;

    await schemaService.apply(initialSchema, ["public"], true);
    const seedClient = await provider.createClient(config);
    await seedClient.query(`
      INSERT INTO nullable_keys(id, payload)
      VALUES (NULL, 'first'), (NULL, 'second')
    `);
    await seedClient.query(`
      INSERT INTO "_nullable_keys_rowid_guard_new"(marker)
      VALUES ('user table')
    `);
    await seedClient.end();

    const plan = await schemaService.plan(rowidAliasSchema);
    expect(plan.transactional[0]).toContain(
      'CREATE TABLE "_nullable_keys_rowid_guard_new_2"'
    );
    await expect(
      schemaService.apply(rowidAliasSchema, ["public"], true)
    ).rejects.toMatchObject({
      code: "MIGRATION_ERROR",
      message: expect.stringContaining("NOT NULL constraint failed"),
      statement: expect.stringContaining(
        'SELECT "id" FROM "nullable_keys" WHERE "id" IS NULL'
      ),
    });

    const client = await provider.createClient(config);
    const tableSql = await client.query<{ sql: string }>(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'nullable_keys'
    `);
    const rows = await client.query(
      "SELECT id, payload FROM nullable_keys ORDER BY rowid"
    );
    const artifacts = await client.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE '_nullable_keys%'
    `);
    const userGuardRows = await client.query(
      'SELECT marker FROM "_nullable_keys_rowid_guard_new"'
    );
    await client.end();

    expect(tableSql.rows[0]?.sql).toContain("id INT PRIMARY KEY");
    expect(rows.rows).toEqual([
      { id: null, payload: "first" },
      { id: null, payload: "second" },
    ]);
    expect(artifacts.rows).toEqual([{
      name: "_nullable_keys_rowid_guard_new",
    }]);
    expect(userGuardRows.rows).toEqual([{ marker: "user table" }]);
    expect((await schemaService.plan(rowidAliasSchema)).hasChanges).toBe(true);
  });

  test("should reject recreation when every hidden rowid name is shadowed", async function () {
    const initialSchema = `
      CREATE TABLE inaccessible_rowid (
        rowid TEXT NOT NULL,
        oid TEXT NOT NULL,
        _rowid_ TEXT NOT NULL,
        obsolete TEXT
      );
    `;
    await schemaService.apply(initialSchema, ["public"], true);

    const seedClient = await provider.createClient(config);
    await seedClient.query(`
      INSERT INTO inaccessible_rowid(rowid, oid, _rowid_, obsolete)
      VALUES ('rowid value', 'oid value', '_rowid_ value', 'keep')
    `);
    await seedClient.end();

    const desiredSchema = initialSchema.replace(",\n        obsolete TEXT", "");
    const failedApply = schemaService.apply(desiredSchema, ["public"], true);
    await expect(failedApply).rejects.toThrow(
      'Unable to preserve hidden SQLite ROWID for table "inaccessible_rowid"'
    );
    await expect(failedApply).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      entity: "inaccessible_rowid",
      field: "rowid",
    });

    const client = await provider.createClient(config);
    const columns = await client.query<{ name: string }>(
      "PRAGMA table_info(inaccessible_rowid)"
    );
    const rows = await client.query(
      "SELECT rowid, oid, _rowid_, obsolete FROM inaccessible_rowid"
    );
    await client.end();

    expect(columns.rows.map(function (column) {
      return column.name;
    })).toEqual(["rowid", "oid", "_rowid_", "obsolete"]);
    expect(rows.rows).toEqual([{
      rowid: "rowid value",
      oid: "oid value",
      _rowid_: "_rowid_ value",
      obsolete: "keep",
    }]);
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
    for (const initialSetting of [0, 1]) {
      const { client, statements } =
        await createReferencedUsersMigration(provider);
      await client.query(`PRAGMA foreign_keys = ${initialSetting}`);

      await provider.executeInTransaction(client, statements);
      expect(await getForeignKeysSetting(client)).toBe(initialSetting);
      const violations = await client.query("PRAGMA foreign_key_check");
      expect(violations.rows).toHaveLength(0);

      const failingStatements = [...statements];
      failingStatements.splice(
        failingStatements.length - 1,
        0,
        "INSERT INTO missing_table DEFAULT VALUES;"
      );
      await expect(
        provider.executeInTransaction(client, failingStatements)
      ).rejects.toThrow("missing_table");
      expect(await getForeignKeysSetting(client)).toBe(initialSetting);

      const integrityFailureStatements = [...statements];
      integrityFailureStatements.splice(
        integrityFailureStatements.length - 1,
        0,
        "UPDATE posts SET user_id = 999 WHERE id = 1;"
      );
      await expect(
        provider.executeInTransaction(client, integrityFailureStatements)
      ).rejects.toThrow("Foreign key integrity check failed");
      expect(await getForeignKeysSetting(client)).toBe(initialSetting);

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
          user_id: 1,
        },
      ]);
      await client.end();
    }
  });

  test("should validate foreign keys with caller enforcement off in memory and on disk", async function () {
    for (const filename of [":memory:", dbPath]) {
      const { client, statements } =
        await createReferencedUsersMigration(provider, filename);
      await client.query("PRAGMA foreign_keys = OFF");

      const violatingStatements = [...statements];
      violatingStatements.splice(
        violatingStatements.length - 1,
        0,
        "UPDATE posts SET user_id = 999 WHERE id = 1;"
      );

      await expect(
        provider.executeInTransaction(client, violatingStatements)
      ).rejects.toThrow("Foreign key integrity check failed");
      expect(await getForeignKeysSetting(client)).toBe(0);

      const rolledBackColumns = await client.query<{
        name: string;
        type: string;
      }>("PRAGMA table_info(users)");
      const rolledBackRows = await client.query(`
        SELECT users.id, users.age, posts.user_id
        FROM users
        JOIN posts ON posts.id = users.id
      `);
      const rolledBackArtifacts = await client.query(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE '_users_new%'
      `);
      expect(rolledBackColumns.rows.map(function (column) {
        return { name: column.name, type: column.type };
      })).toEqual([
        { name: "id", type: "INTEGER" },
        { name: "age", type: "INTEGER" },
      ]);
      expect(rolledBackRows.rows).toEqual([{
        id: 1,
        age: 10,
        user_id: 1,
      }]);
      expect(rolledBackArtifacts.rows).toEqual([]);

      await provider.executeInTransaction(client, statements);
      expect(await getForeignKeysSetting(client)).toBe(0);
      const foreignKeyCheck = await client.query("PRAGMA foreign_key_check");
      const migratedRows = await client.query(`
        SELECT users.id, users.age, posts.user_id
        FROM users
        JOIN posts ON posts.id = users.id
      `);
      const temporaryArtifacts = await client.query(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE '_users_new%'
      `);
      await client.end();

      expect(foreignKeyCheck.rows).toEqual([]);
      expect(migratedRows.rows).toEqual([{
        id: 1,
        age: "10",
        user_id: 1,
      }]);
      expect(temporaryArtifacts.rows).toEqual([]);
    }
  });

  test("should rollback generalized migrations that fail integrity checks", async function () {
    for (const filename of [":memory:", dbPath]) {
      const client = await provider.createClient({
        dialect: "sqlite",
        filename,
      });
      await client.query(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER)"
      );
      await client.query(
        "CREATE TABLE scores (value INTEGER CHECK (value > 0))"
      );
      await client.query("INSERT INTO users(id, age) VALUES (1, 10)");
      await client.query("PRAGMA ignore_check_constraints = ON");
      await client.query("INSERT INTO scores(value) VALUES (-1)");
      await client.query("PRAGMA ignore_check_constraints = OFF");

      await expect(
        provider.executeInTransaction(client, [
          "CREATE TABLE _users_new (id INTEGER PRIMARY KEY, age TEXT)",
          "INSERT INTO _users_new SELECT * FROM users",
          "DROP TABLE users",
          "ALTER TABLE _users_new RENAME TO users",
        ])
      ).rejects.toThrow(
        "SQLite integrity check failed: CHECK constraint failed in scores"
      );

      const columns = await client.query<{ name: string; type: string }>(
        "PRAGMA table_info(users)"
      );
      const users = await client.query("SELECT id, age FROM users");
      const temporaryArtifacts = await client.query(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table' AND name = '_users_new'
      `);
      expect(columns.rows.map(function (column) {
        return { name: column.name, type: column.type };
      })).toEqual([
        { name: "id", type: "INTEGER" },
        { name: "age", type: "INTEGER" },
      ]);
      expect(users.rows).toEqual([{ id: 1, age: 10 }]);
      expect(temporaryArtifacts.rows).toEqual([]);
      await client.end();
    }
  });

  test("should enforce checks during recreation and restore the caller setting", async function () {
    await schemaService.apply(`
      CREATE TABLE scores (
        value INTEGER NOT NULL,
        obsolete TEXT
      );
    `, ["public"], true);

    const desired = await provider.parseSchema(`
      CREATE TABLE scores (
        value INTEGER NOT NULL CHECK (value > 0)
      );
    `);
    const client = await provider.createClient(config);
    await client.query(
      "INSERT INTO scores(value, obsolete) VALUES (-1, 'keep on rollback')"
    );
    await client.query("PRAGMA ignore_check_constraints = ON");

    const current = await provider.getCurrentSchema(client);
    const plan = provider.generateMigrationPlan(desired.tables, current);
    await expect(
      provider.executeInTransaction(client, plan.transactional)
    ).rejects.toThrow("CHECK constraint failed");
    expect(await getIgnoreCheckConstraintsSetting(client)).toBe(1);

    const rolledBackRows = await client.query(
      "SELECT value, obsolete FROM scores"
    );
    const rolledBackColumns = await client.query<{ name: string }>(
      "PRAGMA table_info(scores)"
    );
    expect(rolledBackRows.rows).toEqual([{
      value: -1,
      obsolete: "keep on rollback",
    }]);
    expect(rolledBackColumns.rows.map(function (column) {
      return column.name;
    })).toEqual(["value", "obsolete"]);

    await client.query("UPDATE scores SET value = 1");
    await provider.executeInTransaction(client, plan.transactional);
    expect(await getIgnoreCheckConstraintsSetting(client)).toBe(1);

    await client.query("PRAGMA ignore_check_constraints = OFF");
    const integrity = await client.query<{ integrity_check: string }>(
      "PRAGMA integrity_check"
    );
    const rows = await client.query("SELECT value FROM scores");
    const temporaryArtifacts = await client.query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name LIKE '_scores_new%'
    `);
    await client.end();

    expect(integrity.rows).toEqual([{ integrity_check: "ok" }]);
    expect(rows.rows).toEqual([{ value: 1 }]);
    expect(temporaryArtifacts.rows).toEqual([]);
  });

  test("should preserve pragma settings when suspension is unnecessary", async function () {
    const client = await provider.createClient({
      dialect: "sqlite",
      filename: ":memory:",
    });
    await client.query("PRAGMA foreign_keys = OFF");
    await client.query("PRAGMA ignore_check_constraints = OFF");

    await provider.executeInTransaction(client, [
      "CREATE TABLE additive_change (id INTEGER PRIMARY KEY)",
    ]);
    expect(await getForeignKeysSetting(client)).toBe(0);
    expect(await getIgnoreCheckConstraintsSetting(client)).toBe(0);
    expect(await getDeferredForeignKeysSetting(client)).toBe(0);
    expect(await getWritableSchemaSetting(client)).toBe(0);

    await expect(
      provider.executeInTransaction(client, [
        "INSERT INTO missing_table DEFAULT VALUES",
      ])
    ).rejects.toThrow("missing_table");
    expect(await getForeignKeysSetting(client)).toBe(0);
    expect(await getIgnoreCheckConstraintsSetting(client)).toBe(0);
    expect(await getDeferredForeignKeysSetting(client)).toBe(0);
    expect(await getWritableSchemaSetting(client)).toBe(0);
    await client.end();
  });

  test("should restore deferred foreign keys after success and rollback", async function () {
    const additiveClient = await provider.createClient({
      dialect: "sqlite",
      filename: ":memory:",
    });
    await additiveClient.query("PRAGMA defer_foreign_keys = ON");
    expect(await getDeferredForeignKeysSetting(additiveClient)).toBe(1);

    await provider.executeInTransaction(additiveClient, [
      "CREATE TABLE deferred_state (id INTEGER PRIMARY KEY)",
    ]);
    expect(await getDeferredForeignKeysSetting(additiveClient)).toBe(1);

    await expect(
      provider.executeInTransaction(additiveClient, [
        "INSERT INTO missing_table DEFAULT VALUES",
      ])
    ).rejects.toThrow("missing_table");
    expect(await getDeferredForeignKeysSetting(additiveClient)).toBe(1);
    await additiveClient.end();

    const { client: recreationClient, statements } =
      await createReferencedUsersMigration(provider, dbPath);
    await recreationClient.query("PRAGMA defer_foreign_keys = ON");
    await provider.executeInTransaction(recreationClient, statements);
    expect(await getDeferredForeignKeysSetting(recreationClient)).toBe(1);

    const failingStatements = [...statements];
    failingStatements.splice(
      failingStatements.length - 1,
      0,
      "INSERT INTO missing_table DEFAULT VALUES"
    );
    await expect(
      provider.executeInTransaction(recreationClient, failingStatements)
    ).rejects.toThrow("missing_table");
    expect(await getDeferredForeignKeysSetting(recreationClient)).toBe(1);
    await recreationClient.end();
  });

  test("should enforce schema validation and restore writable_schema", async function () {
    for (const filename of [":memory:", dbPath]) {
      const client = await provider.createClient({
        dialect: "sqlite",
        filename,
      });
      await client.query("PRAGMA writable_schema = ON");

      await provider.executeInTransaction(client, [
        "CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER)",
      ]);
      expect(await getWritableSchemaSetting(client)).toBe(1);

      await client.query(
        "CREATE VIEW broken_view AS SELECT id FROM users"
      );
      const schemaVersion = await client.query<{ schema_version: number }>(
        "PRAGMA schema_version"
      );
      await client.query(
        "UPDATE sqlite_schema SET sql = ? WHERE name = ?",
        ["CREATE VIEW broken_view AS SELECT FROM", "broken_view"]
      );
      await client.query(
        `PRAGMA schema_version = ${schemaVersion.rows[0]!.schema_version + 1}`
      );

      await expect(
        provider.executeInTransaction(client, [
          "CREATE TABLE _users_new (id INTEGER PRIMARY KEY, age TEXT)",
          "INSERT INTO _users_new SELECT * FROM users",
          "DROP TABLE users",
          "ALTER TABLE _users_new RENAME TO users",
        ])
      ).rejects.toThrow("malformed database schema");
      expect(await getWritableSchemaSetting(client)).toBe(1);

      const tables = await client.query<{ name: string; sql: string }>(`
        SELECT name, sql
        FROM sqlite_schema
        WHERE type = 'table' AND name IN ('users', '_users_new')
        ORDER BY name
      `);
      expect(tables.rows).toEqual([{
        name: "users",
        sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER)",
      }]);
      await client.end();
    }
  });

  test("should reject migrations inside an active transaction or savepoint", async function () {
    for (const transactionStart of ["BEGIN", "SAVEPOINT caller_scope"]) {
      const { client, statements } =
        await createReferencedUsersMigration(provider);
      await client.query(transactionStart);
      await client.query("INSERT INTO users(id, age) VALUES (2, 20)");

      await expect(
        provider.executeInTransaction(client, statements)
      ).rejects.toThrow("outside an active transaction");
      expect(await getForeignKeysSetting(client)).toBe(1);
      const tables = await client.query<{ name: string }>(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('users', '_users_new')
        ORDER BY name
      `);
      const columns = await client.query<{ name: string; type: string }>(
        "PRAGMA table_info(users)"
      );
      const rowsInsideTransaction = await client.query(
        "SELECT id, age FROM users ORDER BY id"
      );
      expect(tables.rows).toEqual([{ name: "users" }]);
      expect(columns.rows.find(function (column) {
        return column.name === "age";
      })?.type).toBe("INTEGER");
      expect(rowsInsideTransaction.rows).toEqual([
        { id: 1, age: 10 },
        { id: 2, age: 20 },
      ]);

      await client.query("ROLLBACK");
      const rowsAfterRollback = await client.query(
        "SELECT id, age FROM users ORDER BY id"
      );
      expect(rowsAfterRollback.rows).toEqual([{ id: 1, age: 10 }]);
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
