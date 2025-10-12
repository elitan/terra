import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import type { DatabaseConfig } from "../../types/config";

export async function applyCommand(
  options: { file: string; autoApprove: boolean; lockName: string; lockTimeout: string },
  config: DatabaseConfig
) {
  const databaseService = new DatabaseService(config);
  const schemaService = new SchemaService(databaseService);

  const lockTimeout = parseInt(options.lockTimeout, 10);
  if (isNaN(lockTimeout) || lockTimeout <= 0) {
    throw new Error("Invalid lock timeout: must be a positive number");
  }

  await schemaService.apply(options.file, options.autoApprove, {
    lockName: options.lockName,
    lockTimeout: lockTimeout * 1000 // Convert seconds to milliseconds
  });
}
