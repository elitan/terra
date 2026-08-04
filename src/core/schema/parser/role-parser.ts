import { ParserError } from "../../../types/errors";
import type {
  PostgresRoleDefinition,
  SqlObject,
} from "../../../types/schema";
import {
  renderPostgresRoleCreate,
  renderPostgresRoleDrop,
} from "../../../utils/postgres-role";

type BooleanRoleField = Exclude<
  keyof PostgresRoleDefinition,
  "connectionLimit"
>;

const BOOLEAN_ROLE_OPTIONS = new Map<string, BooleanRoleField>([
  ["canlogin", "login"],
  ["superuser", "superuser"],
  ["createdb", "createDatabase"],
  ["createrole", "createRole"],
  ["inherit", "inherit"],
  ["isreplication", "replication"],
  ["bypassrls", "bypassRowLevelSecurity"],
]);

const UNSUPPORTED_ROLE_OPTIONS = new Map<string, string>([
  [
    "password",
    "PASSWORD is masked by pg_roles and cannot be compared losslessly",
  ],
  [
    "validUntil",
    "VALID UNTIL is password state and is not managed without passwords",
  ],
  ["addroleto", "IN ROLE membership must be managed with GRANT and REVOKE"],
  ["rolemembers", "ROLE membership must be managed with GRANT and REVOKE"],
  ["adminmembers", "ADMIN membership must be managed with GRANT and REVOKE"],
  ["sysid", "SYSID is ignored by PostgreSQL"],
]);

export function parsePostgresRole(
  stmt: any,
  filePath?: string
): SqlObject | null {
  const node = stmt?.CreateRoleStmt;
  const name = node?.role;
  if (typeof name !== "string" || name.length === 0) {
    return null;
  }
  if (
    node.stmt_type !== "ROLESTMT_ROLE" &&
    node.stmt_type !== "ROLESTMT_USER" &&
    node.stmt_type !== "ROLESTMT_GROUP"
  ) {
    throw new ParserError(
      `PostgreSQL role '${name}' has an unsupported creation form`,
      filePath
    );
  }

  const definition: PostgresRoleDefinition = {
    login: node.stmt_type === "ROLESTMT_USER",
    superuser: false,
    createDatabase: false,
    createRole: false,
    inherit: true,
    replication: false,
    bypassRowLevelSecurity: false,
    connectionLimit: -1,
  };
  const declaredOptions = new Set<string>();

  for (const optionNode of node.options || []) {
    const option = optionNode?.DefElem;
    const optionName = option?.defname;
    if (typeof optionName !== "string") {
      throw new ParserError(
        `PostgreSQL role '${name}' has a malformed option`,
        filePath
      );
    }
    if (declaredOptions.has(optionName)) {
      throw new ParserError(
        `PostgreSQL role '${name}' attribute '${optionName}' is declared more than once`,
        filePath
      );
    }
    declaredOptions.add(optionName);

    const unsupportedReason = UNSUPPORTED_ROLE_OPTIONS.get(optionName);
    if (unsupportedReason) {
      throw new ParserError(
        `PostgreSQL role option ${unsupportedReason}; it is not supported in desired schemas`,
        filePath
      );
    }
    if (optionName === "connectionlimit") {
      const connectionLimit = option.arg?.Integer?.ival;
      if (!Number.isInteger(connectionLimit) || connectionLimit < -1) {
        throw new ParserError(
          `PostgreSQL role '${name}' connection limit must be -1 or greater`,
          filePath
        );
      }
      definition.connectionLimit = connectionLimit;
      continue;
    }

    const field = BOOLEAN_ROLE_OPTIONS.get(optionName);
    const value = option.arg?.Boolean?.boolval;
    if (!field || typeof value !== "boolean") {
      throw new ParserError(
        `PostgreSQL role '${name}' option '${optionName}' is not supported in desired schemas because its persistent state is not modeled`,
        filePath
      );
    }
    definition[field] = value;
  }

  return {
    kind: "role",
    key: `role:${name}`,
    name,
    createStatement: renderPostgresRoleCreate(name, definition),
    dropStatement: renderPostgresRoleDrop(name),
    roleDefinition: definition,
  };
}
