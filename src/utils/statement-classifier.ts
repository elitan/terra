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
const ALTER_COLUMN_COMPRESSION_RESET_PATTERN = new RegExp(
  String.raw`^ALTER\s+${POSTGRES_ALTER_TABLE_TARGET_PATTERN}\s+` +
  String.raw`ALTER\s+(?:COLUMN\s+)?${POSTGRES_IDENTIFIER_PATTERN}\s+` +
  String.raw`SET\s+COMPRESSION\s+DEFAULT\s*;?$`
);
const ALTER_RELATION_ACCESS_METHOD_PATTERN = new RegExp(
  String.raw`^ALTER\s+(?:${POSTGRES_ALTER_TABLE_TARGET_PATTERN}|` +
  String.raw`${POSTGRES_ALTER_MATERIALIZED_VIEW_TARGET_PATTERN})\s+` +
  String.raw`[\s\S]*?\bSET\s+ACCESS\s+METHOD\s+` +
  String.raw`(?:DEFAULT|${POSTGRES_IDENTIFIER_PATTERN})(?:\s*,|\s*;?\s*$)`
);
const ALTER_RELATION_TABLESPACE_PATTERN = new RegExp(
  String.raw`^ALTER\s+(?:${POSTGRES_ALTER_TABLE_TARGET_PATTERN}|` +
  String.raw`${POSTGRES_ALTER_MATERIALIZED_VIEW_TARGET_PATTERN})\s+` +
  String.raw`[\s\S]*?\bSET\s+TABLESPACE\s+${POSTGRES_IDENTIFIER_PATTERN}` +
  String.raw`(?:\s*,|\s*;?\s*$)`
);
const ALTER_SEQUENCE_DATA_TYPE_PATTERN = new RegExp(
  String.raw`^ALTER\s+${POSTGRES_ALTER_SEQUENCE_TARGET_PATTERN}\s+` +
  String.raw`AS\s+(?:SMALLINT|INTEGER|BIGINT)(?:\s|;|$)`
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
const ALTER_ROLE_CONNECTION_LIMIT_REMOVAL_PATTERN = new RegExp(
  String.raw`^ALTER\s+ROLE\s+${POSTGRES_IDENTIFIER_PATTERN}\s+(?:WITH\s+)?` +
  String.raw`(?:${POSTGRES_ROLE_CAPABILITY_OPTION_PATTERN}\s+)*` +
  String.raw`CONNECTION\s+LIMIT\s+-1\s*;?$`
);

function normalizeStatement(statement: string): string {
  return statement.trim().toUpperCase();
}

function findDelimitedTokenEnd(
  statement: string,
  start: number,
  closingDelimiter: string,
  allowBackslashEscapes: boolean
): number {
  let index = start + 1;
  while (index < statement.length) {
    if (allowBackslashEscapes && statement[index] === "\\") {
      index += 2;
      continue;
    }
    if (statement[index] !== closingDelimiter) {
      index += 1;
      continue;
    }
    if (statement[index + 1] === closingDelimiter) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return statement.length;
}

function findBlockCommentEnd(statement: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < statement.length && depth > 0) {
    if (statement.slice(index, index + 2) === "/*") {
      depth += 1;
      index += 2;
    } else if (statement.slice(index, index + 2) === "*/") {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}

function findDollarQuotedEnd(
  statement: string,
  start: number
): number | undefined {
  const tag = statement.slice(start).match(/^\$(?:[A-Z_][A-Z0-9_]*)?\$/)?.[0];
  if (!tag) {
    return undefined;
  }
  const end = statement.indexOf(tag, start + tag.length);
  return end === -1 ? statement.length : end + tag.length;
}

function maskTokenContent(
  characters: string[],
  start: number,
  end: number
): void {
  for (let index = start; index < end; index += 1) {
    const character = characters[index]!;
    if (/\s/.test(character)) {
      continue;
    }
    characters[index] = " ";
  }
}

function maskSqlNonKeywordContent(statement: string): string {
  const characters = statement.split("");
  let index = 0;
  while (index < statement.length) {
    let end: number | undefined;
    let contentStart = index;
    let contentEnd: number | undefined;
    const character = statement[index]!;

    if (statement.slice(index, index + 2) === "--") {
      const lineEnd = statement.indexOf("\n", index + 2);
      end = lineEnd === -1 ? statement.length : lineEnd;
    } else if (statement.slice(index, index + 2) === "/*") {
      end = findBlockCommentEnd(statement, index);
    } else if (character === "'" || character === '"' || character === "`") {
      const isEscapeString = character === "'" &&
        statement[index - 1] === "E" &&
        !/[A-Z0-9_$]/.test(statement[index - 2] || "");
      end = findDelimitedTokenEnd(statement, index, character, isEscapeString);
      contentStart = index + 1;
      contentEnd = end - 1;
    } else if (character === "[") {
      end = findDelimitedTokenEnd(statement, index, "]", false);
      contentStart = index + 1;
      contentEnd = end - 1;
    } else if (character === "$") {
      end = findDollarQuotedEnd(statement, index);
    }

    if (end === undefined) {
      index += 1;
      continue;
    }
    maskTokenContent(characters, contentStart, contentEnd ?? end);
    index = end;
  }
  return characters.join("");
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
  const syntax = maskSqlNonKeywordContent(normalized);
  return (
    syntax.startsWith("DROP ") ||
    syntax.startsWith("REVOKE ") ||
    (
      syntax.startsWith("ALTER DEFAULT PRIVILEGES ") &&
      syntax.includes(" REVOKE ")
    ) ||
    syntax.includes(" DROP COLUMN ") ||
    syntax.includes(" DROP ATTRIBUTE ") ||
    syntax.includes(" DROP CONSTRAINT ") ||
    syntax.includes(" DISABLE ROW LEVEL SECURITY") ||
    syntax.includes(" NO FORCE ROW LEVEL SECURITY") ||
    syntax.includes(" SET UNLOGGED") ||
    hasTriggerEnforcementWeakening(syntax) ||
    REPLICA_IDENTITY_NOTHING_PATTERN.test(syntax) ||
    NO_INHERIT_PARENT_PATTERN.test(syntax) ||
    DETACH_PARTITION_PATTERN.test(syntax) ||
    ALTER_SCHEMA_OWNER_PATTERN.test(syntax) ||
    ALTER_SERVER_OPTION_REMOVAL_PATTERN.test(syntax) ||
    ALTER_SERVER_OWNER_PATTERN.test(syntax) ||
    ALTER_SERVER_VERSION_REMOVAL_PATTERN.test(syntax) ||
    SEQUENCE_OWNERSHIP_REMOVAL_PATTERN.test(syntax) ||
    COMMENT_REMOVAL_PATTERN.test(syntax) ||
    CLUSTER_SELECTION_REMOVAL_PATTERN.test(syntax) ||
    MATERIALIZED_VIEW_DEPOPULATION_PATTERN.test(syntax) ||
    ALTER_VIEW_OPTION_RESET_PATTERN.test(syntax) ||
    ALTER_VIEW_SECURITY_WEAKENING_PATTERN.test(syntax) ||
    ALTER_DOMAIN_WEAKENING_PATTERN.test(syntax) ||
    ALTER_RELATION_STORAGE_RESET_PATTERN.test(syntax) ||
    ALTER_RELATION_DISTINCT_RESET_PATTERN.test(syntax) ||
    ALTER_STATISTICS_TARGET_RESET_PATTERN.test(syntax) ||
    ALTER_COLUMN_COMPRESSION_RESET_PATTERN.test(syntax) ||
    ALTER_RELATION_ACCESS_METHOD_PATTERN.test(syntax) ||
    ALTER_RELATION_TABLESPACE_PATTERN.test(syntax) ||
    ALTER_SEQUENCE_DATA_TYPE_PATTERN.test(syntax) ||
    ALTER_SEQUENCE_CYCLE_PATTERN.test(syntax) ||
    ALTER_IDENTITY_SEQUENCE_CYCLE_PATTERN.test(syntax) ||
    ALTER_IDENTITY_GENERATION_WEAKENING_PATTERN.test(syntax) ||
    ALTER_ROLE_CAPABILITY_REMOVAL_PATTERN.test(syntax) ||
    ALTER_ROLE_CONNECTION_LIMIT_REMOVAL_PATTERN.test(syntax) ||
    hasDestructiveAlterColumn(syntax)
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
  const syntax = maskSqlNonKeywordContent(normalized);
  if (
    normalized.startsWith("CREATE TRIGGER") ||
    normalized.startsWith("CREATE CONSTRAINT TRIGGER") ||
    normalized.startsWith("CREATE EVENT TRIGGER") ||
    normalized.startsWith("DROP TRIGGER") ||
    normalized.startsWith("DROP EVENT TRIGGER") ||
    normalized.startsWith("ALTER EVENT TRIGGER") ||
    normalized.startsWith("ALTER TRIGGER") ||
    (
      normalized.startsWith("ALTER TABLE") &&
      /\b(?:DISABLE|ENABLE(?:\s+(?:REPLICA|ALWAYS))?)\s+TRIGGER\b/.test(
        syntax
      )
    )
  ) {
    return "trigger";
  }
  if (
    normalized.startsWith("ALTER TABLE") &&
    /\b(?:ADD|ALTER|VALIDATE|DROP|RENAME)\s+CONSTRAINT\b/.test(syntax)
  ) {
    return "constraint";
  }
  if (
    normalized.startsWith("CREATE TABLE") ||
    normalized.startsWith("CREATE UNLOGGED TABLE") ||
    normalized.startsWith("CREATE VIRTUAL TABLE") ||
    normalized.startsWith("ALTER TABLE") ||
    normalized.startsWith("DROP TABLE")
  ) {
    return "table";
  }
  if (
    normalized.startsWith("CREATE INDEX") ||
    normalized.startsWith("CREATE UNIQUE INDEX") ||
    normalized.startsWith("ALTER INDEX") ||
    normalized.startsWith("DROP INDEX")
  ) {
    return "index";
  }
  if (
    normalized.startsWith("ALTER DOMAIN") &&
    /\b(?:ADD|DROP|RENAME|VALIDATE)\s+CONSTRAINT\b/.test(syntax)
  ) {
    return "constraint";
  }
  if (
    normalized.startsWith("CREATE MATERIALIZED VIEW") ||
    normalized.startsWith("ALTER MATERIALIZED VIEW") ||
    normalized.startsWith("REFRESH MATERIALIZED VIEW") ||
    normalized.startsWith("DROP MATERIALIZED VIEW")
  ) {
    return "materialized-view";
  }
  if (
    normalized.startsWith("CREATE VIEW") ||
    normalized.startsWith("CREATE OR REPLACE VIEW") ||
    normalized.startsWith("ALTER VIEW") ||
    normalized.startsWith("DROP VIEW")
  ) {
    return "view";
  }
  if (
    (normalized.startsWith("CREATE TYPE") && syntax.includes(" AS ENUM")) ||
    (normalized.startsWith("ALTER TYPE") &&
      (syntax.includes(" ADD VALUE ") || syntax.includes(" RENAME VALUE ")))
  ) {
    return "enum";
  }
  if (
    normalized.startsWith("CREATE SEQUENCE") ||
    normalized.startsWith("CREATE UNLOGGED SEQUENCE") ||
    normalized.startsWith("ALTER SEQUENCE") ||
    normalized.startsWith("DROP SEQUENCE")
  ) {
    return "sequence";
  }
  if (
    normalized.startsWith("CREATE SCHEMA") ||
    normalized.startsWith("ALTER SCHEMA") ||
    normalized.startsWith("DROP SCHEMA")
  ) {
    return "schema";
  }
  if (
    normalized.startsWith("CREATE EXTENSION") ||
    normalized.startsWith("ALTER EXTENSION") ||
    normalized.startsWith("DROP EXTENSION")
  ) {
    return "extension";
  }
  if (
    normalized.startsWith("CREATE FUNCTION") ||
    normalized.startsWith("CREATE OR REPLACE FUNCTION") ||
    normalized.startsWith("DROP FUNCTION")
  ) {
    return "function";
  }
  if (
    normalized.startsWith("CREATE PROCEDURE") ||
    normalized.startsWith("CREATE OR REPLACE PROCEDURE") ||
    normalized.startsWith("DROP PROCEDURE")
  ) {
    return "procedure";
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
