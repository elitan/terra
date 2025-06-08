import { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { SchemaParser } from "./parser";
import { DatabaseInspector } from "./inspector";
import { MigrationPlanner } from "../migration/planner";
import { MigrationExecutor } from "../migration/executor";
import { DatabaseService } from "../database/client";
import { Logger } from "../../utils/logger";

export class SchemaService {
  private parser: SchemaParser;
  private inspector: DatabaseInspector;
  private planner: MigrationPlanner;
  private executor: MigrationExecutor;
  private databaseService: DatabaseService;

  constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService;
    this.parser = new SchemaParser();
    this.inspector = new DatabaseInspector();
    this.planner = new MigrationPlanner();
    this.executor = new MigrationExecutor(databaseService);
  }

  async plan(schemaFile: string = "schema.sql"): Promise<MigrationPlan> {
    Logger.info("📋 Analyzing schema changes...");

    const client = await this.databaseService.createClient();

    try {
      const desiredSchema = this.parser.parseSchemaFile(schemaFile);
      const currentSchema = await this.inspector.getCurrentSchema(client);
      const plan = this.planner.generatePlan(desiredSchema, currentSchema);

      if (!plan.hasChanges) {
        Logger.success("✓ No changes needed - database is up to date");
      } else {
        const totalChanges = plan.transactional.length + plan.concurrent.length;
        Logger.warning(`📝 Found ${totalChanges} change(s) to apply:`);
        console.log();

        if (plan.transactional.length > 0) {
          Logger.info("Transactional changes:");
          plan.transactional.forEach((stmt, i) => {
            Logger.cyan(`  ${i + 1}. ${stmt}`);
          });
        }

        if (plan.concurrent.length > 0) {
          Logger.info("Concurrent changes (non-transactional):");
          plan.concurrent.forEach((stmt, i) => {
            Logger.cyan(`  ${i + 1}. ${stmt}`);
          });
        }
      }

      return plan;
    } finally {
      await client.end();
    }
  }

  async apply(schemaFile: string = "schema.sql"): Promise<void> {
    Logger.info("🚀 Applying schema changes...");

    const client = await this.databaseService.createClient();

    try {
      const desiredSchema = this.parser.parseSchemaFile(schemaFile);
      const currentSchema = await this.inspector.getCurrentSchema(client);
      const plan = this.planner.generatePlan(desiredSchema, currentSchema);

      await this.executor.executePlan(client, plan);
    } finally {
      await client.end();
    }
  }
}
