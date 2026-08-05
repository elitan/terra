import type {
  CliStatementCategory,
  CliStatementRisk,
} from "../types/cli-output";

export type StatementChannel =
  | "pre-transactional"
  | "transactional"
  | "deferred"
  | "concurrent";

const POSTGRES_IDENTIFIER_PATTERN =
  String.raw`(?:"(?:[^"]|"")*"|[A-Z_][A-Z0-9_$]*)`;
const POSTGRES_QUALIFIED_IDENTIFIER_PATTERN =
  String.raw`${POSTGRES_IDENTIFIER_PATTERN}(?:\s*\.\s*${POSTGRES_IDENTIFIER_PATTERN})?`;
const POSTGRES_STRING_LITERAL_PATTERN = String.raw`'(?:[^']|'')*'`;
const ALTER_COLUMN_PREFIX =
  String.raw`\bALTER\s+COLUMN\s+${POSTGRES_IDENTIFIER_PATTERN}\s+`;
const ALTER_COLUMN_TYPE_PATTERN = new RegExp(
  ALTER_COLUMN_PREFIX + String.raw`(?:SET\s+DATA\s+)?TYPE\b`
);
const ALTER_COLUMN_DROP_DEFAULT_PATTERN = new RegExp(
  ALTER_COLUMN_PREFIX + String.raw`DROP\s+DEFAULT\b`
);
const ALTER_COLUMN_DROP_NOT_NULL_PATTERN = new RegExp(
  ALTER_COLUMN_PREFIX + String.raw`DROP\s+NOT\s+NULL\b`
);
const ALTER_COLUMN_DROP_IDENTITY_PATTERN = new RegExp(
  ALTER_COLUMN_PREFIX + String.raw`DROP\s+IDENTITY\b`
);
const ALTER_COLUMN_DROP_EXPRESSION_PATTERN = new RegExp(
  ALTER_COLUMN_PREFIX + String.raw`DROP\s+EXPRESSION\b`
);
const TABLE_TRIGGER_ENFORCEMENT_WEAKENING_PATTERN = new RegExp(
  String.raw`\b(?:DISABLE|ENABLE\s+REPLICA)\s+TRIGGER\s+${POSTGRES_IDENTIFIER_PATTERN}\s*;?$`
);
const EVENT_TRIGGER_ENFORCEMENT_WEAKENING_PATTERN = new RegExp(
  String.raw`^ALTER\s+EVENT\s+TRIGGER\s+${POSTGRES_IDENTIFIER_PATTERN}\s+(?:DISABLE|ENABLE\s+REPLICA)\s*;?$`
);
const REPLICA_IDENTITY_NOTHING_PATTERN =
  /\bREPLICA\s+IDENTITY\s+NOTHING\s*;?$/;
