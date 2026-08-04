import type { Node } from "libpg-query";

type UnionKeys<T> = T extends T ? keyof T : never;
type UnionValue<T, K extends PropertyKey> = T extends Record<K, infer V>
  ? V
  : never;

/**
 * pgsql-parser 18 models Node as a discriminated union. TerraDB intentionally
 * dispatches statements by checking which PostgreSQL node property is present,
 * so expose the same union as an optional-property object at that boundary.
 */
export type PgAstNode = {
  [K in UnionKeys<Node>]?: UnionValue<Node, K>;
} & {
  /** Legacy libpg-query node retained for compatibility with older AST fixtures. */
  CreateProcedureStmt?: unknown;
};

export function toPgAstNode(node: Node | undefined): PgAstNode | undefined {
  return node as PgAstNode | undefined;
}
