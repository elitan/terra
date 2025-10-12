import { Client } from "pg";
import * as readline from "readline";
import type { MigrationPlan } from "../../types/migration";
import { DatabaseService } from "../database/client";
import { Logger } from "../../utils/logger";

export class MigrationExecutor {
  private databaseService: DatabaseService;

  constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService;
  }

  private isDestructiveOperation(statement: string): boolean {
    const upperStatement = statement.trim().toUpperCase();
    return (
      upperStatement.startsWith("DROP TABLE") ||
      upperStatement.includes("DROP COLUMN") ||
      upperStatement.startsWith("DROP TYPE") ||
      upperStatement.startsWith("DROP VIEW")
    );
  }

  private getDestructiveOperations(statements: string[]): string[] {
    return statements.filter((stmt) => this.isDestructiveOperation(stmt));
  }

  private async promptConfirmation(message: string): Promise<boolean> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(message, (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
      });
    });
  }

  async executePlan(client: Client, plan: MigrationPlan): Promise<void> {
    if (!plan.hasChanges) {
      Logger.success("✓ No changes needed - database is up to date");
      return;
    }

    // Check for destructive operations
    const allStatements = [...plan.transactional, ...plan.concurrent];
    const destructiveOps = this.getDestructiveOperations(allStatements);

    if (destructiveOps.length > 0) {
      Logger.warning("\n⚠️  WARNING: Destructive operations detected:");
      destructiveOps.forEach((stmt) => {
        Logger.error(`   ${stmt}`);
      });
      console.log();

      const confirmed = await this.promptConfirmation(
        "These operations may result in data loss. Continue? (y/N): "
      );

      if (!confirmed) {
        Logger.info("Migration cancelled by user");
        return;
      }
      console.log();
    }

    try {
      // Step 1: Execute all transactional statements within a single transaction
      if (plan.transactional.length > 0) {
        Logger.info("Applying transactional changes...");
        await this.databaseService.executeInTransaction(
          client,
          plan.transactional
        );
        Logger.success("✓ Transactional changes applied successfully");
      }

      // Step 2: Execute all concurrent statements individually
      if (plan.concurrent.length > 0) {
        Logger.info("Applying concurrent changes (these may take a while)...");
        for (const statement of plan.concurrent) {
          Logger.info(`Executing: ${statement}`);
          await client.query(statement);
          Logger.success(`✓ Executed: ${statement}`);
        }
        Logger.success("✓ Concurrent changes applied successfully");
      }
    } catch (error) {
      Logger.error("✗ Error applying changes:");
      // The error is logged here, but re-thrown to be handled by the caller
      // This ensures that the CLI exits with a non-zero code on failure
      throw error;
    }
  }
}
