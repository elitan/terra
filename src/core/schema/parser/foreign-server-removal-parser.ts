import { ParserError } from "../../../types/errors";
import type { SqlObject } from "../../../types/schema";
import {
  renderPostgresForeignServerDrop,
} from "../../../utils/postgres-foreign-server";

export function parseForeignServerRemovals(
  stmt: any,
  filePath?: string
): SqlObject[] {
  if (stmt?.behavior === "DROP_CASCADE") {
    throw new ParserError(
      "PostgreSQL DROP SERVER CASCADE is not supported in desired schemas because it can delete dependent user mappings and foreign tables; omit CASCADE or specify RESTRICT",
      filePath
    );
  }
  if (stmt?.behavior !== "DROP_RESTRICT") {
    throw new ParserError(
      "PostgreSQL DROP SERVER has an unsupported dependency behavior; use RESTRICT",
      filePath
    );
  }

  return (stmt.objects || []).map(function parseServer(object: any) {
    const name = object?.String?.sval;
    if (typeof name !== "string" || name.length === 0) {
      throw new ParserError(
        "PostgreSQL DROP SERVER has no concrete server name",
        filePath
      );
    }
    return {
      kind: "foreign-server" as const,
      key: `foreign-server:${name}`,
      name,
      createStatement: renderPostgresForeignServerDrop(name),
      desiredAbsent: true,
    };
  });
}
