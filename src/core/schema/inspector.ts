import { Client } from "pg";
import type { Table, Column } from "../../types/schema";

export class DatabaseInspector {
  async getCurrentSchema(client: Client): Promise<Table[]> {
    const tables: Table[] = [];

    // Get all tables
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);

    for (const row of tablesResult.rows) {
      const tableName = row.table_name;

      // Get columns for each table
      const columnsResult = await client.query(
        `
        SELECT 
          column_name,
          data_type,
          character_maximum_length,
          is_nullable,
          column_default,
          (SELECT COUNT(*) FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_name = $1 AND kcu.column_name = columns.column_name 
           AND tc.constraint_type = 'PRIMARY KEY') > 0 as is_primary
        FROM information_schema.columns 
        WHERE table_name = $1 AND table_schema = 'public'
        ORDER BY ordinal_position
      `,
        [tableName]
      );

      const columns: Column[] = columnsResult.rows.map((col: any) => {
        let type = col.data_type;

        // Handle character varying with length
        if (
          col.data_type === "character varying" &&
          col.character_maximum_length
        ) {
          type = `character varying(${col.character_maximum_length})`;
        }

        return {
          name: col.column_name,
          type: type,
          nullable: col.is_nullable === "YES",
          default: col.column_default,
          primary: col.is_primary,
        };
      });

      tables.push({
        name: tableName,
        columns,
      });
    }

    return tables;
  }
}
