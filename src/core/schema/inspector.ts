import { Client } from "pg";
import type {
  Table,
  Column,
  PrimaryKeyConstraint,
  Index,
} from "../../types/schema";

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
          column_default
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
        };
      });

      // Get primary key constraint for this table
      const primaryKey = await this.getPrimaryKeyConstraint(client, tableName);

      // Get indexes for this table
      const indexes = await this.getTableIndexes(client, tableName);

      tables.push({
        name: tableName,
        columns,
        primaryKey,
        indexes,
      });
    }

    return tables;
  }

  private async getPrimaryKeyConstraint(
    client: Client,
    tableName: string
  ): Promise<PrimaryKeyConstraint | undefined> {
    const result = await client.query(
      `
      SELECT 
        tc.constraint_name,
        kcu.column_name,
        kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu 
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = $1 
        AND tc.table_schema = 'public'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
      `,
      [tableName]
    );

    if (result.rows.length === 0) {
      return undefined;
    }

    // Extract constraint name and columns
    const constraintName = result.rows[0].constraint_name;
    const columns = result.rows.map((row: any) => row.column_name);

    return {
      name: constraintName,
      columns,
    };
  }

  async getTableIndexes(client: Client, tableName: string): Promise<Index[]> {
    const result = await client.query(
      `
      SELECT 
        i.indexname as index_name,
        i.tablename as table_name,
        i.indexdef as index_definition,
        ix.indisunique as is_unique,
        am.amname as access_method,
        ix.indexprs IS NOT NULL as has_expressions,
        -- Extract tablespace information
        ts.spcname as tablespace_name,
        -- Extract storage parameters (reloptions)
        ic.reloptions as storage_options,
        CASE 
          WHEN ix.indexprs IS NOT NULL THEN 
            -- Extract expression from the full index definition
            -- Use a more specific regex to extract content between USING btree ( and )
            regexp_replace(
              regexp_replace(i.indexdef, ' WHERE .*$', ''),  -- Remove WHERE clause first
              '^.*USING btree \\((.+)\\)$', '\\1'  -- Extract content between USING btree ( and )
            )
          ELSE NULL
        END as expression_def,
        CASE 
          WHEN ix.indexprs IS NULL THEN 
            -- Regular column-based index
            ARRAY(
              SELECT a.attname
              FROM pg_attribute a
              WHERE a.attrelid = ix.indrelid
                AND a.attnum = ANY(ix.indkey)
              ORDER BY array_position(ix.indkey, a.attnum)
            )
          ELSE 
            -- Expression index - no simple column names
            ARRAY[]::text[]
        END as column_names,
        CASE 
          WHEN ix.indpred IS NOT NULL THEN 
            regexp_replace(
              pg_get_expr(ix.indpred, ix.indrelid),
              '^\\((.*)\\)$', '\\1'  -- Remove outer parentheses
            )
          ELSE NULL
        END as where_clause
      FROM pg_indexes i
      JOIN pg_class c ON c.relname = i.tablename
      JOIN pg_index ix ON ix.indexrelid = (
        SELECT oid FROM pg_class WHERE relname = i.indexname
      )
      JOIN pg_am am ON am.oid = (
        SELECT pg_class.relam FROM pg_class WHERE relname = i.indexname
      )
      -- Join with pg_class again to get the index relation for storage options
      JOIN pg_class ic ON ic.oid = ix.indexrelid
      -- Left join with pg_tablespace to get tablespace name
      LEFT JOIN pg_tablespace ts ON ts.oid = ic.reltablespace
      WHERE i.tablename = $1 
        AND i.schemaname = 'public'
        AND NOT ix.indisprimary  -- Exclude primary key indexes
        AND NOT EXISTS (  -- Exclude unique constraint indexes
          SELECT 1 FROM pg_constraint con 
          WHERE con.conindid = ix.indexrelid 
          AND con.contype = 'u'
        )
      ORDER BY i.indexname
      `,
      [tableName]
    );

    return result.rows.map((row: any) => ({
      name: row.index_name,
      tableName: row.table_name,
      columns: row.column_names || [],
      type: this.mapPostgreSQLIndexType(row.access_method),
      unique: row.is_unique,
      concurrent: false, // Cannot detect from system catalogs
      where: row.where_clause || undefined,
      expression: row.has_expressions ? row.expression_def : undefined,
      storageParameters: this.parseStorageOptions(row.storage_options),
      tablespace: row.tablespace_name || undefined,
    }));
  }

  private parseStorageOptions(
    reloptions: string[] | null
  ): Record<string, string> | undefined {
    if (!reloptions || !Array.isArray(reloptions) || reloptions.length === 0) {
      return undefined;
    }

    const parameters: Record<string, string> = {};

    for (const option of reloptions) {
      // PostgreSQL storage options are stored as "key=value" strings
      const match = option.match(/^([^=]+)=(.*)$/);
      if (match && match.length >= 3 && match[1] && match[2] !== undefined) {
        const key = match[1];
        const value = match[2];
        parameters[key] = value;
      }
    }

    return Object.keys(parameters).length > 0 ? parameters : undefined;
  }

  private mapPostgreSQLIndexType(accessMethod: string): Index["type"] {
    switch (accessMethod.toLowerCase()) {
      case "btree":
        return "btree";
      case "hash":
        return "hash";
      case "gin":
        return "gin";
      case "gist":
        return "gist";
      case "spgist":
        return "spgist";
      case "brin":
        return "brin";
      default:
        return "btree"; // Default fallback
    }
  }
}
