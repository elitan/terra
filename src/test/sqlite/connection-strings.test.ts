import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createProviderFromConnectionString,
  detectDialect,
  parseConnectionString,
} from "../../providers";
import type { SQLiteConnectionConfig } from "../../providers/types";

const temporaryDirectories: string[] = [];

afterEach(async function removeTemporaryDirectories() {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("SQLite connection strings", function () {
  test("preserves absolute paths for canonical and legacy slash counts", function () {
    const absolutePath = "/var/lib/terradb/main.sqlite";

    expect(parseConnectionString(`sqlite://${absolutePath}`)).toEqual({
      dialect: "sqlite",
      filename: absolutePath,
    });
    expect(parseConnectionString(`sqlite:///${absolutePath}`)).toEqual({
      dialect: "sqlite",
      filename: absolutePath,
    });
  });

  test("preserves relative paths and official SQLite file URIs", function () {
    expect(parseConnectionString("BACKUP.SQLITE3")).toEqual({
      dialect: "sqlite",
      filename: "BACKUP.SQLITE3",
    });
    expect(parseConnectionString(":memory:")).toEqual({
      dialect: "sqlite",
      filename: ":memory:",
    });
    expect(parseConnectionString("sqlite:databases/main.db")).toEqual({
      dialect: "sqlite",
      filename: "databases/main.db",
    });
    expect(parseConnectionString("sqlite://databases/main.db")).toEqual({
      dialect: "sqlite",
      filename: "databases/main.db",
    });
    expect(
      parseConnectionString("file:shared-memory?mode=memory&cache=shared")
    ).toEqual({
      dialect: "sqlite",
      filename: "file:shared-memory?mode=memory&cache=shared",
    });
    expect(parseConnectionString("FILE:uppercase-memory?mode=memory")).toEqual({
      dialect: "sqlite",
      filename: "file:uppercase-memory?mode=memory",
    });
  });

  test("prioritizes explicit schemes over database-looking suffixes", function () {
    expect(detectDialect("postgres://localhost/archive.db")).toBe("postgres");
    expect(detectDialect("postgresql://localhost/archive.sqlite")).toBe(
      "postgres"
    );
    expect(detectDialect("FILE:shared?mode=memory&cache=shared")).toBe(
      "sqlite"
    );
    expect(detectDialect("BACKUP.SQLITE3")).toBe("sqlite");
  });

  test("opens the exact absolute file named by sqlite triple-slash syntax", async function () {
    const directory = await mkdtemp(join(tmpdir(), "terradb path ü-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "production data.sqlite");
    const connectionString = `sqlite://${databasePath}`;
    const config = parseConnectionString(connectionString) as SQLiteConnectionConfig;
    const provider = await createProviderFromConnectionString(connectionString);

    const client = await provider.createClient(config);
    try {
      await client.query("CREATE TABLE exact_target (id INTEGER PRIMARY KEY)");
    } finally {
      await client.end();
    }

    expect(config.filename).toBe(databasePath);
    expect(existsSync(databasePath)).toBe(true);

    const reopened = await provider.createClient(config);
    try {
      const tables = await reopened.query<{ name: string }>(`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `);
      expect(tables.rows).toEqual([{ name: "exact_target" }]);
    } finally {
      await reopened.end();
    }
  });

  test("passes official shared-memory file URIs through to SQLite", async function () {
    const connectionString =
      `file:terradb-connection-${Date.now()}?mode=memory&cache=shared`;
    const config = parseConnectionString(connectionString) as SQLiteConnectionConfig;
    const provider = await createProviderFromConnectionString(connectionString);
    const first = await provider.createClient(config);
    const second = await provider.createClient(config);

    try {
      await first.query("CREATE TABLE shared_target (id INTEGER PRIMARY KEY)");
      const tables = await second.query<{ name: string }>(`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `);
      expect(tables.rows).toEqual([{ name: "shared_target" }]);
    } finally {
      await second.end();
      await first.end();
    }
  });
});
