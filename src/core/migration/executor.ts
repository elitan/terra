import { Client } from "pg";
import * as readline from "readline";
import type { MigrationPlan } from "../../types/migration";
import { DatabaseService } from "../database/client";
import { Logger } from "../../utils/logger";
import { MigrationError } from "../../types/errors";

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

  async executePlan(client: Client, plan: MigrationPlan, autoApprove: boolean = false): Promise<void> {
    if (!plan.hasChanges) {
      Logger.success("No changes needed - database is up to date");
      return;
    }


    try {
      // Step 1: Execute all transactional statements within a single transaction
      if (plan.transactional.length > 0) {
        await this.databaseService.executeInTransaction(
          client,
          plan.transactional
        );
      }

      // Step 2: Execute all concurrent statements individually
      if (plan.concurrent.length > 0) {
        const ora = (await import("ora")).default;

        for (const statement of plan.concurrent) {
          const spinner = ora({ text: "Applying concurrent change (may take a while)...", color: "white" }).start();
          const startTime = Date.now();

          try {
            await client.query(statement);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            spinner.stopAndPersist({ symbol: "✔", text: `Applied concurrent change (${elapsed}s)` });
          } catch (error) {
            spinner.stopAndPersist({ symbol: "✗", text: "Failed to apply concurrent change" });
            throw error;
          }
        }
      }
    } catch (error) {
      // Check if this is a PostgreSQL error with additional context
      if (error && typeof error === 'object' && 'code' in error) {
        const pgError = error as any;

        // Try to determine which statement failed
        let failedStatement: string | undefined;
        if (pgError.message) {
          // If we're in the middle of executing statements, the current statement is in the error
          failedStatement = undefined; // We'll let the caller determine this
        }

        throw new MigrationError(
          pgError.message || "Database migration failed",
          failedStatement,
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
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
