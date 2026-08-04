import { ParserError } from "../../../types/errors";
import type { SqlObject } from "../../../types/schema";

export interface PendingForeignServerOwner {
  serverName: string;
  owner: string;
}

const CONTEXTUAL_ROLE_NAMES: Readonly<Record<string, string>> = {
  ROLESPEC_CURRENT_ROLE: "CURRENT_ROLE",
  ROLESPEC_CURRENT_USER: "CURRENT_USER",
  ROLESPEC_SESSION_USER: "SESSION_USER",
};

export function parseForeignServerOwner(
  stmt: any,
  filePath?: string
): PendingForeignServerOwner {
  const serverName = stmt?.object?.String?.sval;
  if (typeof serverName !== "string" || serverName.length === 0) {
    throw new ParserError(
      "PostgreSQL ALTER SERVER OWNER TO has no concrete server name",
      filePath
    );
  }

  const role = stmt?.newowner;
  if (
    role?.roletype !== "ROLESPEC_CSTRING" ||
    typeof role.rolename !== "string" ||
    role.rolename.length === 0
  ) {
    const contextualName =
      CONTEXTUAL_ROLE_NAMES[role?.roletype] || "contextual role";
    throw new ParserError(
      `PostgreSQL ALTER SERVER '${serverName}' OWNER TO ${contextualName} is not supported in desired schemas because it depends on the apply session; specify the concrete role name instead`,
      filePath
    );
  }

  return { serverName, owner: role.rolename };
}

export function mergeForeignServerOwners(
  sqlObjects: SqlObject[],
  pendingOwners: PendingForeignServerOwner[],
  filePath?: string
): void {
  const servers = new Map(
    sqlObjects
      .filter(function isForeignServer(object) {
        return object.kind === "foreign-server";
      })
      .map(function mapForeignServer(object) {
        return [object.name, object] as const;
      })
  );
  const seen = new Set<string>();

  for (const pending of pendingOwners) {
    if (seen.has(pending.serverName)) {
      throw new ParserError(
        `PostgreSQL foreign server '${pending.serverName}' owner is declared more than once`,
        filePath
      );
    }
    seen.add(pending.serverName);

    const server = servers.get(pending.serverName);
    if (!server?.foreignServerDefinition) {
      throw new ParserError(
        `PostgreSQL ALTER SERVER '${pending.serverName}' OWNER TO has no matching CREATE SERVER declaration in the desired schema`,
        filePath
      );
    }
    server.foreignServerDefinition = {
      ...server.foreignServerDefinition,
      owner: pending.owner,
    };
  }
}
