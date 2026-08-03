import type { ParsedSchema } from "../types";
import { ParserError } from "../../types/errors";
import { SQLiteClient } from "./client";
import { SQLiteInspector } from "./inspector";

export class SQLiteParser {
  private inspector: SQLiteInspector;

  constructor() {
    this.inspector = new SQLiteInspector();
  }

  async parseSchema(sql: string, filePath?: string): Promise<ParsedSchema> {
    let client: SQLiteClient | undefined;

    try {
      client = await SQLiteClient.create({ dialect: "sqlite", filename: ":memory:" });
      client.execMultiple(sql);

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
