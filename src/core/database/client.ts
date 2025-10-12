import { Client } from "pg";
import type { DatabaseConfig } from "../../types/config";
import { Logger } from "../../utils/logger";
import { MigrationError } from "../../types/errors";

export class DatabaseService {
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  async createClient(): Promise<Client> {
    const client = new Client(this.config);
    try {
      await client.connect();
      Logger.success("✓ Connected to PostgreSQL database");
      return client;
    } catch (error) {
      Logger.error("✗ Failed to connect to database:");
      console.error(error);
      process.exit(1);
    }
  }

  async executeInTransaction(
    client: Client,
    statements: string[]
  ): Promise<void> {
    await client.query("BEGIN");

    let currentStatement: string | undefined;
    try {
      for (const statement of statements) {
        if (statement.startsWith("--")) {
          Logger.warning("⚠️  Skipping: " + statement);
          continue;
        }

        currentStatement = statement;
        Logger.info("Executing: " + statement);
        await client.query(statement);
        Logger.success("✓ Done");
      }

      await client.query("COMMIT");
      Logger.success("🎉 All changes applied successfully!");
    } catch (error) {
      await client.query("ROLLBACK");

      // Check if this is a PostgreSQL error
      if (error && typeof error === 'object' && 'code' in error) {
        const pgError = error as any;

        throw new MigrationError(
          pgError.message || "Transaction failed",
          currentStatement,
          {
            code: pgError.code,
            detail: pgError.detail,
            hint: pgError.hint,
            position: pgError.position,
          }
        );
      }

      // If it's already a MigrationError, re-throw it
      if (error instanceof MigrationError) {
        throw error;
      }

      // Generic error
      throw new MigrationError(
        error instanceof Error ? error.message : String(error),
        currentStatement
      );
    }
  }
}
