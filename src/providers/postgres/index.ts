import { Client } from "pg";
import type {
  DatabaseProvider,
  DatabaseClient,
  ConnectionConfig,
  PostgresConnectionConfig,
  ParsedSchema,
  DatabaseFeature,
  ValidationResult,
  AdvisoryLockOptions,
  QueryResult,
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
import { SchemaParser } from "../../core/schema/parser";
import { DatabaseInspector } from "../../core/schema/inspector";
import { SchemaDiffer } from "../../core/schema/differ";
import { Logger } from "../../utils/logger";
import { MigrationError } from "../../types/errors";

class PostgresClient implements DatabaseClient {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await this.client.query(sql, params);
    return { rows: result.rows as T[] };
  }

  async end(): Promise<void> {
    await this.client.end();
  }

  get raw(): Client {
    return this.client;
  }
}

export class PostgresProvider implements DatabaseProvider {
  readonly dialect = "postgres" as const;

  private parser: SchemaParser;
  private inspector: DatabaseInspector;
  private differ: SchemaDiffer;

  constructor() {
    this.parser = new SchemaParser();
    this.inspector = new DatabaseInspector();
    this.differ = new SchemaDiffer();
  }

  async createClient(config: ConnectionConfig): Promise<DatabaseClient> {
    if (config.dialect !== "postgres") {
      throw new Error("PostgresProvider requires postgres config");
    }
    const pgConfig = config as PostgresConnectionConfig;
    const client = new Client({
      host: pgConfig.host,
      port: pgConfig.port,
      database: pgConfig.database,
      user: pgConfig.user,
      password: pgConfig.password,
      ssl: pgConfig.ssl,
    });
    await client.connect();
    return new PostgresClient(client);
  }

  async parseSchema(sql: string, filePath?: string): Promise<ParsedSchema> {
    const result = await this.parser.parseSchema(sql, filePath);
    return {
      tables: result.tables || [],
      enums: result.enums || [],
      views: result.views || [],
      functions: result.functions || [],
      procedures: result.procedures || [],
      triggers: result.triggers || [],
      sequences: result.sequences || [],
      extensions: result.extensions || [],
      schemas: result.schemas || [],
      comments: result.comments || [],
    };
  }

  async getCurrentSchema(
    client: DatabaseClient,
    schemas?: string[]
  ): Promise<Table[]> {
    const pgClient = (client as PostgresClient).raw;
    return this.inspector.getCurrentSchema(pgClient, schemas);
  }

  async getCurrentEnums(
    client: DatabaseClient,
    schemas?: string[]
  ): Promise<EnumType[]> {
    const pgClient = (client as PostgresClient).raw;
    return this.inspector.getCurrentEnums(pgClient, schemas);
  }

  async getCurrentViews(
    client: DatabaseClient,
    schemas?: string[]
  ): Promise<View[]> {
    const pgClient = (client as PostgresClient).raw;
    return this.inspector.getCurrentViews(pgClient, schemas);
  }

  async getCurrentFunctions(
    client: DatabaseClient,
    schemas?: string[]
  ): Promise<Function[]> {
    const pgClient = (client as PostgresClient).raw;
    return this.inspector.getCurrentFunctions(pgClient, schemas);
  }

  async getCurrentProcedures(
    client: DatabaseClient,
    schemas?: string[]
  ): Promise<Procedure[]> {
    const pgClient = (client as PostgresClient).raw;
    return this.inspector.getCurrentProcedures(pgClient, schemas);
  }

  async getCurrentTriggers(
    client: DatabaseClient,
    schemas?: string[]
  ): Promise<Trigger[]> {
    const pgClient = (client as PostgresClient).raw;
    return this.inspector.getCurrentTriggers(pgClient, schemas);
  }

  async getCurrentSequences(
    client: DatabaseClient,
    schemas?: string[]
  ): Promise<Sequence[]> {
    const pgClient = (client as PostgresClient).raw;
    return this.inspector.getCurrentSequences(pgClient, schemas);
  }

