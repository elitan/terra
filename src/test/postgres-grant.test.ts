import { describe, expect, test } from "bun:test";
import {
  isSupportedPostgresGrantPrivilege,
  postgresGrantKey,
  renderPostgresGrant,
  renderPostgresGrantOptionRevoke,
  renderPostgresGrantRevoke,
} from "../utils/postgres-grant";
import type { PostgresGrantDefinition } from "../types/schema";
import { parsePostgresGrants } from "../core/schema/parser/grant-parser";

function createDefinition(
  overrides: Partial<PostgresGrantDefinition> = {}
): PostgresGrantDefinition {
  return {
    objectType: "TABLE",
    objectName: 'odd"table',
    schema: 'odd"schema',
    grantee: 'odd"reader',
    granteeIsPublic: false,
    privilege: "SELECT",
    grantable: false,
    implicitDefault: false,
    ...overrides,
  };
}

function createGrantNode(overrides: Record<string, unknown> = {}): any {
  return {
    is_grant: true,
    targtype: "ACL_TARGET_OBJECT",
    objtype: "OBJECT_TABLE",
    objects: [{ RangeVar: { schemaname: "public", relname: "accounts" } }],
    privileges: [{ AccessPriv: { priv_name: "select" } }],
    grantees: [{
      RoleSpec: { roletype: "ROLESPEC_CSTRING", rolename: "reader" },
    }],
    ...overrides,
  };
}

describe("PostgreSQL privilege grant rendering", function () {
  test("quotes identities and keeps grant option outside the stable key", function () {
    const plain = createDefinition();
    const grantable = createDefinition({ grantable: true });

    expect(renderPostgresGrant(plain)).toBe(
      'GRANT SELECT ON TABLE "odd""schema"."odd""table" TO "odd""reader";'
    );
    expect(renderPostgresGrant(grantable)).toBe(
      'GRANT SELECT ON TABLE "odd""schema"."odd""table" TO "odd""reader" WITH GRANT OPTION;'
    );
    expect(postgresGrantKey(plain)).toBe(postgresGrantKey(grantable));
  });

  test("renders explicit restrictive privilege removals", function () {
    const definition = createDefinition({
      objectType: "FOREIGN SERVER",
      objectName: "analytics",
      schema: undefined,
      grantee: "PUBLIC",
      granteeIsPublic: true,
      privilege: "USAGE",
    });

    expect(renderPostgresGrantRevoke(definition)).toBe(
      'REVOKE USAGE ON FOREIGN SERVER "analytics" FROM PUBLIC RESTRICT;'
    );
    expect(renderPostgresGrantOptionRevoke(definition)).toBe(
      'REVOKE GRANT OPTION FOR USAGE ON FOREIGN SERVER "analytics" FROM PUBLIC RESTRICT;'
    );
  });

  test("keeps the portable privilege contract explicit", function () {
    expect(isSupportedPostgresGrantPrivilege("TABLE", "select")).toBe(true);
    expect(isSupportedPostgresGrantPrivilege("SEQUENCE", "USAGE")).toBe(true);
    expect(isSupportedPostgresGrantPrivilege("SCHEMA", "CREATE")).toBe(true);
    expect(
      isSupportedPostgresGrantPrivilege("FOREIGN SERVER", "USAGE")
    ).toBe(true);
    expect(isSupportedPostgresGrantPrivilege("TABLE", "MAINTAIN")).toBe(false);
    expect(isSupportedPostgresGrantPrivilege("SCHEMA", "SELECT")).toBe(false);
  });

  test("rejects malformed parser state before building grants", function () {
    const malformed = [
      createGrantNode({ objects: [] }),
      createGrantNode({ objects: [{}] }),
      createGrantNode({
        objtype: "OBJECT_SCHEMA",
        objects: [{}],
      }),
      createGrantNode({ privileges: [] }),
      createGrantNode({ privileges: [{}] }),
      createGrantNode({ grantees: [] }),
      createGrantNode({
        grantees: [{
          RoleSpec: { roletype: "ROLESPEC_CSTRING", rolename: "" },
        }],
      }),
      createGrantNode({ targtype: "ACL_TARGET_ALL_IN_SCHEMA" }),
      createGrantNode({ objtype: "OBJECT_DATABASE" }),
      createGrantNode({ grantor: { roletype: "ROLESPEC_CURRENT_USER" } }),
    ];

    for (const node of malformed) {
      expect(function parseMalformedGrant() {
        parsePostgresGrants(node, "schema.sql");
      }).toThrow();
    }
  });

  test("deduplicates repeated atomic entries within one grant", function () {
    const node = createGrantNode({
      objects: [
        { RangeVar: { schemaname: "public", relname: "accounts" } },
        { RangeVar: { schemaname: "public", relname: "accounts" } },
      ],
      privileges: [
        { AccessPriv: { priv_name: "select" } },
        { AccessPriv: { priv_name: "SELECT" } },
      ],
      grantees: [
        { RoleSpec: { roletype: "ROLESPEC_CSTRING", rolename: "reader" } },
        { RoleSpec: { roletype: "ROLESPEC_CSTRING", rolename: "reader" } },
      ],
    });

    expect(parsePostgresGrants(node)).toHaveLength(1);
  });
});
