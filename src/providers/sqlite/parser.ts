import type { ParsedSchema } from "../types";
import { ParserError } from "../../types/errors";
import { SQLiteClient } from "./client";
import { SQLiteInspector } from "./inspector";
import {
  findSQLiteStatementStartKeyword,
  hasSQLiteQueryDerivedTable,
} from "./sql-parser-utils";

interface SQLiteSchemaObjectRow {
  type: string;
  name: string;
}

const UNSUPPORTED_DESIRED_SCHEMA_STATEMENTS = [
  "ALTER",
  "ANALYZE",
  "ATTACH",
  "BEGIN",
  "COMMIT",
  "DELETE",
  "DETACH",
  "DROP",
  "END",
  "EXPLAIN",
  "INSERT",
  "PRAGMA",
  "REINDEX",
  "RELEASE",
  "REPLACE",
  "ROLLBACK",
  "SAVEPOINT",
  "SELECT",
  "UPDATE",
  "VALUES",
  "VACUUM",
  "WITH",
];

export class SQLiteParser {
  private inspector: SQLiteInspector;

  constructor() {
    this.inspector = new SQLiteInspector();
  }

  async parseSchema(sql: string, filePath?: string): Promise<ParsedSchema> {
    let client: SQLiteClient | undefined;

    try {
      const unsupportedKeyword = findSQLiteStatementStartKeyword(
        sql,
        UNSUPPORTED_DESIRED_SCHEMA_STATEMENTS
      );
      if (unsupportedKeyword) {
        throw new ParserError(
          `${unsupportedKeyword} is not supported in SQLite desired schemas. ` +
            "Use CREATE statements to describe the objects that should exist",
          filePath
        );
      }
      if (hasSQLiteQueryDerivedTable(sql)) {
        throw new ParserError(
          "CREATE TABLE AS SELECT is not supported in SQLite desired schemas. " +
            "Define table columns explicitly and load data separately",
          filePath
        );
      }

      client = await SQLiteClient.create({ dialect: "sqlite", filename: ":memory:" });
      client.execMultiple(sql);

      const temporaryObjects = await client.query<SQLiteSchemaObjectRow>(`
        SELECT type, name
        FROM sqlite_temp_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `);
      if (temporaryObjects.rows.length > 0) {
        const names = temporaryObjects.rows.map(function (object) {
          return `${object.type} ${object.name}`;
        }).join(", ");
        throw new ParserError(
          `Temporary SQLite schema objects are not supported: ${names}`,
          filePath
        );
      }

      const tables = await this.inspector.getCurrentSchema(client);
      const views = await this.inspector.getCurrentViews(client);
      const triggers = await this.inspector.getCurrentTriggers(client);

      return {
        tables,
        enums: [],
        compositeTypes: [],
        views,
        functions: [],
        procedures: [],
        triggers,
        sequences: [],
        extensions: [],
        schemas: [],
        comments: [],
      };
    } catch (error) {
      if (error instanceof ParserError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ParserError(message, filePath);
    } finally {
      await client?.end();
    }
  }
}
