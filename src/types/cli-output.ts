import type { DatabaseDialect } from "../providers/types";

export type CliOutputFormat = "text" | "json";
export const CLI_OUTPUT_SCHEMA_VERSION = 1;

export interface CliPlanCounts {
  transactional: number;
  deferred: number;
  concurrent: number;
  total: number;
}

export interface CliPlanStatements {
  transactional: string[];
  deferred: string[];
  concurrent: string[];
}

export type CliStatementChannel = "transactional" | "deferred" | "concurrent";
export type CliStatementRisk = "safe" | "destructive" | "concurrent";
export type CliStatementCategory =
  | "table"
  | "index"
  | "constraint"
  | "view"
  | "materialized-view"
  | "enum"
  | "sequence"
  | "schema"
  | "extension"
  | "function"
  | "procedure"
  | "trigger"
  | "comment"
  | "type"
  | "other";

export interface CliStatementMetadata {
  order: number;
  channel: CliStatementChannel;
  category: CliStatementCategory;
  risk: CliStatementRisk;
  sql: string;
}

export interface CliPlanOutput {
  schemaVersion: number;
  command: "plan";
  dialect: DatabaseDialect;
  file: string;
  schemas: string[];
  hasChanges: boolean;
  counts: CliPlanCounts;
  statements: CliPlanStatements;
  statementMetadata: CliStatementMetadata[];
}

export interface CliApplyOutput {
  schemaVersion: number;
  command: "apply";
  dialect: DatabaseDialect;
  file: string;
  schemas: string[];
  dryRun: boolean;
  strict: boolean;
  hasChanges: boolean;
  counts: CliPlanCounts;
  statements: CliPlanStatements;
  statementMetadata: CliStatementMetadata[];
}
