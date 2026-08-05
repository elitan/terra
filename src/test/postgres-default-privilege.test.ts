import { describe, expect, test } from "bun:test";
import type { PostgresDefaultPrivilegeDefinition } from "../types/schema";
import {
  postgresDefaultPrivilegeBaselineGranted,
  postgresDefaultPrivilegeKey,
  postgresDefaultPrivilegeMatchesBaseline,
  renderPostgresDefaultPrivilegeRestore,
  renderPostgresDefaultPrivilegeState,
  renderPostgresDefaultPrivilegeTransition,
} from "../utils/postgres-default-privilege";

function createDefinition(
  overrides: Partial<PostgresDefaultPrivilegeDefinition> = {}
): PostgresDefaultPrivilegeDefinition {
  return {
    owner: 'owner"role',
    objectType: "TABLES",
    schema: 'app"schema',
    grantee: 'reader"role',
    granteeIsPublic: false,
    privilege: "SELECT",
    granted: true,
    grantable: false,
    baselineGranted: false,
    ...overrides,
  };
}

describe("PostgreSQL default privilege rendering", function () {
  test("renders quoted state and keeps mutable state outside the key", function () {
    const granted = createDefinition();
    const revoked = createDefinition({ granted: false });

    expect(renderPostgresDefaultPrivilegeState(granted)).toBe(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "owner""role" IN SCHEMA ' +
        '"app""schema" GRANT SELECT ON TABLES TO "reader""role";'
    );
    expect(renderPostgresDefaultPrivilegeState(revoked)).toBe(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "owner""role" IN SCHEMA ' +
        '"app""schema" REVOKE SELECT ON TABLES FROM "reader""role" RESTRICT;'
    );
    expect(postgresDefaultPrivilegeKey(granted)).toBe(
      postgresDefaultPrivilegeKey(revoked)
    );
  });

  test("derives global hard-wired defaults", function () {
    expect(postgresDefaultPrivilegeBaselineGranted(createDefinition({
      schema: undefined,
      grantee: 'owner"role',
    }))).toBe(true);
    expect(postgresDefaultPrivilegeBaselineGranted(createDefinition({
      objectType: "ROUTINES",
      schema: undefined,
      grantee: "PUBLIC",
      granteeIsPublic: true,
      privilege: "EXECUTE",
    }))).toBe(true);
    expect(postgresDefaultPrivilegeBaselineGranted(createDefinition({
      objectType: "TYPES",
      schema: undefined,
      grantee: "PUBLIC",
      granteeIsPublic: true,
      privilege: "USAGE",
    }))).toBe(true);
    expect(postgresDefaultPrivilegeBaselineGranted(createDefinition())).toBe(false);
  });

  test("renders native transitions and baseline restoration", function () {
    const plain = createDefinition();
    const grantable = createDefinition({ grantable: true });
    const absent = createDefinition({ granted: false });

    expect(renderPostgresDefaultPrivilegeTransition(plain, grantable)).toContain(
      "WITH GRANT OPTION;"
    );
    expect(renderPostgresDefaultPrivilegeTransition(grantable, plain)).toContain(
      "REVOKE GRANT OPTION FOR SELECT"
    );
    expect(renderPostgresDefaultPrivilegeTransition(plain, absent)).toContain(
      "REVOKE SELECT"
    );
    expect(renderPostgresDefaultPrivilegeTransition(plain, plain)).toBeUndefined();
    expect(renderPostgresDefaultPrivilegeRestore(grantable)).toContain(
      "REVOKE SELECT"
    );

    const revokedDefault = createDefinition({
      schema: undefined,
      grantee: 'owner"role',
      granted: false,
      baselineGranted: true,
    });
    expect(renderPostgresDefaultPrivilegeRestore(revokedDefault)).toContain(
      "GRANT SELECT"
    );
    expect(postgresDefaultPrivilegeMatchesBaseline(revokedDefault)).toBe(false);
    expect(postgresDefaultPrivilegeMatchesBaseline({
      ...revokedDefault,
      granted: true,
    })).toBe(true);
  });
});
