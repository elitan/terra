import { describe, expect, test } from "bun:test";
import type { PostgresRoleDefinition } from "../types/schema";
import {
  postgresRoleDefinitionsEqual,
  renderPostgresRoleAlter,
  renderPostgresRoleCreate,
  renderPostgresRoleDrop,
} from "../utils/postgres-role";

const DEFAULT_ROLE: PostgresRoleDefinition = {
  login: false,
  superuser: false,
  createDatabase: false,
  createRole: false,
  inherit: true,
  replication: false,
  bypassRowLevelSecurity: false,
  connectionLimit: -1,
};

describe("PostgreSQL role rendering", function () {
  test("quotes names and renders complete creation state", function () {
    expect(renderPostgresRoleCreate('Team "Owner"', DEFAULT_ROLE)).toBe(
      'CREATE ROLE "Team ""Owner""" WITH NOLOGIN NOSUPERUSER NOCREATEDB ' +
        'NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;'
    );
    expect(renderPostgresRoleDrop('Team "Owner"')).toBe(
      'DROP ROLE IF EXISTS "Team ""Owner""";'
    );
  });

  test("renders only changed role attributes in stable order", function () {
    const elevated: PostgresRoleDefinition = {
      login: true,
      superuser: true,
      createDatabase: true,
      createRole: true,
      inherit: false,
      replication: true,
      bypassRowLevelSecurity: true,
      connectionLimit: 8,
    };

    expect(renderPostgresRoleAlter("app", DEFAULT_ROLE, elevated)).toBe(
      'ALTER ROLE "app" WITH LOGIN SUPERUSER CREATEDB CREATEROLE ' +
        'NOINHERIT REPLICATION BYPASSRLS CONNECTION LIMIT 8;'
    );
    expect(
      renderPostgresRoleAlter("app", elevated, {
        ...elevated,
        login: false,
        superuser: false,
        createDatabase: false,
        createRole: false,
        inherit: true,
        replication: false,
        bypassRowLevelSecurity: false,
        connectionLimit: -1,
      })
    ).toBe(
      'ALTER ROLE "app" WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ' +
        'INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;'
    );
    expect(
      renderPostgresRoleAlter("app", DEFAULT_ROLE, { ...DEFAULT_ROLE })
    ).toBeUndefined();
  });

  test("compares every managed attribute", function () {
    expect(
      postgresRoleDefinitionsEqual(DEFAULT_ROLE, { ...DEFAULT_ROLE })
    ).toBe(true);
    const alternatives: PostgresRoleDefinition[] = [
      { ...DEFAULT_ROLE, login: true },
      { ...DEFAULT_ROLE, superuser: true },
      { ...DEFAULT_ROLE, createDatabase: true },
      { ...DEFAULT_ROLE, createRole: true },
      { ...DEFAULT_ROLE, inherit: false },
      { ...DEFAULT_ROLE, replication: true },
      { ...DEFAULT_ROLE, bypassRowLevelSecurity: true },
      { ...DEFAULT_ROLE, connectionLimit: 0 },
    ];
    for (const alternative of alternatives) {
      expect(
        postgresRoleDefinitionsEqual(DEFAULT_ROLE, alternative)
      ).toBe(false);
    }
  });
});
