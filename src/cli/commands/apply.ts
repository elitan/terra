import { SchemaService } from "../../core/schema/service";
import {
  createProvider,
  parseConnectionString,
  detectDialect,
} from "../../providers";
import type { ConnectionConfig, PostgresConnectionConfig } from "../../providers/types";

export async function applyCommand(
  options: { file: string; schema: string[]; autoApprove: boolean; dryRun: boolean; lockName: string; lockTimeout: string },
  connectionStringOrConfig: string | { host: string; port: number; database: string; user: string; password: string; ssl?: boolean | { rejectUnauthorized?: boolean } }
) {
  let config: ConnectionConfig;

  if (typeof connectionStringOrConfig === "string") {
    config = parseConnectionString(connectionStringOrConfig);
  } else {
    config = {
      dialect: "postgres",
      ...connectionStringOrConfig,
    } as PostgresConnectionConfig;
  }

  const provider = await createProvider(config.dialect);
  const schemaService = new SchemaService(provider, config);

  const lockTimeout = parseInt(options.lockTimeout, 10);
  if (isNaN(lockTimeout) || lockTimeout <= 0) {
    throw new Error("Invalid lock timeout: must be a positive number");
  }

  const schemas = options.schema && options.schema.length > 0 ? options.schema : ['public'];

  const lockOptions = provider.supportsFeature("advisory_locks")
    ? {
        lockName: options.lockName,
        lockTimeout: lockTimeout * 1000
      }
    : undefined;

  await schemaService.apply(options.file, schemas, options.autoApprove, lockOptions, options.dryRun);
}
