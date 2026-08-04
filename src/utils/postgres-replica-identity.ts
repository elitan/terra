import type {
  PostgresReplicaIdentity,
  QualifiedName,
} from "../types/schema";

export type PostgresReplicaIdentitySetting =
  | { mode: "default" }
  | PostgresReplicaIdentity;

export function effectivePostgresReplicaIdentity(
  identity: PostgresReplicaIdentity | undefined
): PostgresReplicaIdentitySetting {
  return identity || { mode: "default" };
}

export function postgresReplicaIdentitiesEqual(
  left: PostgresReplicaIdentity | undefined,
  right: PostgresReplicaIdentity | undefined
): boolean {
  const effectiveLeft = effectivePostgresReplicaIdentity(left);
  const effectiveRight = effectivePostgresReplicaIdentity(right);
  return effectiveLeft.mode === effectiveRight.mode &&
    (effectiveLeft.mode !== "index" ||
      (effectiveRight.mode === "index" &&
        effectiveLeft.indexName === effectiveRight.indexName));
}

export function renderPostgresReplicaIdentity(
  table: QualifiedName,
  identity: PostgresReplicaIdentity | undefined
): string {
  const setting = effectivePostgresReplicaIdentity(identity);
  let clause: string;
  switch (setting.mode) {
    case "default":
      clause = "DEFAULT";
      break;
    case "full":
      clause = "FULL";
      break;
    case "nothing":
      clause = "NOTHING";
      break;
    case "index":
      clause = `USING INDEX ${quoteIdentifier(setting.indexName)}`;
      break;
    case "index-missing":
      throw new Error(
        "Cannot render PostgreSQL replica identity with a missing selected index"
      );
  }
  return `ALTER TABLE ${renderQualifiedName(table)} REPLICA IDENTITY ${clause};`;
}

function renderQualifiedName(name: QualifiedName): string {
  const relation = quoteIdentifier(name.name);
  return name.schema
    ? `${quoteIdentifier(name.schema)}.${relation}`
    : relation;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
