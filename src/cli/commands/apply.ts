import { SchemaService } from "../../core/schema/service";
import { buildStatementMetadata } from "../statement-metadata";
import { createProvider, parseConnectionString } from "../../providers";
import type { ConnectionConfig, PostgresConnectionConfig } from "../../providers/types";
import {
  CLI_OUTPUT_SCHEMA_VERSION,
  type CliApplyOutput,
  type CliOutputFormat,
  type CliPlanCounts,
} from "../../types/cli-output";
import { ValidationError } from "../../types/errors";
import type { MigrationPlan } from "../../types/migration";
import { Logger } from "../../utils/logger";

export type ApplyCliOptions = {
  file: string;
  schema: string[];
  autoApprove: boolean;
  dryRun: boolean;
  strict?: boolean;
  lockName: string;
  lockTimeout: string;
  format: string;
  ignorePrivileges?: boolean;
  ignoreComments?: boolean;
  ignoreConstraintValidation?: boolean;
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

export async function applyCommand(
  options: ApplyCliOptions,
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
): Promise<CliApplyOutput | undefined> {
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

  const provider = await createProvider(config.dialect);
  const schemaService = new SchemaService(provider, config);

  const lockTimeout = parseInt(options.lockTimeout, 10);
  if (isNaN(lockTimeout) || lockTimeout <= 0) {
    throw new ValidationError(
      "Invalid lock timeout: must be a positive number",
      "apply",
      "lock-timeout",
      options.lockTimeout
    );
  }

  const schemas = getSchemas(options.schema);
  const dryRun = options.dryRun === true;
  const strict = options.strict === true;
  const lockOptions = provider.supportsFeature("advisory_locks")
    ? {
        lockName: options.lockName,
        lockTimeout: lockTimeout * 1000,
      }
    : undefined;

  if (format === "text") {
    await schemaService.apply(
      options.file,
      schemas,
      options.autoApprove,
      lockOptions,
      dryRun,
      strict,
      {
        managePrivileges: options.ignorePrivileges !== true,
        manageComments: options.ignoreComments !== true,
        manageConstraintValidation:
          options.ignoreConstraintValidation !== true,
      }
    );
    return;
  }

  const plan = await schemaService.apply(
    options.file,
    schemas,
    options.autoApprove,
    lockOptions,
    dryRun,
    strict,
    {
      managePrivileges: options.ignorePrivileges !== true,
      manageComments: options.ignoreComments !== true,
      manageConstraintValidation:
        options.ignoreConstraintValidation !== true,
    }
  );

  return {
    schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
    command: "apply",
    dialect: config.dialect,
    file: options.file,
    schemas,
    dryRun,
    strict,
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
