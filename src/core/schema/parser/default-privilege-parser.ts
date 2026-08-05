import { ParserError } from "../../../types/errors";
import type {
  PostgresDefaultPrivilegeDefinition,
  PostgresDefaultPrivilegeObjectType,
  SqlObject,
} from "../../../types/schema";
import {
  isSupportedPostgresDefaultPrivilege,
  postgresDefaultPrivilegeBaselineGranted,
  postgresDefaultPrivilegeKey,
  renderPostgresDefaultPrivilegeRestore,
  renderPostgresDefaultPrivilegeState,
} from "../../../utils/postgres-default-privilege";

type DefaultPrivilegeGrantee = {
  name: string;
  isPublic: boolean;
};

const OBJECT_TYPES = new Map<string, PostgresDefaultPrivilegeObjectType>([
  ["OBJECT_TABLE", "TABLES"],
  ["OBJECT_SEQUENCE", "SEQUENCES"],
  ["OBJECT_FUNCTION", "ROUTINES"],
  ["OBJECT_TYPE", "TYPES"],
  ["OBJECT_SCHEMA", "SCHEMAS"],
]);

export function parsePostgresDefaultPrivileges(
  node: any,
  filePath?: string
): SqlObject[] {
  const options = parseOptions(node?.options, filePath);
  const action = node?.action;
  if (!action || action.targtype !== "ACL_TARGET_DEFAULTS") {
    throw new ParserError(
      "PostgreSQL ALTER DEFAULT PRIVILEGES has malformed privilege state",
      filePath
    );
  }
  const objectType = OBJECT_TYPES.get(action.objtype);
  if (!objectType) {
    throw new ParserError(
      "PostgreSQL default privileges for this object family are not supported across PostgreSQL 14-18",
      filePath
    );
  }
  if (objectType === "SCHEMAS" && options.schemas.length > 0) {
    throw new ParserError(
      "PostgreSQL default privileges ON SCHEMAS cannot use IN SCHEMA because schemas cannot be nested",
      filePath
    );
  }
  if (action.behavior === "DROP_CASCADE") {
    throw new ParserError(
      "PostgreSQL ALTER DEFAULT PRIVILEGES REVOKE CASCADE is not supported in desired schemas; use RESTRICT or omit the behavior",
      filePath
    );
  }
  const isGrant = action.is_grant === true;
  if (!isGrant && action.grant_option === true) {
    throw new ParserError(
      "PostgreSQL REVOKE GRANT OPTION is an imperative partial default-privilege mutation; declare the retained privilege with GRANT without WITH GRANT OPTION",
      filePath
    );
  }
  const privileges = parsePrivileges(action.privileges, objectType, filePath);
  const grantees = parseGrantees(action.grantees, filePath);
  if (
    isGrant &&
    action.grant_option === true &&
    grantees.some(function isPublic(grantee) {
      return grantee.isPublic;
    })
  ) {
    throw new ParserError(
      "PostgreSQL WITH GRANT OPTION for PUBLIC is not supported because PostgreSQL rejects it",
      filePath
    );
  }

  const schemas = options.schemas.length > 0 ? options.schemas : [undefined];
  const byKey = new Map<string, SqlObject>();
  for (const owner of options.owners) {
    for (const schema of schemas) {
      for (const privilege of privileges) {
        for (const grantee of grantees) {
          const partial = {
            owner,
            objectType,
            ...(schema ? { schema } : {}),
            grantee: grantee.name,
            granteeIsPublic: grantee.isPublic,
            privilege,
          };
          const definition: PostgresDefaultPrivilegeDefinition = {
            ...partial,
            granted: isGrant,
            grantable: isGrant && action.grant_option === true,
            baselineGranted: postgresDefaultPrivilegeBaselineGranted(partial),
          };
          const key = postgresDefaultPrivilegeKey(definition);
          const createStatement = renderPostgresDefaultPrivilegeState(
            definition
          );
          byKey.set(key, {
            kind: "default-privilege",
            key,
            name: createStatement,
            ...(schema ? { schema } : {}),
            createStatement,
            dropStatement: renderPostgresDefaultPrivilegeRestore(definition),
            defaultPrivilegeDefinition: definition,
            dependencies: [
              `role:${owner}`,
              ...(grantee.isPublic ? [] : [`role:${grantee.name}`]),
            ],
          });
        }
      }
    }
  }
  return [...byKey.values()].sort(function sortPrivileges(left, right) {
    return left.key.localeCompare(right.key);
  });
}

