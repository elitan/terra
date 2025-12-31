import { Client } from "pg";
import type { DatabaseConfig } from "../../types/config";
import { Logger } from "../../utils/logger";
import { MigrationError } from "../../types/errors";

export interface AdvisoryLockOptions {
  lockName: string;
  lockTimeout: number; // in milliseconds
}

export class DatabaseService {
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  async createClient(): Promise<Client> {
    const client = new Client(this.config);
    try {
      await client.connect();
      return client;
    } catch (error) {
      Logger.error("Failed to connect to database:");
      console.error(error);
      process.exit(1);
    }
  }

  async executeInTransaction(
    client: Client,
    statements: string[]
  ): Promise<void> {
    const ora = (await import("ora")).default;
    const spinner = ora({ text: "Applying changes...", color: "white" }).start();
    const startTime = Date.now();

    await client.query("BEGIN");

    let currentStatement: string | undefined;
    try {
      for (const statement of statements) {
        if (statement.startsWith("--")) {
          continue;
        }

        currentStatement = statement;
        await client.query(statement);
      }

      await client.query("COMMIT");

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      spinner.stopAndPersist({ symbol: "✔", text: `Applied (${elapsed}s)` });
    } catch (error) {
      await client.query("ROLLBACK");
      spinner.stopAndPersist({ symbol: "✗", text: "Failed to apply changes" });

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

  /**
   * Acquire an advisory lock to prevent concurrent migrations.
   * Uses PostgreSQL's advisory lock mechanism with a timeout.
   */
  async acquireAdvisoryLock(client: Client, options: AdvisoryLockOptions): Promise<void> {
    const startTime = Date.now();
    const timeoutMs = options.lockTimeout;

    // Convert lock name to integer key using PostgreSQL's hashtext function
    const lockKeyResult = await client.query(
      "SELECT hashtext($1)::bigint as lock_key",
      [options.lockName]
    );
    const lockKey = lockKeyResult.rows[0].lock_key;

    // Try to acquire the lock with timeout logic
    let delay = 100;
    while (true) {
      const result = await client.query(
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

      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 5000);
    }
  }

  /**
   * Release an advisory lock after migration completion.
   */
  async releaseAdvisoryLock(client: Client, lockName: string): Promise<void> {
    try {
      // Convert lock name to integer key using PostgreSQL's hashtext function
      const lockKeyResult = await client.query(
        "SELECT hashtext($1)::bigint as lock_key",
        [lockName]
      );
      const lockKey = lockKeyResult.rows[0].lock_key;

      await client.query("SELECT pg_advisory_unlock($1)", [lockKey]);
    } catch (error) {
      // Log but don't throw - lock will be released when connection closes anyway
      Logger.warning(`Failed to explicitly release advisory lock '${lockName}': ${error}`);
    }
  }
}
