import { Database } from "bun:sqlite";
import type { DatabaseClient, QueryResult, SQLiteConnectionConfig } from "../types";

export class SQLiteClient implements DatabaseClient {
  private db: Database;

  constructor(config: SQLiteConnectionConfig) {
    this.db = new Database(config.filename);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const stmt = this.db.prepare(sql);
    if (sql.trim().toUpperCase().startsWith("SELECT") ||
        sql.trim().toUpperCase().startsWith("PRAGMA")) {
      const rows = params ? stmt.all(...params) : stmt.all();
      return { rows: rows as T[] };
    } else {
      if (params) {
        stmt.run(...params);
      } else {
        stmt.run();
      }
      return { rows: [] };
    }
  }

  async end(): Promise<void> {
    this.db.close();
  }

  get raw(): Database {
    return this.db;
  }

  execMultiple(sql: string): void {
    this.db.exec(sql);
  }

  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
