import { Logger } from "../../../utils/logger";
import type { CompositeType } from "../../../types/schema";
import { extractDataType } from "./tables/column-parser";

export function parseCreateCompositeType(stmt: any): CompositeType | null {
  try {
    const typeName = stmt.typevar?.relname;
    if (!typeName) {
      return null;
    }

    const attributes = (stmt.coldeflist || [])
      .map(function (item: any) {
        const columnDef = item.ColumnDef;
        if (!columnDef?.colname || !columnDef.typeName) {
          return null;
        }

        return {
          name: columnDef.colname,
          type: extractDataType(columnDef.typeName),
        };
      })
      .filter(Boolean);

    if (attributes.length === 0) {
      return null;
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
