import type {
  PostgresGrantDefinition,
  PostgresGrantObjectType,
} from "../types/schema";

const SUPPORTED_PRIVILEGES: Record<PostgresGrantObjectType, Set<string>> = {
  TABLE: new Set([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
  ]),
  SEQUENCE: new Set(["USAGE", "SELECT", "UPDATE"]),
  SCHEMA: new Set(["CREATE", "USAGE"]),
  "FOREIGN SERVER": new Set(["USAGE"]),
};

export function isSupportedPostgresGrantPrivilege(
  objectType: PostgresGrantObjectType,
  privilege: string
): boolean {
  return SUPPORTED_PRIVILEGES[objectType].has(privilege.toUpperCase());
}

export function renderPostgresGrant(
  definition: PostgresGrantDefinition
): string {
  const option = definition.grantable ? " WITH GRANT OPTION" : "";
  return `${renderPostgresGrantIdentity(definition)}${option};`;
}

export function renderPostgresGrantRevoke(
  definition: PostgresGrantDefinition
): string {
  return `REVOKE ${definition.privilege} ON ${definition.objectType} ` +
    `${renderGrantTarget(definition)} FROM ${renderGrantee(definition)} ` +
    "RESTRICT;";
}

export function renderPostgresGrantOptionRevoke(
  definition: PostgresGrantDefinition
): string {
  return `REVOKE GRANT OPTION FOR ${definition.privilege} ON ` +
    `${definition.objectType} ${renderGrantTarget(definition)} FROM ` +
    `${renderGrantee(definition)} RESTRICT;`;
}

export function postgresGrantKey(
  definition: PostgresGrantDefinition
): string {
  return `grant:${renderPostgresGrantIdentity(definition)};`;
}

function renderPostgresGrantIdentity(
  definition: PostgresGrantDefinition
): string {
  return `GRANT ${definition.privilege} ON ${definition.objectType} ` +
    `${renderGrantTarget(definition)} TO ${renderGrantee(definition)}`;
}

function renderGrantTarget(definition: PostgresGrantDefinition): string {
  if (
    definition.objectType === "SCHEMA" ||
    definition.objectType === "FOREIGN SERVER"
  ) {
    return quoteIdentifier(definition.objectName);
  }
  return `${quoteIdentifier(definition.schema || "public")}.` +
    quoteIdentifier(definition.objectName);
}

function renderGrantee(definition: PostgresGrantDefinition): string {
  return definition.granteeIsPublic
    ? "PUBLIC"
    : quoteIdentifier(definition.grantee);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
