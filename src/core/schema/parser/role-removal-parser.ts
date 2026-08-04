import { ParserError } from "../../../types/errors";
import type { SqlObject } from "../../../types/schema";
import { renderPostgresRoleDrop } from "../../../utils/postgres-role";

export function parsePostgresRoleRemovals(
  stmt: any,
  filePath?: string
): SqlObject[] {
  if (!Array.isArray(stmt?.roles) || stmt.roles.length === 0) {
    throw new ParserError(
      "PostgreSQL DROP ROLE has no concrete role names",
      filePath
    );
  }
  return stmt.roles.map(function parseRole(roleNode: any) {
    const role = roleNode?.RoleSpec;
    if (
      role?.roletype !== "ROLESPEC_CSTRING" ||
      typeof role.rolename !== "string" ||
      role.rolename.length === 0
    ) {
      throw new ParserError(
        "PostgreSQL DROP ROLE requires a concrete role name",
        filePath
      );
    }
    return {
      kind: "role" as const,
      key: `role:${role.rolename}`,
      name: role.rolename,
      createStatement: renderPostgresRoleDrop(role.rolename),
      desiredAbsent: true,
    };
  });
}
