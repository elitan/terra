import { SQLiteClient } from "./client";
import type {
  Table,
  Column,
  Index,
  View,
  Trigger,
  PrimaryKeyConstraint,
  ForeignKeyConstraint,
  CheckConstraint,
  UniqueConstraint,
} from "../../types/schema";

interface TableInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyInfo {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexInfo {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexColumnInfo {
  seqno: number;
  cid: number;
  name: string;
}

interface SqliteMasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

export class SQLiteInspector {
  async getCurrentSchema(client: SQLiteClient): Promise<Table[]> {
    const tables = await client.query<SqliteMasterRow>(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);

    const result: Table[] = [];

    for (const tableRow of tables.rows) {
      const table = await this.parseTable(client, tableRow.name);
      result.push(table);
    }

    return result;
  }

  private async parseTable(client: SQLiteClient, tableName: string): Promise<Table> {
    const columns = await this.getColumns(client, tableName);
    const primaryKey = await this.getPrimaryKey(client, tableName);
    const foreignKeys = await this.getForeignKeys(client, tableName);
    const indexes = await this.getIndexes(client, tableName);
    const checkConstraints = await this.getCheckConstraints(client, tableName);
    const uniqueConstraints = await this.getUniqueConstraints(client, tableName, indexes);

    return {
      name: tableName,
      columns,
      primaryKey: primaryKey || undefined,
      foreignKeys: foreignKeys.length > 0 ? foreignKeys : undefined,
      checkConstraints: checkConstraints.length > 0 ? checkConstraints : undefined,
      uniqueConstraints: uniqueConstraints.length > 0 ? uniqueConstraints : undefined,
      indexes: indexes.filter(idx => !idx.constraint),
    };
  }

  private async getColumns(client: SQLiteClient, tableName: string): Promise<Column[]> {
    const info = await client.query<TableInfo>(`PRAGMA table_info("${tableName}")`);

    return info.rows.map(row => ({
      name: row.name,
      type: this.normalizeType(row.type),
      nullable: row.notnull === 0 && row.pk === 0,
      default: row.dflt_value ? this.normalizeDefault(row.dflt_value) : undefined,
    }));
  }

  private async getPrimaryKey(client: SQLiteClient, tableName: string): Promise<PrimaryKeyConstraint | null> {
    const info = await client.query<TableInfo>(`PRAGMA table_info("${tableName}")`);
    const pkColumns = info.rows.filter(row => row.pk > 0).sort((a, b) => a.pk - b.pk);

    if (pkColumns.length === 0) {
      return null;
    }

    return {
      columns: pkColumns.map(col => col.name),
    };
  }

  private async getForeignKeys(client: SQLiteClient, tableName: string): Promise<ForeignKeyConstraint[]> {
    const fks = await client.query<ForeignKeyInfo>(`PRAGMA foreign_key_list("${tableName}")`);

    const fkMap = new Map<number, ForeignKeyConstraint>();

    for (const fk of fks.rows) {
      if (!fkMap.has(fk.id)) {
        fkMap.set(fk.id, {
          columns: [],
          referencedTable: fk.table,
          referencedColumns: [],
          onDelete: this.mapFkAction(fk.on_delete),
          onUpdate: this.mapFkAction(fk.on_update),
        });
      }
      const constraint = fkMap.get(fk.id)!;
      constraint.columns.push(fk.from);
      constraint.referencedColumns.push(fk.to);
    }

    return Array.from(fkMap.values());
  }

  private mapFkAction(action: string): 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION' {
    switch (action.toUpperCase()) {
      case 'CASCADE': return 'CASCADE';
      case 'RESTRICT': return 'RESTRICT';
      case 'SET NULL': return 'SET NULL';
      case 'SET DEFAULT': return 'SET DEFAULT';
      default: return 'NO ACTION';
    }
  }