function parseOptions(
  nodes: any[] | undefined,
  filePath?: string
): { owners: string[]; schemas: string[] } {
  const owners = new Set<string>();
  const schemas = new Set<string>();
  const seenOptions = new Set<string>();
  for (const node of nodes || []) {
    const option = node?.DefElem;
    if (!option || seenOptions.has(option.defname)) {
      throw new ParserError(
        "PostgreSQL ALTER DEFAULT PRIVILEGES has malformed or duplicate options",
        filePath
      );
    }
    seenOptions.add(option.defname);
    const items = option.arg?.List?.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new ParserError(
        "PostgreSQL ALTER DEFAULT PRIVILEGES requires concrete option values",
        filePath
      );
    }
    if (option.defname === "roles") {
      for (const item of items) {
        const role = item?.RoleSpec;
        if (
          role?.roletype !== "ROLESPEC_CSTRING" ||
          typeof role.rolename !== "string" ||
          role.rolename.length === 0
        ) {
          throw new ParserError(
            "PostgreSQL default privilege owners must be concrete role names",
            filePath
          );
        }
        owners.add(role.rolename);
      }
      continue;
    }
    if (option.defname === "schemas") {
      for (const item of items) {
        const schema = item?.String?.sval;
        if (typeof schema !== "string" || schema.length === 0) {
          throw new ParserError(
            "PostgreSQL default privilege schemas must be concrete names",
            filePath
          );
        }
        schemas.add(schema);
      }
      continue;
    }
    throw new ParserError(
      `PostgreSQL ALTER DEFAULT PRIVILEGES option '${String(option.defname)}' is not supported`,
      filePath
    );
  }
  if (owners.size === 0) {
    throw new ParserError(
      "PostgreSQL ALTER DEFAULT PRIVILEGES must use FOR ROLE with a concrete managed owner so database-wide omission has a stable scope",
      filePath
    );
  }
  return {
    owners: [...owners].sort(),
    schemas: [...schemas].sort(),
  };
}

function parsePrivileges(
  nodes: any[] | undefined,
  objectType: PostgresDefaultPrivilegeObjectType,
  filePath?: string
): string[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new ParserError(
      "PostgreSQL ALTER DEFAULT PRIVILEGES ALL is not supported because the privilege set differs by server version; list privileges explicitly",
      filePath
    );
  }
  const privileges = new Set<string>();
  for (const node of nodes) {
    const name = node?.AccessPriv?.priv_name?.toUpperCase();
    if (
      typeof name !== "string" ||
      !isSupportedPostgresDefaultPrivilege(objectType, name)
    ) {
      throw new ParserError(
        `PostgreSQL ${String(name || "unknown")} default privilege on ${objectType} is not supported across PostgreSQL 14-18`,
        filePath
      );
    }
    privileges.add(name);
  }
  return [...privileges].sort();
}

function parseGrantees(
  nodes: any[] | undefined,
  filePath?: string
): DefaultPrivilegeGrantee[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new ParserError(
      "PostgreSQL ALTER DEFAULT PRIVILEGES requires a concrete grantee or PUBLIC",
      filePath
    );
  }
  const grantees = new Map<string, DefaultPrivilegeGrantee>();
  for (const node of nodes) {
    const role = node?.RoleSpec;
    if (role?.roletype === "ROLESPEC_PUBLIC") {
      grantees.set("public:", { name: "PUBLIC", isPublic: true });
      continue;
    }
    if (
      role?.roletype !== "ROLESPEC_CSTRING" ||
      typeof role.rolename !== "string" ||
      role.rolename.length === 0
    ) {
      throw new ParserError(
        "PostgreSQL contextual default privilege grantees are not supported; use a concrete role or PUBLIC",
        filePath
      );
    }
    grantees.set(`role:${role.rolename}`, {
      name: role.rolename,
      isPublic: false,
    });
  }
  return [...grantees.values()];
}
