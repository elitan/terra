import { SchemaService } from "../../core/schema/service";
import { buildStatementMetadata } from "../statement-metadata";
import { createProvider, parseConnectionString } from "../../providers";
import type { ConnectionConfig, PostgresConnectionConfig } from "../../providers/types";
import {
  CLI_OUTPUT_SCHEMA_VERSION,
  type CliOutputFormat,
  type CliPlanCounts,
  type CliPlanOutput,
} from "../../types/cli-output";
import type { MigrationPlan } from "../../types/migration";
import { Logger } from "../../utils/logger";

export type PlanCliOptions = {
  file: string;
  schema: string[];
  format: string;
};

function normalizeFormat(format: string): CliOutputFormat {
  if (format === "text" || format === "json") {
    return format;
  }
  throw new Error(`Invalid format: ${format}. Expected text or json`);
}

function toCounts(plan: MigrationPlan): CliPlanCounts {
  const preTransactional = plan.preTransactional?.length ?? 0;
  const transactional = plan.transactional.length;
  const deferred = plan.deferred.length;
  const concurrent = plan.concurrent.length;
  return {
    preTransactional,
    transactional,
    deferred,
    concurrent,
    total: preTransactional + transactional + deferred + concurrent,
  };
}

function getSchemas(schemaOption: string[]): string[] {
  if (schemaOption && schemaOption.length > 0) {
    return schemaOption;
  }
  return ["public"];
}

export async function planCommand(
  options: PlanCliOptions,
  connectionStringOrConfig:
    | string
    | {
        host: string;
        port: number;
        database: string;
        user: string;
        password: string;
        ssl?: boolean | { rejectUnauthorized?: boolean };
      }
): Promise<CliPlanOutput | undefined> {
  let config: ConnectionConfig;

  if (typeof connectionStringOrConfig === "string") {
    config = parseConnectionString(connectionStringOrConfig);
  } else {
    config = {
      dialect: "postgres",
      ...connectionStringOrConfig,
    } as PostgresConnectionConfig;
  }

  const format = normalizeFormat(options.format);
  if (format === "json") {
    Logger.setSilent(true);
  }

  const schemas = getSchemas(options.schema);
  const provider = await createProvider(config.dialect);
  const schemaService = new SchemaService(provider, config);
  const plan = await schemaService.apply(
    options.file,
    schemas,
    true,
    undefined,
    true
  );

  if (format === "text") {
    return;
  }

  return {
    schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
    command: "plan",
    dialect: config.dialect,
    file: options.file,
    schemas,
    hasChanges: plan.hasChanges,
    counts: toCounts(plan),
    statements: {
      preTransactional: plan.preTransactional ?? [],
      transactional: plan.transactional,
      deferred: plan.deferred,
      concurrent: plan.concurrent,
    },
    statementMetadata: buildStatementMetadata(plan),
  };
}
