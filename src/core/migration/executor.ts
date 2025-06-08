import { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { DatabaseService } from "../database/client";
import { Logger } from "../../utils/logger";

export class MigrationExecutor {
  private databaseService: DatabaseService;

  constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService;
  }

  async executePlan(client: Client, plan: MigrationPlan): Promise<void> {
    if (!plan.hasChanges) {
      Logger.success("✓ No changes needed - database is up to date");
      return;
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
