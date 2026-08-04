import type { SqlObject, Table, View } from "../../../types/schema";
import { ParserError } from "../../../types/errors";

export interface PendingClusteringChoice {
  schemaName?: string;
  relationName: string;
  relationKind: "table" | "materialized-view";
  indexName?: string;
}

export function isClusteringSubtype(subtype: unknown): boolean {
  return subtype === "AT_ClusterOn" || subtype === "AT_DropCluster";
}

export function parseAlterRelationClustering(
  stmt: any,
  filePath?: string
): PendingClusteringChoice[] {
  const commands = (stmt?.cmds || []).filter(function isClusteringCommand(
    item: any
  ) {
    return isClusteringSubtype(item?.AlterTableCmd?.subtype);
  });
  if (commands.length === 0) {
    return [];
  }

  const relation = stmt?.relation;
  if (!relation?.relname) {
    throw new ParserError(
      "PostgreSQL clustering target is missing a relation name",
      filePath
    );
  }
  const relationKind = stmt.objtype === "OBJECT_MATVIEW"
    ? "materialized-view"
    : "table";

  return commands.map(function mapClusteringChoice(item: any) {
    const command = item.AlterTableCmd;
    if (command.subtype === "AT_ClusterOn") {
      if (typeof command.name !== "string" || command.name.length === 0) {
        throw new ParserError(
          "PostgreSQL clustering choice must name an index",
          filePath
        );
      }
      return {
        schemaName: relation.schemaname,
        relationName: relation.relname,
        relationKind,
        indexName: command.name,
      };
    }
    return {
      schemaName: relation.schemaname,
      relationName: relation.relname,
      relationKind,
    };
  });
}

export function mergePendingClusteringChoices(
  tables: Table[],
  views: View[],
  sqlObjects: SqlObject[],
  pending: PendingClusteringChoice[],
  filePath?: string
): void {
  const tableMap = mapRelations(tables);
  const materializedViewMap = mapRelations(
    views.filter(function isMaterialized(view) {
      return view.materialized === true;
    })
  );
  const partitionKeys = new Set(
    sqlObjects
      .filter(function isPartition(object) {
        return object.kind === "partition";
      })
      .map(function getPartitionKey(object) {
        return relationKey(object.name, object.schema);
      })
  );
  const seen = new Set<string>();

  for (const item of pending) {
    const key = relationKey(item.relationName, item.schemaName);
    if (seen.has(key)) {
      throw new ParserError(
        `PostgreSQL clustering choice for '${key}' is declared more than once`,
        filePath
      );
    }
    seen.add(key);

    if (partitionKeys.has(key)) {
      if (item.indexName) {
        throw new ParserError(
          `PostgreSQL partition clustering for '${key}' is not supported: partition indexes are not represented as independently managed relations`,
          filePath
        );
      }
      continue;
    }

    const expectedMap = item.relationKind === "materialized-view"
      ? materializedViewMap
      : tableMap;
    const wrongKindMap = item.relationKind === "materialized-view"
      ? tableMap
      : materializedViewMap;
    const target = expectedMap.get(key);
    if (!target) {
      if (wrongKindMap.has(key)) {
        throw new ParserError(
          `PostgreSQL clustering target '${key}' must use ${item.relationKind === "materialized-view" ? "ALTER MATERIALIZED VIEW" : "ALTER TABLE"}`,
          filePath
        );
      }
      throw new ParserError(
        `PostgreSQL clustering target '${key}' was not found in the desired schema`,
        filePath
      );
    }

    if (item.indexName) {
      target.clusterIndex = item.indexName;
    } else {
      delete target.clusterIndex;
    }
  }
}

function mapRelations<T extends { name: string; schema?: string }>(
  relations: T[]
): Map<string, T> {
  return new Map(
    relations.map(function mapRelation(relation) {
      return [relationKey(relation.name, relation.schema), relation] as const;
    })
  );
}

function relationKey(name: string, schema?: string): string {
  return `${schema || "public"}.${name}`;
}
