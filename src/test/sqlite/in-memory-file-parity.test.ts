import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SQLiteProvider } from "../../providers/sqlite";
import { TriggerHandler } from "../../core/schema/handlers/trigger-handler";
import { ViewHandler } from "../../core/schema/handlers/view-handler";
import type { SQLiteConnectionConfig } from "../../providers/types";

const schemaSql = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE posts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX idx_posts_user_id ON posts(user_id);
  CREATE VIEW active_users AS SELECT id, email FROM users WHERE active = 1;
`;

const schemaWithTriggerViewIndexSql = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL
  );

  CREATE INDEX idx_users_email ON users(email);
  CREATE INDEX idx_users_active ON users(active);
  CREATE VIEW active_users AS SELECT id, email FROM users WHERE active = 1;

  CREATE TRIGGER trg_users_insert
  AFTER INSERT ON users
  BEGIN
    INSERT INTO audit_log(user_id, action) VALUES (NEW.id, 'insert');
  END;
`;

function toSnapshot(tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>): string[] {
  return tables
    .map(function (table) {
      const columns = table.columns
        .map(function (column) {
          return `${column.name}:${column.type}`;
        })
        .join(",");
      return `${table.name}(${columns})`;
    })
    .sort();
}

async function runCoreScenario(config: SQLiteConnectionConfig): Promise<string[]> {
  const provider = new SQLiteProvider();
  const client = await provider.createClient(config);

  try {
    const parsed = await provider.parseSchema(schemaSql);
    const desiredTables = parsed.tables;

    const firstCurrent = await provider.getCurrentSchema(client);
    const firstPlan = provider.generateMigrationPlan(desiredTables, firstCurrent);
    expect(firstPlan.hasChanges).toBe(true);
    await provider.executeInTransaction(client, firstPlan.transactional);

    const secondCurrent = await provider.getCurrentSchema(client);
    const secondPlan = provider.generateMigrationPlan(desiredTables, secondCurrent);
    expect(secondPlan.hasChanges).toBe(false);

    return toSnapshot(secondCurrent);
  } finally {
    await client.end();
  }
}

type ComboSnapshot = {
  tables: string[];
  views: string[];
  triggers: string[];
};

function toComboSnapshot(
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }>; indexes?: Array<{ name: string; columns: string[] }> }>,
  views: Array<{ name: string; definition: string }>,
  triggers: Array<{ name: string; tableName: string; timing: string; events: string[] }>
): ComboSnapshot {
  return {
    tables: tables
      .map(function (table) {
        const columns = table.columns
          .map(function (column) {
            return `${column.name}:${column.type}`;
          })
          .join(",");
        const indexes = (table.indexes || [])
          .map(function (index) {
            return `${index.name}(${index.columns.join(",")})`;
          })
          .sort()
          .join(",");
        return `${table.name}|${columns}|${indexes}`;
      })
      .sort(),
    views: views
      .map(function (view) {
        return `${view.name}|${view.definition.replace(/\s+/g, " ").trim()}`;
      })
      .sort(),
    triggers: triggers
      .map(function (trigger) {
        return `${trigger.name}|${trigger.tableName}|${trigger.timing}|${trigger.events.join(",")}`;
      })
      .sort(),
  };
}

async function runTriggerViewIndexScenario(config: SQLiteConnectionConfig): Promise<ComboSnapshot> {
  const provider = new SQLiteProvider();
  const client = await provider.createClient(config);
  const viewHandler = new ViewHandler();
  const triggerHandler = new TriggerHandler();

  try {
    const parsed = await provider.parseSchema(schemaWithTriggerViewIndexSql);
    const desiredTables = parsed.tables;
    const desiredViews = parsed.views;
    const desiredTriggers = parsed.triggers;

    for (let i = 0; i < 3; i++) {
      const currentTables = await provider.getCurrentSchema(client);
      const currentViews = await provider.getCurrentViews(client);
      const currentTriggers = await provider.getCurrentTriggers(client);

      const tablePlan = provider.generateMigrationPlan(desiredTables, currentTables);
      const viewStatements = viewHandler.generateStatements(desiredViews, currentViews);
      const triggerStatements = triggerHandler.generateStatements(desiredTriggers, currentTriggers);
      const statements = [...tablePlan.transactional, ...viewStatements, ...triggerStatements];
      const hasChanges = statements.length > 0;

      if (i === 0) {
        expect(hasChanges).toBe(true);
      } else {
        expect(hasChanges).toBe(false);
      }

      if (hasChanges) {
        await provider.executeInTransaction(client, statements);
      }
    }

    const tables = await provider.getCurrentSchema(client);
    const views = await provider.getCurrentViews(client);
    const triggers = await provider.getCurrentTriggers(client);
    return toComboSnapshot(tables, views, triggers);
  } finally {
    await client.end();
  }
}

describe("SQLite in-memory/file parity", function () {
  test("matches core apply and idempotency behavior", async function () {
    const dbPath = path.join(os.tmpdir(), `sqlite-parity-${Date.now()}.db`);

    try {
      const fileSnapshot = await runCoreScenario({
        dialect: "sqlite",
        filename: dbPath,
      });
      const memorySnapshot = await runCoreScenario({
        dialect: "sqlite",
        filename: ":memory:",
      });

      expect(memorySnapshot).toEqual(fileSnapshot);
    } finally {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    }
  });

  test("matches trigger view index behavior with repeated reapply", async function () {
    const dbPath = path.join(os.tmpdir(), `sqlite-parity-combo-${Date.now()}.db`);

    try {
      const fileSnapshot = await runTriggerViewIndexScenario({
        dialect: "sqlite",
        filename: dbPath,
      });
      const memorySnapshot = await runTriggerViewIndexScenario({
        dialect: "sqlite",
        filename: ":memory:",
      });

      expect(memorySnapshot).toEqual(fileSnapshot);
    } finally {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    }
  });
});
