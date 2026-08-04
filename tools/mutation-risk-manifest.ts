export type MutationRiskLevel = "low" | "medium" | "high" | "critical";

export interface MutationRiskEntry {
  path: string;
  owner: string;
  level: MutationRiskLevel;
  reason: string;
}

export interface MutationRiskManifest {
  version: number;
  entries: MutationRiskEntry[];
}

export const mutationRiskManifest: MutationRiskManifest = {
  version: 1,
  entries: [
    {
      path: "src/core/schema/differ.ts",
      owner: "core-schema",
      level: "critical",
      reason: "directly controls migration safety and idempotency",
    },
    {
      path: "src/core/schema/service.ts",
      owner: "core-service",
      level: "critical",
      reason: "applies plans and controls lock/prompt/strict behavior",
    },
    {
      path: "src/core/schema/parser",
      owner: "core-parser",
      level: "high",
      reason: "parser drift causes false diffs and migration risk",
    },
    {
      path: "src/core/schema/handlers",
      owner: "core-schema",
      level: "critical",
      reason: "object handlers control lifecycle ordering and destructive-change safety",
    },
    {
      path: "src/core/schema/inspector.ts",
      owner: "core-inspector",
      level: "high",
      reason: "introspection drift causes incorrect change plans",
    },
    {
      path: "src/providers/sqlite/index.ts",
      owner: "sqlite-provider",
      level: "critical",
      reason: "controls SQLite migration atomicity and integrity verification",
    },
  ],
};
