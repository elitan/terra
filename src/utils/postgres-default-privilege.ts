import type {
  PostgresDefaultPrivilegeDefinition,
  PostgresDefaultPrivilegeObjectType,
} from "../types/schema";

const SUPPORTED_PRIVILEGES: Record<
  PostgresDefaultPrivilegeObjectType,
  Set<string>
> = {
  TABLES: new Set([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
  ]),
  SEQUENCES: new Set(["USAGE", "SELECT", "UPDATE"]),
  ROUTINES: new Set(["EXECUTE"]),
  TYPES: new Set(["USAGE"]),
  SCHEMAS: new Set(["USAGE", "CREATE"]),
};

const CATALOG_OBJECT_TYPES = new Map<
  string,
  PostgresDefaultPrivilegeObjectType
>([
  ["r", "TABLES"],
  ["S", "SEQUENCES"],
  ["f", "ROUTINES"],
  ["T", "TYPES"],
  ["n", "SCHEMAS"],
]);

export function postgresDefaultPrivilegeObjectTypeFromCatalog(
  code: string
): PostgresDefaultPrivilegeObjectType | undefined {
  return CATALOG_OBJECT_TYPES.get(code);
}

export function isSupportedPostgresDefaultPrivilege(
  objectType: PostgresDefaultPrivilegeObjectType,
  privilege: string
): boolean {
  return SUPPORTED_PRIVILEGES[objectType].has(privilege.toUpperCase());
}

export function postgresDefaultPrivilegeBaselineGranted(
  definition: Pick<
    PostgresDefaultPrivilegeDefinition,
    | "owner"
    | "objectType"
    | "schema"
    | "grantee"
    | "granteeIsPublic"
    | "privilege"
  >
): boolean {
  if (definition.schema) {
    return false;
  }
  if (!definition.granteeIsPublic && definition.grantee === definition.owner) {
    return isSupportedPostgresDefaultPrivilege(
      definition.objectType,
      definition.privilege
    );
  }
  return definition.granteeIsPublic && (
    (definition.objectType === "ROUTINES" &&
      definition.privilege === "EXECUTE") ||
    (definition.objectType === "TYPES" && definition.privilege === "USAGE")
  );
}

export function postgresDefaultPrivilegeKey(
  definition: PostgresDefaultPrivilegeDefinition
): string {
  return `default-privilege:${renderIdentity(definition)}`;
}

export function renderPostgresDefaultPrivilegeState(
  definition: PostgresDefaultPrivilegeDefinition
): string {
  return definition.granted
    ? renderGrant(definition)
    : renderRevoke(definition);
}

export function renderPostgresDefaultPrivilegeRestore(
  definition: PostgresDefaultPrivilegeDefinition
): string {
  if (definition.baselineGranted) {
    if (definition.granted && definition.grantable) {
      return renderGrantOptionRevoke(definition);
    }
    return renderGrant({ ...definition, granted: true, grantable: false });
  }
  return renderRevoke({ ...definition, granted: false, grantable: false });
}

export function renderPostgresDefaultPrivilegeTransition(
  current: PostgresDefaultPrivilegeDefinition,
  desired: PostgresDefaultPrivilegeDefinition
): string | undefined {
  if (
    current.granted === desired.granted &&
    current.grantable === desired.grantable
  ) {
    return undefined;
  }
  if (!desired.granted) {
    return renderRevoke(desired);
  }
  if (current.granted && current.grantable && !desired.grantable) {
    return renderGrantOptionRevoke(desired);
  }
  return renderGrant(desired);
}

export function postgresDefaultPrivilegeMatchesBaseline(
  definition: PostgresDefaultPrivilegeDefinition
): boolean {
  return definition.granted === definition.baselineGranted &&
    definition.grantable === false;
}

function renderGrant(definition: PostgresDefaultPrivilegeDefinition): string {
  const option = definition.grantable ? " WITH GRANT OPTION" : "";
  return `${renderPrefix(definition)} GRANT ${definition.privilege} ON ` +
    `${definition.objectType} TO ${renderGrantee(definition)}${option};`;
}

function renderRevoke(definition: PostgresDefaultPrivilegeDefinition): string {
  return `${renderPrefix(definition)} REVOKE ${definition.privilege} ON ` +
    `${definition.objectType} FROM ${renderGrantee(definition)} RESTRICT;`;
}

function renderGrantOptionRevoke(
  definition: PostgresDefaultPrivilegeDefinition
): string {
  return `${renderPrefix(definition)} REVOKE GRANT OPTION FOR ` +
    `${definition.privilege} ON ${definition.objectType} FROM ` +
    `${renderGrantee(definition)} RESTRICT;`;
}

function renderPrefix(definition: PostgresDefaultPrivilegeDefinition): string {
  const schema = definition.schema
    ? ` IN SCHEMA ${quoteIdentifier(definition.schema)}`
    : "";
  return `ALTER DEFAULT PRIVILEGES FOR ROLE ` +
    `${quoteIdentifier(definition.owner)}${schema}`;
}

function renderIdentity(definition: PostgresDefaultPrivilegeDefinition): string {
  return `${renderPrefix(definition)} GRANT ${definition.privilege} ON ` +
    `${definition.objectType} TO ${renderGrantee(definition)};`;
}

function renderGrantee(definition: PostgresDefaultPrivilegeDefinition): string {
  return definition.granteeIsPublic
    ? "PUBLIC"
    : quoteIdentifier(definition.grantee);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