  async getCurrentExtensions(
    client: DatabaseClient,
    schemas?: string[]
  ): Promise<Extension[]> {
    const pgClient = (client as PostgresClient).raw;
    return this.inspector.getCurrentExtensions(pgClient, schemas);
  }

  async getCurrentSchemas(
    client: DatabaseClient,
    schemas?: string[]
  ): Promise<SchemaDefinition[]> {
    const pgClient = (client as PostgresClient).raw;
    return this.inspector.getCurrentSchemas(pgClient, schemas);
  }

  async getCurrentComments(
    client: DatabaseClient,
    schemas?: string[]
  ): Promise<Comment[]> {
    const pgClient = (client as PostgresClient).raw;
    return this.inspector.getCurrentComments(pgClient, schemas);
  }

  generateMigrationPlan(desired: Table[], current: Table[]): MigrationPlan {
    return this.differ.generateMigrationPlan(desired, current);
  }

  supportsFeature(_feature: DatabaseFeature): boolean {
    return true;
  }

  validateSchema(_schema: ParsedSchema): ValidationResult {
    return { valid: true, errors: [], warnings: [] };
  }

  async executeInTransaction(
    client: DatabaseClient,
    statements: string[]
  ): Promise<void> {
    const pgClient = (client as PostgresClient).raw;
    const ora = (await import("ora")).default;
    const spinner = ora({ text: "Applying changes...", color: "white" }).start();
    const startTime = Date.now();

    await pgClient.query("BEGIN");

    let currentStatement: string | undefined;
    try {
      for (const statement of statements) {
        if (statement.startsWith("--")) {
          continue;
        }
        currentStatement = statement;
        await pgClient.query(statement);
      }

      await pgClient.query("COMMIT");

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      spinner.stopAndPersist({ symbol: "✔", text: `Applied (${elapsed}s)` });
    } catch (error) {
      await pgClient.query("ROLLBACK");
      spinner.stopAndPersist({ symbol: "✗", text: "Failed to apply changes" });

      if (error && typeof error === "object" && "code" in error) {
        const pgError = error as Record<string, unknown>;
        throw new MigrationError(
          (pgError.message as string) || "Transaction failed",
          currentStatement,
          {
            code: pgError.code as string,
            detail: pgError.detail as string,
            hint: pgError.hint as string,
            position: pgError.position as string,
          }
        );
      }

      if (error instanceof MigrationError) {
        throw error;
      }

      throw new MigrationError(
        error instanceof Error ? error.message : String(error),
        currentStatement
      );
    }
  }

  async acquireAdvisoryLock(
    client: DatabaseClient,
    options: AdvisoryLockOptions
  ): Promise<void> {
    const pgClient = (client as PostgresClient).raw;
    const startTime = Date.now();
    const timeoutMs = options.lockTimeout;

    const lockKeyResult = await pgClient.query(
      "SELECT hashtext($1)::bigint as lock_key",
      [options.lockName]
    );
    const lockKey = lockKeyResult.rows[0].lock_key;

    let delay = 100;
    while (true) {
      const result = await pgClient.query(
        "SELECT pg_try_advisory_lock($1) as acquired",
        [lockKey]
      );

      if (result.rows[0].acquired) {
        return;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        throw new MigrationError(
          `Failed to acquire advisory lock '${options.lockName}' within ${timeoutMs / 1000}s. ` +
            `Another migration may be in progress. Please wait and try again.`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 5000);
    }
  }

  async releaseAdvisoryLock(
    client: DatabaseClient,
    lockName: string
  ): Promise<void> {
    const pgClient = (client as PostgresClient).raw;
    try {
      const lockKeyResult = await pgClient.query(
        "SELECT hashtext($1)::bigint as lock_key",
        [lockName]
      );
      const lockKey = lockKeyResult.rows[0].lock_key;
      await pgClient.query("SELECT pg_advisory_unlock($1)", [lockKey]);
    } catch (error) {
      Logger.warning(
        `Failed to explicitly release advisory lock '${lockName}': ${error}`
      );
    }
  }
}
