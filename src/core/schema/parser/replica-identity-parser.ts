import type {
  PostgresReplicaIdentity,
  SqlObject,
  Table,
} from "../../../types/schema";
import { ParserError } from "../../../types/errors";
import type { PostgresReplicaIdentitySetting } from "../../../utils/postgres-replica-identity";

export interface PendingReplicaIdentity {
  schemaName?: string;
  tableName: string;
  identity: PostgresReplicaIdentitySetting;
}

export function isReplicaIdentitySubtype(subtype: unknown): boolean {
  return subtype === "AT_ReplicaIdentity";
}

export function parseAlterTableReplicaIdentities(
  stmt: any,
  filePath?: string
): PendingReplicaIdentity[] {
  const relation = stmt?.relation;
  const commands = (stmt?.cmds || []).filter(
    function isReplicaIdentityCommand(item: any) {
      return isReplicaIdentitySubtype(item?.AlterTableCmd?.subtype);
    }
  );
  if (commands.length === 0) {
    return [];
  }
  if (!relation?.relname) {
    throw new ParserError(
      "PostgreSQL replica identity target is missing a table name",
      filePath
    );
  }

  return commands.map(function mapReplicaIdentity(item: any) {
    const definition = item.AlterTableCmd?.def?.ReplicaIdentityStmt;
    return {
      schemaName: relation.schemaname,
      tableName: relation.relname,
      identity: parseReplicaIdentityDefinition(definition, filePath),
    };
  });
}

export function mergePendingReplicaIdentities(
  tables: Table[],
  sqlObjects: SqlObject[],
  pending: PendingReplicaIdentity[],
  partitionDefinitions: ReadonlyMap<string, Table>,
  filePath?: string
): void {
  const tableMap = new Map(
    tables.map(function mapTable(table) {
      return [relationKey(table.name, table.schema), table] as const;
    })
  );
  const partitionMap = new Map(
    sqlObjects
      .filter(function isPartition(object) {
        return object.kind === "partition";
      })
      .map(function mapPartition(object) {
        return [relationKey(object.name, object.schema), object] as const;
      })
  );
  const seen = new Set<string>();

  for (const item of pending) {
    const key = relationKey(item.tableName, item.schemaName);
    if (seen.has(key)) {
      throw new ParserError(
        `PostgreSQL replica identity for '${key}' is declared more than once`,
        filePath
      );
    }
    seen.add(key);

    const tableTarget = tableMap.get(key);
    const partitionTarget = partitionMap.get(key);
    const target = tableTarget || partitionTarget;
    if (!target) {
      throw new ParserError(
        `PostgreSQL replica identity target '${key}' was not found in the desired schema`,
        filePath
      );
    }
    if (partitionTarget && item.identity.mode === "index") {
      validatePartitionReplicaIdentity(
        partitionDefinitions.get(key),
        item.identity.indexName,
        key,
        filePath
      );
    }
    if (item.identity.mode === "default") {
      delete target.replicaIdentity;
    } else {
      target.replicaIdentity = item.identity;
    }
  }
}

function validatePartitionReplicaIdentity(
  definition: Table | undefined,
  indexName: string,
  relation: string,
  filePath?: string
): void {
  const primaryKey = definition?.primaryKey;
  if (primaryKey && (primaryKey.name || `${definition.name}_pkey`) === indexName) {
    if (primaryKey.deferrable) {
      throw invalidPartitionReplicaIdentity(
        relation,
        indexName,
        "backs a deferrable constraint",
        filePath
      );
    }
    return;
  }

  const uniqueConstraint = (definition?.uniqueConstraints || []).find(
    function findUnique(constraint) {
      return constraint.name === indexName;
    }
  );
  if (!uniqueConstraint) {
    throw invalidPartitionReplicaIdentity(
      relation,
      indexName,
      "is not a named primary-key or unique constraint declared on the partitioned relation",
      filePath
    );
  }
  if (uniqueConstraint.deferrable) {
    throw invalidPartitionReplicaIdentity(
      relation,
      indexName,
      "backs a deferrable constraint",
      filePath
    );
  }

  const nullableColumn = uniqueConstraint.columns.find(
    function findNullable(columnName) {
      return definition?.columns.find(function findColumn(column) {
        return column.name === columnName;
      })?.nullable !== false;
    }
  );
  if (nullableColumn) {
    throw invalidPartitionReplicaIdentity(
      relation,
      indexName,
      `has nullable key column '${nullableColumn}'`,
      filePath
    );
  }
}

function invalidPartitionReplicaIdentity(
  relation: string,
  indexName: string,
  reason: string,
  filePath?: string
): ParserError {
  return new ParserError(
    `PostgreSQL replica identity index '${indexName}' for partitioned relation '${relation}' is invalid: ${reason}. Use a named, immediate primary-key or unique constraint whose key columns are NOT NULL`,
    filePath
  );
}

function parseReplicaIdentityDefinition(
  definition: any,
  filePath?: string
): PostgresReplicaIdentitySetting {
  switch (definition?.identity_type) {
    case "d":
      return { mode: "default" };
    case "f":
      return { mode: "full" };
    case "n":
      return { mode: "nothing" };
    case "i":
      if (typeof definition.name === "string" && definition.name.length > 0) {
        return { mode: "index", indexName: definition.name };
      }
      break;
  }
  throw new ParserError(
    "PostgreSQL replica identity must be DEFAULT, FULL, NOTHING, or USING INDEX with a named index",
    filePath
  );
}

function relationKey(name: string, schema?: string): string {
  return `${schema || "public"}.${name}`;
}
