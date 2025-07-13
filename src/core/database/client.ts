import { Client } from "pg";
import type { DatabaseConfig } from "../../types/config";
import { Logger } from "../../utils/logger";

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

    try {
      for (const statement of statements) {
        if (statement.startsWith("--")) {
          Logger.warning("⚠️  Skipping: " + statement);
          continue;
        }

        Logger.info("Executing: " + statement);
        await client.query(statement);
        Logger.success("✓ Done");
      }

      await client.query("COMMIT");
      Logger.success("🎉 All changes applied successfully!");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}
