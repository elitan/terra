/**
 * Schema Definition Parser
 *
 * Handles parsing of PostgreSQL CREATE SCHEMA statements from pgsql-parser AST.
 */

import type { SchemaDefinition } from "../../../types/schema";
import { ParserError } from "../../../types/errors";

const CONTEXTUAL_ROLE_NAMES: Readonly<Record<string, string>> = {
  ROLESPEC_CURRENT_ROLE: "CURRENT_ROLE",
  ROLESPEC_CURRENT_USER: "CURRENT_USER",
  ROLESPEC_SESSION_USER: "SESSION_USER",
};

/**
 * Parse CREATE SCHEMA statement from pgsql-parser AST
 */
export function parseCreateSchema(
  stmt: any,
  filePath?: string
): SchemaDefinition {
  if (Array.isArray(stmt?.schemaElts) && stmt.schemaElts.length > 0) {
    throw new ParserError(
      "PostgreSQL CREATE SCHEMA inline schema elements are not supported in desired schemas because their implicit namespace and ownership cannot be represented losslessly; declare the schema first, then use separate schema-qualified CREATE statements",
      filePath
    );
  }

  const owner = parseConcreteSchemaOwner(stmt?.authrole, filePath);
  const name = typeof stmt?.schemaname === "string" && stmt.schemaname.length > 0
    ? stmt.schemaname
    : owner;
  if (!name) {
    throw new ParserError(
      "PostgreSQL CREATE SCHEMA has no concrete schema name; specify a schema name or use AUTHORIZATION with a concrete role name",
      filePath
    );
  }

  if (owner) {
    return { name, owner };
  }

  return { name };
}

function parseConcreteSchemaOwner(
  role: any,
  filePath?: string
): string | undefined {
  if (!role) {
    return undefined;
  }

  if (
    role.roletype === "ROLESPEC_CSTRING" &&
    typeof role.rolename === "string" &&
    role.rolename.length > 0
  ) {
    return role.rolename;
  }

  const contextualName = CONTEXTUAL_ROLE_NAMES[role.roletype] || "contextual role";
  throw new ParserError(
    `PostgreSQL CREATE SCHEMA AUTHORIZATION ${contextualName} is not supported in desired schemas because it depends on the apply session; specify the concrete role name instead`,
    filePath
  );
}
