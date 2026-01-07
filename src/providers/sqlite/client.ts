import type { DatabaseClient, QueryResult, SQLiteConnectionConfig } from "../types";

interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): void;
  };
  close(): void;
  transaction<T>(fn: () => T): () => T;
}

const isBun = typeof globalThis.Bun !== "undefined";

async function loadDatabase(filename: string): Promise<SQLiteDatabase> {
  if (isBun) {
    const { Database } = await import("bun:sqlite");
    return new Database(filename);
  } else {
    const Database = (await import("better-sqlite3")).default;
    return new Database(filename);
  }
}

export class SQLiteClient implements DatabaseClient {
  private db!: SQLiteDatabase;

  private constructor() {}

  static async create(config: SQLiteConnectionConfig): Promise<SQLiteClient> {
    const client = new SQLiteClient();
    client.db = await loadDatabase(config.filename);
    client.db.exec("PRAGMA foreign_keys = ON");
    return client;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const stmt = this.db.prepare(sql);
    const sqlParams = params as (string | number | bigint | boolean | null | Uint8Array)[] | undefined;
    if (sql.trim().toUpperCase().startsWith("SELECT") ||
        sql.trim().toUpperCase().startsWith("PRAGMA")) {
      const rows = sqlParams ? stmt.all(...sqlParams) : stmt.all();
      return { rows: rows as T[] };
    } else {
      if (sqlParams) {
        stmt.run(...sqlParams);
      } else {
        stmt.run();
      }
      return { rows: [] };
    }
  }

  async end(): Promise<void> {
    this.db.close();
  }

  get raw(): SQLiteDatabase {
    return this.db;
  }

  execMultiple(sql: string): void {
    this.db.exec(sql);
  }

  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
