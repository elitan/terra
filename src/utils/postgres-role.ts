import type { PostgresRoleDefinition } from "../types/schema";

export function renderPostgresRoleCreate(
  name: string,
  definition: PostgresRoleDefinition
): string {
  return `CREATE ROLE ${quoteIdentifier(name)} WITH ${renderRoleOptions(definition)};`;
}

export function renderPostgresRoleAlter(
  name: string,
  current: PostgresRoleDefinition,
  desired: PostgresRoleDefinition
): string | undefined {
  const options: string[] = [];
  if (current.login !== desired.login) {
    options.push(desired.login ? "LOGIN" : "NOLOGIN");
  }
  if (current.superuser !== desired.superuser) {
    options.push(desired.superuser ? "SUPERUSER" : "NOSUPERUSER");
  }
  if (current.createDatabase !== desired.createDatabase) {
    options.push(desired.createDatabase ? "CREATEDB" : "NOCREATEDB");
  }
  if (current.createRole !== desired.createRole) {
    options.push(desired.createRole ? "CREATEROLE" : "NOCREATEROLE");
  }
  if (current.inherit !== desired.inherit) {
    options.push(desired.inherit ? "INHERIT" : "NOINHERIT");
  }
  if (current.replication !== desired.replication) {
    options.push(desired.replication ? "REPLICATION" : "NOREPLICATION");
  }
  if (
    current.bypassRowLevelSecurity !== desired.bypassRowLevelSecurity
  ) {
    options.push(
      desired.bypassRowLevelSecurity ? "BYPASSRLS" : "NOBYPASSRLS"
    );
  }
  if (current.connectionLimit !== desired.connectionLimit) {
    options.push(`CONNECTION LIMIT ${desired.connectionLimit}`);
  }
  if (options.length === 0) {
    return undefined;
  }
  return `ALTER ROLE ${quoteIdentifier(name)} WITH ${options.join(" ")};`;
}

export function renderPostgresRoleDrop(name: string): string {
  return `DROP ROLE IF EXISTS ${quoteIdentifier(name)};`;
}

export function postgresRoleDefinitionsEqual(
  left: PostgresRoleDefinition,
  right: PostgresRoleDefinition
): boolean {
  return left.login === right.login &&
    left.superuser === right.superuser &&
    left.createDatabase === right.createDatabase &&
    left.createRole === right.createRole &&
    left.inherit === right.inherit &&
    left.replication === right.replication &&
    left.bypassRowLevelSecurity === right.bypassRowLevelSecurity &&
    left.connectionLimit === right.connectionLimit;
}

function renderRoleOptions(definition: PostgresRoleDefinition): string {
  return [
    definition.login ? "LOGIN" : "NOLOGIN",
    definition.superuser ? "SUPERUSER" : "NOSUPERUSER",
    definition.createDatabase ? "CREATEDB" : "NOCREATEDB",
    definition.createRole ? "CREATEROLE" : "NOCREATEROLE",
    definition.inherit ? "INHERIT" : "NOINHERIT",
    definition.replication ? "REPLICATION" : "NOREPLICATION",
    definition.bypassRowLevelSecurity ? "BYPASSRLS" : "NOBYPASSRLS",
    `CONNECTION LIMIT ${definition.connectionLimit}`,
  ].join(" ");
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
