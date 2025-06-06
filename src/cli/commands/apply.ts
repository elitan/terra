import { SchemaService } from "../../core/schema/service";
import { DatabaseService } from "../../core/database/client";
import type { DatabaseConfig } from "../../types/config";

export async function applyCommand(
  options: { file: string },
  config: DatabaseConfig
) {
  const databaseService = new DatabaseService(config);
  const schemaService = new SchemaService(databaseService);
  await schemaService.apply(options.file);
}
