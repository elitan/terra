import type { QualifiedName } from "../types/schema";
import { SQLBuilder } from "./sql-builder";

export type PostgresClusterRelationKind = "table" | "materialized-view";

const CLUSTERABLE_BUILTIN_INDEX_METHODS = new Set(["btree", "gist"]);

export function postgresIndexMethodSupportsClustering(
  accessMethod: string | undefined
): boolean {
  return CLUSTERABLE_BUILTIN_INDEX_METHODS.has(
    (accessMethod || "btree").toLowerCase()
  );
}

export function renderPostgresClustering(
  relation: QualifiedName,
  indexName: string | undefined,
  kind: PostgresClusterRelationKind = "table"
): string {
  const objectType = kind === "materialized-view"
    ? "MATERIALIZED VIEW"
    : "TABLE";
  const builder = new SQLBuilder()
    .p(`ALTER ${objectType}`)
    .table(relation.name, relation.schema);
  if (indexName) {
    builder.p("CLUSTER ON").ident(indexName);
  } else {
    builder.p("SET WITHOUT CLUSTER");
  }
  return builder.p(";").build();
}
