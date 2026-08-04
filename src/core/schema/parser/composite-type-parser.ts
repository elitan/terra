import { Logger } from "../../../utils/logger";
import type { CompositeType } from "../../../types/schema";
import {
  extractColumnCollation,
  extractDataType,
} from "./tables/column-parser";

export function parseCreateCompositeType(stmt: any): CompositeType | null {
  try {
    const typeName = stmt.typevar?.relname;
    if (!typeName) {
      return null;
    }

    const attributes: CompositeType["attributes"] = [];
    for (const item of stmt.coldeflist || []) {
      const columnDef = item.ColumnDef;
      if (!columnDef?.colname || !columnDef.typeName) {
        return null;
      }

      const collation = extractColumnCollation(columnDef.collClause);
      attributes.push({
        name: columnDef.colname,
        type: extractDataType(columnDef.typeName),
        ...(collation ? { collation } : {}),
      });
    }

    return {
      name: typeName,
      schema: stmt.typevar?.schemaname || undefined,
      attributes,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE TYPE AS: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
