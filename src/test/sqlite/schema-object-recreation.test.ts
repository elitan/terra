import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SchemaService } from "../../core/schema/service";
import { SQLiteProvider } from "../../providers/sqlite";
import type { SQLiteConnectionConfig } from "../../providers/types";

const initialSchema = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL
  );

  CREATE INDEX idx_users_active ON users(active) WHERE active = 1;

  CREATE VIEW ideas ("user id", "display name", marker) AS
    SELECT id, name, 'a   b' AS marker FROM users WHERE active = 1;

  CREATE TRIGGER trg_users_insert
  AFTER INSERT ON users
  BEGIN
    INSERT INTO audit_log(user_id, action) VALUES (NEW.id, 'insert   event');
  END;

  CREATE TRIGGER trg_ideas_insert
  INSTEAD OF INSERT ON ideas
  BEGIN
    INSERT INTO users(id, name, active)
    VALUES (NEW."user id", NEW."display name", 1);
  END;
`;

const recreatedTableSchema = initialSchema.replace(
  "name TEXT NOT NULL",
  "name BLOB NOT NULL"
);

const changedViewSchema = recreatedTableSchema.replace(
  "WHERE active = 1;\n\n  CREATE TRIGGER",
  "WHERE active >= 0;\n\n  CREATE TRIGGER"
);

const failingRecreationSchema = changedViewSchema.replace(
  "name BLOB NOT NULL",
  "name BLOB NOT NULL CHECK (typeof(name) = 'integer')"
);

function findStatement(plan: string[], pattern: RegExp): number {
  return plan.findIndex(function (statement) {
    return pattern.test(statement.trim());
  });
}

async function verifyManagedObjects(
  provider: SQLiteProvider,
  client: Awaited<ReturnType<SQLiteProvider["createClient"]>>
): Promise<void> {
  const tables = await provider.getCurrentSchema(client);
  const users = tables.find(function (table) {
    return table.name === "users";
  });
  expect(users?.indexes?.map(function (index) {
    return index.name;
  })).toEqual(["idx_users_active"]);

  const views = await provider.getCurrentViews(client);
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({
    name: "ideas",
    definition: expect.stringContaining("SELECT id, name, 'a   b' AS marker"),
  });
  expect((views[0] as any).createStatement).toContain(
    'CREATE VIEW ideas ("user id", "display name", marker) AS'
  );

  const triggers = await provider.getCurrentTriggers(client);
  expect(triggers.map(function (trigger) {
    return trigger.name;
  })).toEqual(["trg_ideas_insert", "trg_users_insert"]);
}

async function runSchemaObjectLifecycle(config: SQLiteConnectionConfig): Promise<void> {
  const provider = new SQLiteProvider();
  const anchor = await provider.createClient(config);
  const service = new SchemaService(provider, config);

  try {
    await service.apply(initialSchema, ["public"], true);
    await anchor.query(
      "INSERT INTO users(id, name, active) VALUES (?, ?, ?)",
      [1, "first", 1]
    );

    const recreationPlan = await service.apply(
      recreatedTableSchema,
      ["public"],
      true
    );
    const statements = recreationPlan.transactional;
    const dropTrigger = findStatement(statements, /^DROP TRIGGER/i);
    const dropView = findStatement(statements, /^DROP VIEW/i);
    const createTemporaryTable = findStatement(
      statements,
      /^CREATE TABLE\s+"_users_new"/i
    );
    const renameTable = findStatement(
      statements,
      /^ALTER TABLE\s+"_users_new"\s+RENAME TO/i
    );
    const createView = findStatement(statements, /^CREATE VIEW/i);
    const createTrigger = findStatement(statements, /^CREATE TRIGGER/i);

    expect(dropTrigger).toBeGreaterThanOrEqual(0);
    expect(dropView).toBeGreaterThan(dropTrigger);
    expect(createTemporaryTable).toBeGreaterThan(dropView);
    expect(renameTable).toBeGreaterThan(createTemporaryTable);
    expect(createView).toBeGreaterThan(renameTable);
    expect(createTrigger).toBeGreaterThan(createView);

    await verifyManagedObjects(provider, anchor);
    expect((await service.plan(recreatedTableSchema)).hasChanges).toBe(false);
    expect(
      (await anchor.query(
        'SELECT marker FROM ideas WHERE "user id" = 1'
      )).rows
    ).toEqual([{ marker: "a   b" }]);

    await anchor.query(
      "INSERT INTO users(id, name, active) VALUES (?, ?, ?)",
      [2, "second", 1]
    );
    await anchor.query(
      'INSERT INTO ideas("user id", "display name") VALUES (?, ?)',
      [3, "third"]
    );
    expect(
      (await anchor.query(
        "SELECT user_id, action FROM audit_log ORDER BY user_id"
      )).rows
    ).toEqual([
      { user_id: 1, action: "insert   event" },
      { user_id: 2, action: "insert   event" },
      { user_id: 3, action: "insert   event" },
    ]);

    const viewPlan = await service.apply(changedViewSchema, ["public"], true);
    expect(findStatement(viewPlan.transactional, /^DROP VIEW/i)).toBeGreaterThanOrEqual(0);
    expect(findStatement(viewPlan.transactional, /^DROP TRIGGER/i)).toBeGreaterThanOrEqual(0);
    await verifyManagedObjects(provider, anchor);
    expect((await service.plan(changedViewSchema)).hasChanges).toBe(false);

    await anchor.query(
      'INSERT INTO ideas("user id", "display name") VALUES (?, ?)',
      [4, "fourth"]
    );

    await expect(
      service.apply(failingRecreationSchema, ["public"], true)
    ).rejects.toThrow("CHECK constraint failed");
    await verifyManagedObjects(provider, anchor);
    expect((await service.plan(changedViewSchema)).hasChanges).toBe(false);
    expect(
      (await anchor.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name IN ('_users_new', '_audit_log_new')"
      )).rows
    ).toEqual([]);

    await anchor.query(
      "INSERT INTO users(id, name, active) VALUES (?, ?, ?)",
      [5, "fifth", 1]
    );
    expect(
      (await anchor.query<{ user_id: number }>(
        "SELECT user_id FROM audit_log ORDER BY user_id"
      )).rows
    ).toEqual([1, 2, 3, 4, 5].map(function (userId) {
      return { user_id: userId };
    }));
  } finally {
    await anchor.end();
  }
}

describe("SQLite table recreation schema objects", function () {
  test("parses complete view SQL with explicit column names", async function () {
    const provider = new SQLiteProvider();
    const parsed = await provider.parseSchema(initialSchema);
    const view = parsed.views[0] as any;

    expect(view.definition).toBe(
      "SELECT id, name, 'a   b' AS marker FROM users WHERE active = 1"
    );
    expect(view.createStatement).toContain(
      'CREATE VIEW ideas ("user id", "display name", marker) AS'
    );
  });

  test("preserves indexes, views, and triggers through recreation and rollback", async function () {
    const dbPath = path.join(os.tmpdir(), `terradb-schema-objects-${Date.now()}.db`);
    const memoryName = `terradb-schema-objects-${Date.now()}`;

    try {
      await runSchemaObjectLifecycle({
        dialect: "sqlite",
        filename: `file:${memoryName}?mode=memory&cache=shared`,
      });
      await runSchemaObjectLifecycle({ dialect: "sqlite", filename: dbPath });
    } finally {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    }
  });

  test("matches identifier case across views and triggers", async function () {
    const config: SQLiteConnectionConfig = {
      dialect: "sqlite",
      filename: `file:terradb-schema-object-case-${Date.now()}?mode=memory&cache=shared`,
    };
    const provider = new SQLiteProvider();
    const anchor = await provider.createClient(config);
    const service = new SchemaService(provider, config);

    try {
      await anchor.query(`
        CREATE TABLE "Users" (
          "ID" INTEGER PRIMARY KEY,
          "Active" INTEGER NOT NULL
        )
      `);
      await anchor.query(`
        CREATE TABLE "AuditLog" ("UserID" INTEGER NOT NULL)
      `);
      await anchor.query(`
        CREATE VIEW "ActiveUsers"("SelectedUser") AS
        SELECT "ID" FROM "Users" WHERE "Active" = 1
      `);
      await anchor.query(`
        CREATE TRIGGER "Users_Insert_Audit"
        AFTER INSERT ON "Users"
        BEGIN
          INSERT INTO "AuditLog"("UserID") VALUES (NEW."ID");
        END
      `);
      await anchor.query(`
        INSERT INTO "Users"("ID", "Active") VALUES (7, 1)
      `);

      const equivalentSchema = `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          active INTEGER NOT NULL
        );
        CREATE TABLE auditlog (userid INTEGER NOT NULL);
        CREATE VIEW activeusers(selecteduser) AS
          SELECT id FROM users WHERE active = 1;
        CREATE TRIGGER users_insert_audit
        AFTER INSERT ON users
        BEGIN
          INSERT INTO auditlog(userid) VALUES (new.id);
        END;
      `;
      const plan = await service.plan(equivalentSchema, ["public"]);
      expect(plan.hasChanges).toBe(false);
      expect(plan.transactional).toEqual([]);

      const activeUsers = await anchor.query(`
        SELECT "SelectedUser" AS userid
        FROM activeusers
        ORDER BY "SelectedUser"
      `);
      const auditRows = await anchor.query(`
        SELECT "UserID" AS userid FROM auditlog ORDER BY "UserID"
      `);
      expect(activeUsers.rows).toEqual([{ userid: 7 }]);
      expect(auditRows.rows).toEqual([{ userid: 7 }]);

      const changedView = equivalentSchema.replace(
        "WHERE active = 1",
        "WHERE active >= 0"
      );
      expect((await service.plan(changedView, ["public"])).hasChanges)
        .toBe(true);

      const changedTrigger = equivalentSchema.replace(
        "VALUES (new.id)",
        "VALUES (new.id + 1)"
      );
      expect((await service.plan(changedTrigger, ["public"])).hasChanges)
        .toBe(true);
    } finally {
      await anchor.end();
    }
  });
});
