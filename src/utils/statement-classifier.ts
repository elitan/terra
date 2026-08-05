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

function normalizeStatement(statement: string): string {
  return statement.trim().toUpperCase();
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
