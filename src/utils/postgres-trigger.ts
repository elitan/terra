import type {
  PostgresTriggerEnabledMode,
  QualifiedName,
} from "../types/schema";

const TRIGGER_MODE_BY_CATALOG_CODE: Record<
  string,
  PostgresTriggerEnabledMode
> = {
  O: "origin",
  D: "disabled",
  R: "replica",
  A: "always",
};

export function postgresTriggerModeFromCatalogCode(
  code: unknown
): PostgresTriggerEnabledMode | undefined {
  if (typeof code !== "string") {
    return undefined;
  }
  return TRIGGER_MODE_BY_CATALOG_CODE[code];
}

export function effectivePostgresTriggerMode(
  mode: PostgresTriggerEnabledMode | undefined
): PostgresTriggerEnabledMode {
  return mode || "origin";
}

export function renderPostgresTableTriggerMode(
  table: QualifiedName,
  triggerName: string,
  mode: PostgresTriggerEnabledMode
): string {
  return `ALTER TABLE ${renderQualifiedName(table)} ${triggerModeAction(mode)} TRIGGER ${quoteIdentifier(triggerName)};`;
}

export function renderPostgresEventTriggerMode(
  triggerName: string,
  mode: PostgresTriggerEnabledMode
): string {
  return `ALTER EVENT TRIGGER ${quoteIdentifier(triggerName)} ${triggerModeAction(mode)};`;
}

function triggerModeAction(mode: PostgresTriggerEnabledMode): string {
  switch (mode) {
    case "origin":
      return "ENABLE";
    case "disabled":
      return "DISABLE";
    case "replica":
      return "ENABLE REPLICA";
    case "always":
      return "ENABLE ALWAYS";
  }
}

function renderQualifiedName(name: QualifiedName): string {
  const relation = quoteIdentifier(name.name);
  return name.schema
    ? `${quoteIdentifier(name.schema)}.${relation}`
    : relation;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
