import type { DatabaseDialect } from "../../providers/types";

export type ScenarioOperation =
  | "create"
  | "alter"
  | "drop"
  | "idempotent-reapply"
  | "rollback-on-error";

export interface ScenarioStep {
  id: string;
  sql: string;
  operation: ScenarioOperation;
}

export interface TestScenario {
  id: string;
  dialects: DatabaseDialect[];
  schemas: string[];
  steps: ScenarioStep[];
  tags: string[];
}

export type ScenarioFeature =
  | "table"
  | "column"
  | "constraint"
  | "index"
  | "view"
  | "enum"
  | "sequence"
  | "function"
  | "procedure"
  | "trigger"
  | "extension"
  | "comment";

export interface ScenarioExpectation {
  shouldSucceed: boolean;
  hasChanges?: boolean;
  expectedErrorCode?: string;
}

export interface MatrixScenarioSpec {
  id: string;
  dialect: DatabaseDialect;
  feature: ScenarioFeature;
  operation: ScenarioOperation;
  expected: ScenarioExpectation;
}
