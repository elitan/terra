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
      await this.databaseService.executeInTransaction(client, plan.statements);
    } catch (error) {
      Logger.error("✗ Error applying changes:");
      console.error(error);
      throw error;
    }
  }
}
