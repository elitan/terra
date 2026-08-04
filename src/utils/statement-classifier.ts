import type {
  CliStatementCategory,
  CliStatementRisk,
} from "../types/cli-output";

export type StatementChannel =
  | "pre-transactional"
  | "transactional"
  | "deferred"
  | "concurrent";

function normalizeStatement(statement: string): string {
  return statement.trim().toUpperCase();
}

export function isDestructiveStatement(statement: string): boolean {
  const normalized = normalizeStatement(statement);
  return (
    normalized.startsWith("DROP ") ||
    normalized.includes(" DROP COLUMN ") ||
    normalized.includes(" DROP ATTRIBUTE ") ||
    normalized.includes(" DROP CONSTRAINT ") ||
    normalized.includes(" ALTER COLUMN ") ||
    normalized.includes(" SET DATA TYPE ")
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
    normalized.startsWith("CREATE TABLE") ||
    normalized.startsWith("ALTER TABLE") ||
    normalized.startsWith("DROP TABLE")
  ) {
    return "table";
  }
  if (
    normalized.startsWith("CREATE INDEX") ||
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
