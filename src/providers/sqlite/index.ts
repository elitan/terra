import type {
  DatabaseProvider,
  DatabaseClient,
  ConnectionConfig,
  SQLiteConnectionConfig,
  ParsedSchema,
  DatabaseFeature,
  ValidationResult,
  ValidationError,
} from "../types";
import type {
  Table,
  EnumType,
  View,
  Function,
  Procedure,
  Trigger,
  Sequence,
  Extension,
  SchemaDefinition,
  Comment,
} from "../../types/schema";
import type { MigrationPlan } from "../../types/migration";
import { SQLiteClient } from "./client";
import { SQLiteInspector } from "./inspector";
import { SQLiteParser } from "./parser";
import { SQLiteDiffer } from "./differ";
import { MigrationError } from "../../types/errors";

const UNSUPPORTED_FEATURES: DatabaseFeature[] = [
  "schemas",
  "sequences",
  "enums",
  "extensions",
  "concurrent_indexes",
  "advisory_locks",
  "stored_functions",
  "stored_procedures",
  "materialized_views",
  "index_types",
];

export class SQLiteProvider implements DatabaseProvider {
  readonly dialect = "sqlite" as const;

  private parser: SQLiteParser;
  private inspector: SQLiteInspector;
  private differ: SQLiteDiffer;

  constructor() {
    this.parser = new SQLiteParser();
    this.inspector = new SQLiteInspector();
    this.differ = new SQLiteDiffer();
  }

  async createClient(config: ConnectionConfig): Promise<DatabaseClient> {
    if (config.dialect !== "sqlite") {
      throw new Error("SQLiteProvider requires sqlite config");
    }
    return new SQLiteClient(config as SQLiteConnectionConfig);
  }

  async parseSchema(sql: string, filePath?: string): Promise<ParsedSchema> {
    return this.parser.parseSchema(sql, filePath);
  }

  async getCurrentSchema(
    client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Table[]> {
    return this.inspector.getCurrentSchema(client as SQLiteClient);
  }

  async getCurrentEnums(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<EnumType[]> {
    return [];
  }

  async getCurrentViews(
    client: DatabaseClient,
    _schemas?: string[]
  ): Promise<View[]> {
    return this.inspector.getCurrentViews(client as SQLiteClient);
  }

  async getCurrentFunctions(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Function[]> {
    return [];
  }

  async getCurrentProcedures(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Procedure[]> {
    return [];
  }

  async getCurrentTriggers(
    client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Trigger[]> {
    return this.inspector.getCurrentTriggers(client as SQLiteClient);
  }

  async getCurrentSequences(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Sequence[]> {
    return [];
  }

  async getCurrentExtensions(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Extension[]> {
    return [];
  }

  async getCurrentSchemas(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<SchemaDefinition[]> {
    return [];
  }

  async getCurrentComments(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Comment[]> {
    return [];
  }

  generateMigrationPlan(desired: Table[], current: Table[]): MigrationPlan {
    return this.differ.generateMigrationPlan(desired, current);
  }

  supportsFeature(feature: DatabaseFeature): boolean {
    return !UNSUPPORTED_FEATURES.includes(feature);
  }

  validateSchema(schema: ParsedSchema): ValidationResult {
    const errors: ValidationError[] = [];

    if (schema.schemas && schema.schemas.length > 0) {
      errors.push({
        code: "SQLITE_NO_SCHEMAS",
        message: "SQLite does not support schemas",
        suggestion: "Remove CREATE SCHEMA statements",
      });
    }

    if (schema.enums && schema.enums.length > 0) {
      errors.push({
        code: "SQLITE_NO_ENUMS",
        message: "SQLite does not support ENUM types",
        suggestion: "Use TEXT with CHECK constraints instead",
      });
    }

    if (schema.sequences && schema.sequences.length > 0) {
      errors.push({
        code: "SQLITE_NO_SEQUENCES",
        message: "SQLite does not support sequences",
        suggestion: "Use INTEGER PRIMARY KEY AUTOINCREMENT instead",
      });
    }

    if (schema.extensions && schema.extensions.length > 0) {
      errors.push({
        code: "SQLITE_NO_EXTENSIONS",
        message: "SQLite does not support extensions",
        suggestion: "Remove CREATE EXTENSION statements",
      });
    }

    if (schema.functions && schema.functions.length > 0) {
      errors.push({
        code: "SQLITE_NO_FUNCTIONS",
        message: "SQLite does not support stored functions",
        suggestion: "Remove CREATE FUNCTION statements",
      });
    }

    if (schema.procedures && schema.procedures.length > 0) {
      errors.push({
        code: "SQLITE_NO_PROCEDURES",
        message: "SQLite does not support stored procedures",
        suggestion: "Remove CREATE PROCEDURE statements",
      });
    }

    for (const table of schema.tables) {
      for (const index of table.indexes || []) {
        if (index.type && index.type !== "btree") {
          errors.push({
            code: "SQLITE_BTREE_ONLY",
            message: `SQLite only supports btree indexes, found ${index.type}`,
            object: `${table.name}.${index.name}`,
            suggestion: "Remove USING clause or use btree",
          });
        }
        if (index.opclasses && Object.keys(index.opclasses).length > 0) {
          errors.push({
            code: "SQLITE_NO_OPCLASS",
            message: "SQLite does not support operator classes",
            object: `${table.name}.${index.name}`,
          });
        }
      }
    }

    for (const view of schema.views || []) {
      if (view.materialized) {
        errors.push({
          code: "SQLITE_NO_MATERIALIZED_VIEWS",
          message: "SQLite does not support materialized views",
          object: view.name,
          suggestion: "Use regular views or tables instead",
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  async executeInTransaction(
    client: DatabaseClient,
    statements: string[]
  ): Promise<void> {
    const sqliteClient = client as SQLiteClient;
    const ora = (await import("ora")).default;
    const spinner = ora({ text: "Applying changes...", color: "white" }).start();
    const startTime = Date.now();

    let currentStatement: string | undefined;

    try {
      sqliteClient.inTransaction(() => {
        for (const statement of statements) {
          if (statement.startsWith("--")) {
            continue;
          }
          currentStatement = statement;
          sqliteClient.execMultiple(statement);
        }
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      spinner.stopAndPersist({ symbol: "✔", text: `Applied (${elapsed}s)` });
    } catch (error) {
      spinner.stopAndPersist({ symbol: "✗", text: "Failed to apply changes" });

      throw new MigrationError(
        error instanceof Error ? error.message : String(error),
        currentStatement
      );
    }
  }
}

export { SQLiteClient } from "./client";
export { SQLiteInspector } from "./inspector";
export { SQLiteParser } from "./parser";
export { SQLiteDiffer } from "./differ";
