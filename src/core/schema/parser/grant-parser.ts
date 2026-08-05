import { ParserError } from "../../../types/errors";
import type {
  PostgresGrantDefinition,
  PostgresGrantObjectType,
  SqlObject,
} from "../../../types/schema";
import {
  isSupportedPostgresGrantPrivilege,
  postgresGrantKey,
  renderPostgresGrant,
  renderPostgresGrantRevoke,
} from "../../../utils/postgres-grant";

type GrantTarget = {
  objectName: string;
  schema?: string;
};

type GrantGrantee = {
  name: string;
  isPublic: boolean;
};

type GrantObjectContract = {
  objectType: PostgresGrantObjectType;
  targetKind: "relation" | "name";
};

const GRANT_OBJECT_CONTRACTS = new Map<string, GrantObjectContract>([
  [
    "OBJECT_TABLE",
    {
      objectType: "TABLE",
      targetKind: "relation",
    },
  ],
  [
    "OBJECT_SEQUENCE",
    {
      objectType: "SEQUENCE",
      targetKind: "relation",
    },
  ],
  [
    "OBJECT_SCHEMA",
    {
      objectType: "SCHEMA",
      targetKind: "name",
    },
  ],
  [
    "OBJECT_FOREIGN_SERVER",
    {
      objectType: "FOREIGN SERVER",
      targetKind: "name",
    },
  ],
]);

export function parsePostgresGrants(
  node: any,
  filePath?: string
): SqlObject[] {
  if (node?.is_grant !== true) {
    throw new ParserError(
      "PostgreSQL REVOKE is an imperative privilege mutation and is not supported in desired schemas; omit a managed GRANT to declare that privilege absent",
      filePath
    );
  }
  if (node.targtype !== "ACL_TARGET_OBJECT") {
    throw new ParserError(
      "PostgreSQL GRANT on ALL objects in a schema is not supported in desired schemas because its expanding target set cannot be inspected as one stable declaration; grant privileges on concrete objects instead",
      filePath
    );
  }
  if (node.grantor) {
    throw new ParserError(
      "PostgreSQL GRANT ... GRANTED BY is not supported in desired schemas because grantor provenance cannot be reconciled from the apply session; omit GRANTED BY",
      filePath
    );
  }

  const contract = GRANT_OBJECT_CONTRACTS.get(node.objtype);
  if (!contract) {
    throw new ParserError(
      `PostgreSQL GRANT on ${grantObjectLabel(node.objtype)} is not supported in desired schemas because TerraDB does not inspect that object's ACL losslessly`,
      filePath
    );
  }
  const targets = parseTargets(node.objects, contract, filePath);
  const privileges = parsePrivileges(node.privileges, contract, filePath);
  const grantees = parseGrantees(node.grantees, filePath);
  if (
    node.grant_option === true &&
    grantees.some(function isPublic(grantee) {
      return grantee.isPublic;
    })
  ) {
    throw new ParserError(
      "PostgreSQL WITH GRANT OPTION for PUBLIC is not supported in desired schemas because PostgreSQL rejects it; specify a concrete role or omit WITH GRANT OPTION",
      filePath
    );
  }

  const byKey = new Map<string, SqlObject>();
  for (const target of targets) {
    for (const privilege of privileges) {
      for (const grantee of grantees) {
        const definition: PostgresGrantDefinition = {
          objectType: contract.objectType,
          objectName: target.objectName,
          ...(target.schema ? { schema: target.schema } : {}),
          grantee: grantee.name,
          granteeIsPublic: grantee.isPublic,
          privilege,
          grantable: node.grant_option === true,
          implicitDefault: false,
        };
        const key = postgresGrantKey(definition);
        byKey.set(key, {
          kind: "grant",
          key,
          name: renderPostgresGrant(definition),
          ...(target.schema ? { schema: target.schema } : {}),
          createStatement: renderPostgresGrant(definition),
          dropStatement: renderPostgresGrantRevoke(definition),
          grantDefinition: definition,
        });
      }
    }
  }
  return [...byKey.values()].sort(function sortGrants(left, right) {
    return left.key.localeCompare(right.key);
  });
}

function parseTargets(
  nodes: any[] | undefined,
  contract: GrantObjectContract,
  filePath?: string
): GrantTarget[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new ParserError(
      "PostgreSQL GRANT requires at least one concrete target",
      filePath
    );
  }
  return nodes.map(function parseTarget(node) {
    if (contract.targetKind === "relation") {
      const relation = node?.RangeVar;
      if (typeof relation?.relname !== "string" || relation.relname.length === 0) {
        throw new ParserError(
          `PostgreSQL GRANT on ${contract.objectType} has a malformed target`,
          filePath
        );
      }
      return {
        objectName: relation.relname,
        schema: relation.schemaname || "public",
      };
    }
    const name = node?.String?.sval;
    if (typeof name !== "string" || name.length === 0) {
      throw new ParserError(
        `PostgreSQL GRANT on ${contract.objectType} has a malformed target`,
        filePath
      );
    }
    return {
      objectName: name,
      ...(contract.objectType === "SCHEMA" ? { schema: name } : {}),
    };
  });
}

function parsePrivileges(
  nodes: any[] | undefined,
  contract: GrantObjectContract,
  filePath?: string
): string[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new ParserError(
      "PostgreSQL GRANT ALL is not supported in desired schemas because the privilege set differs by object type and server version; list each privilege explicitly",
      filePath
    );
  }
  const privileges = new Set<string>();
  for (const node of nodes) {
    const privilege = node?.AccessPriv;
    const name = privilege?.priv_name?.toUpperCase();
    if (Array.isArray(privilege?.cols) && privilege.cols.length > 0) {
      throw new ParserError(
        "PostgreSQL column-level GRANT is not supported in desired schemas because TerraDB does not inspect pg_attribute.attacl; grant at table level instead",
        filePath
      );
    }
    if (
      typeof name !== "string" ||
      !isSupportedPostgresGrantPrivilege(contract.objectType, name)
    ) {
      throw new ParserError(
        `PostgreSQL ${String(name || "unknown")} privilege on ${contract.objectType} is not supported in desired schemas`,
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
): GrantGrantee[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new ParserError(
      "PostgreSQL GRANT requires at least one concrete grantee or PUBLIC",
      filePath
    );
  }
  const grantees = new Map<string, GrantGrantee>();
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
        "PostgreSQL contextual GRANT grantees are not supported in desired schemas; specify a concrete role name or PUBLIC",
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

function grantObjectLabel(objectType: unknown): string {
  return String(objectType || "unknown").replace(/^OBJECT_/, "").replace(/_/g, " ");
}