  private async getIndexes(client: SQLiteClient, tableName: string): Promise<Index[]> {
    const indexList = await client.query<IndexInfo>(`PRAGMA index_list("${tableName}")`);
    const result: Index[] = [];

    for (const idx of indexList.rows) {
      if (idx.name.startsWith('sqlite_autoindex_')) {
        continue;
      }

      const indexInfo = await client.query<IndexColumnInfo>(`PRAGMA index_info("${idx.name}")`);
      const columns = indexInfo.rows.sort((a, b) => a.seqno - b.seqno).map(col => col.name);

      const index: Index = {
        name: idx.name,
        tableName,
        columns,
        unique: idx.unique === 1,
        type: "btree",
      };

      if (idx.origin === 'pk') {
        index.constraint = { type: 'p' };
      } else if (idx.origin === 'u') {
        index.constraint = { type: 'u' };
      }

      if (idx.partial === 1) {
        const createStmt = await client.query<SqliteMasterRow>(
          `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
          [idx.name]
        );
        if (createStmt.rows[0]?.sql) {
          const whereMatch = createStmt.rows[0].sql.match(/WHERE\s+(.+)$/i);
          if (whereMatch) {
            index.where = whereMatch[1];
          }
        }
      }

      result.push(index);
    }

    return result;
  }

  private async getCheckConstraints(client: SQLiteClient, tableName: string): Promise<CheckConstraint[]> {
    const tableInfo = await client.query<SqliteMasterRow>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [tableName]
    );

    if (!tableInfo.rows[0]?.sql) {
      return [];
    }

    const sql = tableInfo.rows[0].sql;
    const checkRegex = /CHECK\s*\(([^)]+)\)/gi;
    const constraints: CheckConstraint[] = [];
    let match;

    while ((match = checkRegex.exec(sql)) !== null) {
      constraints.push({
        expression: match[1].trim(),
      });
    }

    return constraints;
  }

  private async getUniqueConstraints(
    client: SQLiteClient,
    tableName: string,
    indexes: Index[]
  ): Promise<UniqueConstraint[]> {
    return indexes
      .filter(idx => idx.unique && idx.constraint?.type === 'u')
      .map(idx => ({
        name: idx.name,
        columns: idx.columns,
      }));
  }

  async getCurrentViews(client: SQLiteClient): Promise<View[]> {
    const views = await client.query<SqliteMasterRow>(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'view'
      ORDER BY name
    `);

    return views.rows.map(row => {
      const defMatch = row.sql?.match(/AS\s+(.+)$/is);
      return {
        name: row.name,
        definition: defMatch ? defMatch[1].trim() : '',
      };
    });
  }

  async getCurrentTriggers(client: SQLiteClient): Promise<Trigger[]> {
    const triggers = await client.query<SqliteMasterRow>(`
      SELECT name, tbl_name, sql
      FROM sqlite_master
      WHERE type = 'trigger'
      ORDER BY name
    `);

    return triggers.rows.map(row => {
      const sql = row.sql || '';
      const timing = sql.match(/\b(BEFORE|AFTER|INSTEAD\s+OF)\b/i)?.[1]?.toUpperCase() as 'BEFORE' | 'AFTER' | 'INSTEAD OF' || 'BEFORE';
      const events: ('INSERT' | 'UPDATE' | 'DELETE')[] = [];
      if (/\bINSERT\b/i.test(sql)) events.push('INSERT');
      if (/\bUPDATE\b/i.test(sql)) events.push('UPDATE');
      if (/\bDELETE\b/i.test(sql)) events.push('DELETE');

      return {
        name: row.name,
        tableName: row.tbl_name,
        timing: timing === 'INSTEAD OF' ? 'INSTEAD OF' : timing as 'BEFORE' | 'AFTER',
        events,
        functionName: '',
      };
    });
  }

  private normalizeType(type: string): string {
    const upper = type.toUpperCase();
    if (upper === 'INT') return 'INTEGER';
    return type;
  }

  private normalizeDefault(value: string): string {
    if (value.startsWith("'") && value.endsWith("'")) {
      return value;
    }
    return value;
  }
}