const NO_INHERIT_PARENT_PATTERN = new RegExp(
  String.raw`\bNO\s+INHERIT\s+${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}\s*;?$`
);
const DETACH_PARTITION_PATTERN = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}\s+` +
  String.raw`DETACH\s+PARTITION\s+${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}` +
  String.raw`(?:\s+(?:CONCURRENTLY|FINALIZE))?\s*;?$`
);
const ALTER_SCHEMA_OWNER_PATTERN = new RegExp(
  String.raw`^ALTER\s+SCHEMA\s+${POSTGRES_IDENTIFIER_PATTERN}\s+OWNER\s+TO\s+${POSTGRES_IDENTIFIER_PATTERN}\s*;?$`
);
const ALTER_SERVER_OPTION_ACTION_PATTERN =
  String.raw`(?:DROP\s+${POSTGRES_IDENTIFIER_PATTERN}|(?:ADD|SET)\s+${POSTGRES_IDENTIFIER_PATTERN}\s+${POSTGRES_STRING_LITERAL_PATTERN})`;
const ALTER_SERVER_OPTION_REMOVAL_PATTERN = new RegExp(
  String.raw`^ALTER\s+SERVER\s+${POSTGRES_IDENTIFIER_PATTERN}\s+` +
  String.raw`(?:VERSION\s+(?:NULL|${POSTGRES_STRING_LITERAL_PATTERN})\s+)?` +
  String.raw`OPTIONS\s*\(\s*(?:${ALTER_SERVER_OPTION_ACTION_PATTERN}\s*,\s*)*` +
  String.raw`DROP\s+${POSTGRES_IDENTIFIER_PATTERN}(?:\s*,|\s*\))`
);
const CREATE_SERVER_NAME_PATTERN = new RegExp(
  String.raw`^CREATE\s+SERVER\s+(?:IF\s+NOT\s+EXISTS\s+)?` +
  String.raw`(${POSTGRES_IDENTIFIER_PATTERN})\s+`,
  "i"
);
const ALTER_SERVER_OWNER_PATTERN = new RegExp(
  String.raw`^ALTER\s+SERVER\s+(${POSTGRES_IDENTIFIER_PATTERN})\s+` +
  String.raw`OWNER\s+TO\s+${POSTGRES_IDENTIFIER_PATTERN}\s*;?$`,
  "i"
);
const ALTER_SERVER_VERSION_REMOVAL_PATTERN = new RegExp(
  String.raw`^ALTER\s+SERVER\s+${POSTGRES_IDENTIFIER_PATTERN}\s+` +
  String.raw`VERSION\s+NULL\s*;?$`
);
const SEQUENCE_OWNERSHIP_REMOVAL_PATTERN = new RegExp(
  String.raw`^ALTER\s+SEQUENCE\s+(?:IF\s+EXISTS\s+)?${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}\s+OWNED\s+BY\s+NONE\s*;?$`
);
const COMMENT_REMOVAL_PATTERN = new RegExp(
  String.raw`^COMMENT\s+ON\s+(?:` +
  String.raw`SCHEMA\s+${POSTGRES_IDENTIFIER_PATTERN}|` +
  String.raw`COLUMN\s+${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}\s*\.\s*${POSTGRES_IDENTIFIER_PATTERN}|` +
  String.raw`(?:TABLE|VIEW|MATERIALIZED\s+VIEW|INDEX|SEQUENCE|TYPE|DOMAIN)\s+${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}` +
  String.raw`)\s+IS\s+NULL\s*;?$`
);
const CLUSTER_SELECTION_REMOVAL_PATTERN = new RegExp(
  String.raw`^ALTER\s+(?:` +
  String.raw`TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}(?:\s*\*)?|` +
  String.raw`MATERIALIZED\s+VIEW\s+(?:IF\s+EXISTS\s+)?${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}` +
  String.raw`)\s+SET\s+WITHOUT\s+CLUSTER\s*;?$`
);
const MATERIALIZED_VIEW_DEPOPULATION_PATTERN = new RegExp(
  String.raw`^REFRESH\s+MATERIALIZED\s+VIEW\s+(?:CONCURRENTLY\s+)?` +
  String.raw`${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}\s+WITH\s+NO\s+DATA\s*;?$`
);
const POSTGRES_VIEW_OPTION_NAME_PATTERN =
  String.raw`(?:CHECK_OPTION|SECURITY_BARRIER|SECURITY_INVOKER)`;
const ALTER_VIEW_OPTION_RESET_PATTERN = new RegExp(
  String.raw`^ALTER\s+VIEW\s+(?:IF\s+EXISTS\s+)?${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}\s+` +
  String.raw`RESET\s*\(\s*${POSTGRES_VIEW_OPTION_NAME_PATTERN}` +
  String.raw`(?:\s*,\s*${POSTGRES_VIEW_OPTION_NAME_PATTERN})*\s*\)\s*;?$`
);
const POSTGRES_VIEW_OPTION_ASSIGNMENT_PATTERN =
  String.raw`(?:CHECK_OPTION\s*=\s*(?:LOCAL|CASCADED)|SECURITY_(?:BARRIER|INVOKER)\s*=\s*(?:TRUE|FALSE))`;
const ALTER_VIEW_SECURITY_WEAKENING_PATTERN = new RegExp(
  String.raw`^ALTER\s+VIEW\s+(?:IF\s+EXISTS\s+)?${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}\s+` +
  String.raw`SET\s*\(\s*(?:${POSTGRES_VIEW_OPTION_ASSIGNMENT_PATTERN}\s*,\s*)*` +
  String.raw`SECURITY_(?:BARRIER|INVOKER)\s*=\s*FALSE(?:\s*,|\s*\))`
);
const ALTER_DOMAIN_WEAKENING_PATTERN = new RegExp(
  String.raw`^ALTER\s+DOMAIN\s+${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}\s+` +
  String.raw`DROP\s+(?:DEFAULT|NOT\s+NULL)\s*;?$`
);
const POSTGRES_STORAGE_PARAMETER_PATTERN =
  String.raw`${POSTGRES_IDENTIFIER_PATTERN}(?:\s*\.\s*${POSTGRES_IDENTIFIER_PATTERN})?`;
const POSTGRES_STORAGE_PARAMETER_LIST_PATTERN =
  String.raw`${POSTGRES_STORAGE_PARAMETER_PATTERN}(?:\s*,\s*${POSTGRES_STORAGE_PARAMETER_PATTERN})*`;
const POSTGRES_ALTER_TABLE_TARGET_PATTERN =
  String.raw`TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}(?:\s*\*)?`;
const POSTGRES_ALTER_MATERIALIZED_VIEW_TARGET_PATTERN =
  String.raw`MATERIALIZED\s+VIEW\s+(?:IF\s+EXISTS\s+)?${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}`;
const POSTGRES_ALTER_SEQUENCE_TARGET_PATTERN =
  String.raw`SEQUENCE\s+(?:IF\s+EXISTS\s+)?${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}`;
const ALTER_RELATION_STORAGE_RESET_PATTERN = new RegExp(
  String.raw`^ALTER\s+(?:${POSTGRES_ALTER_TABLE_TARGET_PATTERN}|` +
  String.raw`${POSTGRES_ALTER_MATERIALIZED_VIEW_TARGET_PATTERN})\s+` +
  String.raw`RESET\s*\(\s*${POSTGRES_STORAGE_PARAMETER_LIST_PATTERN}\s*\)\s*;?$`
);
const POSTGRES_DISTINCT_OPTION_PATTERN =
  String.raw`(?:N_DISTINCT|N_DISTINCT_INHERITED)`;
const ALTER_RELATION_DISTINCT_RESET_PATTERN = new RegExp(
  String.raw`^ALTER\s+(?:${POSTGRES_ALTER_TABLE_TARGET_PATTERN}|` +
  String.raw`${POSTGRES_ALTER_MATERIALIZED_VIEW_TARGET_PATTERN})\s+` +
  String.raw`ALTER\s+(?:COLUMN\s+)?${POSTGRES_IDENTIFIER_PATTERN}\s+` +
  String.raw`RESET\s*\(\s*${POSTGRES_DISTINCT_OPTION_PATTERN}` +
  String.raw`(?:\s*,\s*${POSTGRES_DISTINCT_OPTION_PATTERN})*\s*\)\s*;?$`
);
const ALTER_STATISTICS_TARGET_RESET_PATTERN = new RegExp(
  String.raw`^ALTER\s+(?:` +
  String.raw`(?:${POSTGRES_ALTER_TABLE_TARGET_PATTERN}|${POSTGRES_ALTER_MATERIALIZED_VIEW_TARGET_PATTERN})\s+` +
  String.raw`ALTER\s+(?:COLUMN\s+)?${POSTGRES_IDENTIFIER_PATTERN}|` +
  String.raw`INDEX\s+(?:IF\s+EXISTS\s+)?${POSTGRES_QUALIFIED_IDENTIFIER_PATTERN}\s+` +
  String.raw`ALTER\s+(?:COLUMN\s+)?\d+` +
  String.raw`)\s+SET\s+STATISTICS\s+-1\s*;?$`
);
const ALTER_SEQUENCE_CYCLE_PATTERN = new RegExp(
  String.raw`^ALTER\s+${POSTGRES_ALTER_SEQUENCE_TARGET_PATTERN}\s+CYCLE\s*;?$`
);
const ALTER_IDENTITY_SEQUENCE_CYCLE_PATTERN = new RegExp(
  String.raw`^ALTER\s+${POSTGRES_ALTER_TABLE_TARGET_PATTERN}\s+` +
  String.raw`ALTER\s+(?:COLUMN\s+)?${POSTGRES_IDENTIFIER_PATTERN}\s+` +
  String.raw`SET\s+CYCLE\s*;?$`
);
const ALTER_IDENTITY_GENERATION_WEAKENING_PATTERN = new RegExp(
  String.raw`^ALTER\s+${POSTGRES_ALTER_TABLE_TARGET_PATTERN}\s+` +
  String.raw`ALTER\s+(?:COLUMN\s+)?${POSTGRES_IDENTIFIER_PATTERN}\s+` +
  String.raw`SET\s+GENERATED\s+BY\s+DEFAULT\s*;?$`
);
const POSTGRES_ROLE_CAPABILITY_OPTION_PATTERN =
  String.raw`(?:LOGIN|NOLOGIN|SUPERUSER|NOSUPERUSER|CREATEDB|NOCREATEDB|CREATEROLE|NOCREATEROLE|INHERIT|NOINHERIT|REPLICATION|NOREPLICATION|BYPASSRLS|NOBYPASSRLS)`;
const POSTGRES_ROLE_CAPABILITY_REMOVAL_PATTERN =
  String.raw`(?:NOLOGIN|NOSUPERUSER|NOCREATEDB|NOCREATEROLE|NOINHERIT|NOREPLICATION|NOBYPASSRLS)`;
const ALTER_ROLE_CAPABILITY_REMOVAL_PATTERN = new RegExp(
  String.raw`^ALTER\s+ROLE\s+${POSTGRES_IDENTIFIER_PATTERN}\s+(?:WITH\s+)?` +
  String.raw`(?:${POSTGRES_ROLE_CAPABILITY_OPTION_PATTERN}\s+)*` +
  String.raw`${POSTGRES_ROLE_CAPABILITY_REMOVAL_PATTERN}\b`
);

function normalizeStatement(statement: string): string {
  return statement.trim().toUpperCase();
}

function normalizePostgresIdentifierToken(token: string): string {
  if (token.startsWith('"')) {
    return token.slice(1, -1).replace(/""/g, '"');
  }
  return token.toLowerCase();
}

function getMatchedPostgresIdentifier(
  pattern: RegExp,
  statement: string
): string | undefined {
  const match = pattern.exec(statement.trim());
  return match?.[1]
    ? normalizePostgresIdentifierToken(match[1])
    : undefined;
}

export function getCreatedPostgresServerName(
  statement: string
): string | undefined {
  return getMatchedPostgresIdentifier(CREATE_SERVER_NAME_PATTERN, statement);
}

export function getPostgresServerOwnerTransferName(
  statement: string
): string | undefined {
  return getMatchedPostgresIdentifier(ALTER_SERVER_OWNER_PATTERN, statement);
}

function hasDestructiveAlterColumn(statement: string): boolean {
  return (
    ALTER_COLUMN_TYPE_PATTERN.test(statement) ||
    ALTER_COLUMN_DROP_DEFAULT_PATTERN.test(statement) ||
    ALTER_COLUMN_DROP_NOT_NULL_PATTERN.test(statement) ||
    ALTER_COLUMN_DROP_IDENTITY_PATTERN.test(statement) ||
    ALTER_COLUMN_DROP_EXPRESSION_PATTERN.test(statement)
  );
}

function hasTriggerEnforcementWeakening(statement: string): boolean {
  return (
    TABLE_TRIGGER_ENFORCEMENT_WEAKENING_PATTERN.test(statement) ||
    EVENT_TRIGGER_ENFORCEMENT_WEAKENING_PATTERN.test(statement)
  );
}

export function isDestructiveStatement(statement: string): boolean {
  const normalized = normalizeStatement(statement);
  return (
    normalized.startsWith("DROP ") ||
    normalized.startsWith("REVOKE ") ||
    (
      normalized.startsWith("ALTER DEFAULT PRIVILEGES ") &&
      normalized.includes(" REVOKE ")
    ) ||
    normalized.includes(" DROP COLUMN ") ||
    normalized.includes(" DROP ATTRIBUTE ") ||
    normalized.includes(" DROP CONSTRAINT ") ||
    normalized.includes(" DISABLE ROW LEVEL SECURITY") ||
    normalized.includes(" NO FORCE ROW LEVEL SECURITY") ||
    normalized.includes(" SET UNLOGGED") ||
    hasTriggerEnforcementWeakening(normalized) ||
    REPLICA_IDENTITY_NOTHING_PATTERN.test(normalized) ||
    NO_INHERIT_PARENT_PATTERN.test(normalized) ||
    DETACH_PARTITION_PATTERN.test(normalized) ||
    ALTER_SCHEMA_OWNER_PATTERN.test(normalized) ||
    ALTER_SERVER_OPTION_REMOVAL_PATTERN.test(normalized) ||
    ALTER_SERVER_OWNER_PATTERN.test(normalized) ||
    ALTER_SERVER_VERSION_REMOVAL_PATTERN.test(normalized) ||
    SEQUENCE_OWNERSHIP_REMOVAL_PATTERN.test(normalized) ||
    COMMENT_REMOVAL_PATTERN.test(normalized) ||
    CLUSTER_SELECTION_REMOVAL_PATTERN.test(normalized) ||
    MATERIALIZED_VIEW_DEPOPULATION_PATTERN.test(normalized) ||
    ALTER_VIEW_OPTION_RESET_PATTERN.test(normalized) ||
    ALTER_VIEW_SECURITY_WEAKENING_PATTERN.test(normalized) ||
    ALTER_DOMAIN_WEAKENING_PATTERN.test(normalized) ||
    ALTER_RELATION_STORAGE_RESET_PATTERN.test(normalized) ||
    ALTER_RELATION_DISTINCT_RESET_PATTERN.test(normalized) ||
    ALTER_STATISTICS_TARGET_RESET_PATTERN.test(normalized) ||
    ALTER_SEQUENCE_CYCLE_PATTERN.test(normalized) ||
    ALTER_IDENTITY_SEQUENCE_CYCLE_PATTERN.test(normalized) ||
    ALTER_IDENTITY_GENERATION_WEAKENING_PATTERN.test(normalized) ||
    ALTER_ROLE_CAPABILITY_REMOVAL_PATTERN.test(normalized) ||
    hasDestructiveAlterColumn(normalized)
  );
}

export function getStatementRisk(
  statement: string,
  channel: StatementChannel
): CliStatementRisk {
  if (channel === "concurrent") {
    return "concurrent";
  }
  if (isDestructiveStatement(statement)) {
    return "destructive";
  }
  return "safe";
}

export function getStatementCategory(statement: string): CliStatementCategory {
  const normalized = normalizeStatement(statement);
  if (
    normalized.startsWith("ALTER TABLE") &&
    /\b(?:ADD|ALTER|VALIDATE|DROP|RENAME)\s+CONSTRAINT\b/.test(normalized)
  ) {
    return "constraint";
  }
  if (
    normalized.startsWith("CREATE TABLE") ||
    normalized.startsWith("ALTER TABLE") ||
    normalized.startsWith("DROP TABLE")
  ) {
    return "table";
  }
  if (
    normalized.startsWith("CREATE INDEX") ||
    normalized.startsWith("CREATE UNIQUE INDEX") ||
    normalized.startsWith("DROP INDEX")
  ) {
    return "index";
  }
  if (normalized.includes(" CONSTRAINT ")) {
    return "constraint";
  }
  if (
    normalized.startsWith("CREATE MATERIALIZED VIEW") ||
    normalized.startsWith("DROP MATERIALIZED VIEW")
  ) {
    return "materialized-view";
  }
  if (normalized.startsWith("CREATE VIEW") || normalized.startsWith("DROP VIEW")) {
    return "view";
  }
  if (
    (normalized.startsWith("CREATE TYPE") && normalized.includes(" AS ENUM")) ||
    (normalized.startsWith("ALTER TYPE") &&
      (normalized.includes(" ADD VALUE ") || normalized.includes(" RENAME VALUE ")))
  ) {
    return "enum";
  }
  if (
    normalized.startsWith("CREATE SEQUENCE") ||
    normalized.startsWith("ALTER SEQUENCE") ||
    normalized.startsWith("DROP SEQUENCE")
  ) {
    return "sequence";
  }
  if (
    normalized.startsWith("CREATE SCHEMA") ||
    normalized.startsWith("DROP SCHEMA")
  ) {
    return "schema";
  }
  if (
    normalized.startsWith("CREATE EXTENSION") ||
    normalized.startsWith("DROP EXTENSION")
  ) {
    return "extension";
  }
  if (
    normalized.startsWith("CREATE FUNCTION") ||
    normalized.startsWith("DROP FUNCTION")
  ) {
    return "function";
  }
  if (
    normalized.startsWith("CREATE PROCEDURE") ||
    normalized.startsWith("DROP PROCEDURE")
  ) {
    return "procedure";
  }
  if (
    normalized.startsWith("CREATE TRIGGER") ||
    normalized.startsWith("DROP TRIGGER")
  ) {
    return "trigger";
  }
  if (normalized.startsWith("COMMENT ON")) {
    return "comment";
  }
  if (
    normalized.startsWith("ALTER TYPE") ||
    normalized.startsWith("CREATE TYPE") ||
    normalized.startsWith("DROP TYPE") ||
    normalized.startsWith("CREATE DOMAIN") ||
    normalized.startsWith("ALTER DOMAIN") ||
    normalized.startsWith("DROP DOMAIN")
  ) {
    return "type";
  }
  return "other";
}
