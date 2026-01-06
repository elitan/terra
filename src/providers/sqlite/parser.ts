import initSqlJs, { Database as SqlJsDatabase, SqlValue } from "sql.js";
import type { ParsedSchema } from "../types";
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

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSQL() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

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

export class SQLiteParser {
  async parseSchema(sql: string, _filePath?: string): Promise<ParsedSchema> {
    const SqlJs = await getSQL();
    const db = new SqlJs.Database();

    try {
      db.run(sql);

      const tables = await this.extractTables(db);
      const views = await this.extractViews(db);
      const triggers = await this.extractTriggers(db);

      return {
        tables,
        enums: [],
        views,
        functions: [],
        procedures: [],
        triggers,
        sequences: [],
        extensions: [],
        schemas: [],
        comments: [],
      };
    } finally {
      db.close();
    }
  }

  private async extractTables(db: SqlJsDatabase): Promise<Table[]> {
    const tablesResult = db.exec(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);

    if (!tablesResult[0]) {
      return [];
    }

    const tables: Table[] = [];

    for (const row of tablesResult[0].values) {
      const tableName = row[0] as string;
      const table = await this.parseTable(db, tableName);
      tables.push(table);
    }

    return tables;
  }

  private async parseTable(db: SqlJsDatabase, tableName: string): Promise<Table> {
    const columns = this.getColumns(db, tableName);
    const primaryKey = this.getPrimaryKey(db, tableName);
    const foreignKeys = this.getForeignKeys(db, tableName);
    const indexes = this.getIndexes(db, tableName);
    const checkConstraints = this.getCheckConstraints(db, tableName);
    const uniqueConstraints = this.getUniqueConstraints(indexes);

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

  private getColumns(db: SqlJsDatabase, tableName: string): Column[] {
    const result = db.exec(`PRAGMA table_info("${tableName}")`);
    if (!result[0]) return [];

    return result[0].values.map((row: SqlValue[]) => {
      const info: TableInfo = {
        cid: row[0] as number,
        name: row[1] as string,
        type: row[2] as string,
        notnull: row[3] as number,
        dflt_value: row[4] as string | null,
        pk: row[5] as number,
      };

      return {
        name: info.name,
        type: this.normalizeType(info.type),
        nullable: info.notnull === 0 && info.pk === 0,
        default: info.dflt_value ? this.normalizeDefault(info.dflt_value) : undefined,
      };
    });
  }

  private getPrimaryKey(db: SqlJsDatabase, tableName: string): PrimaryKeyConstraint | null {
    const result = db.exec(`PRAGMA table_info("${tableName}")`);
    if (!result[0]) return null;

    const pkColumns = result[0].values
      .filter((row: SqlValue[]) => (row[5] as number) > 0)
      .sort((a: SqlValue[], b: SqlValue[]) => (a[5] as number) - (b[5] as number))
      .map((row: SqlValue[]) => row[1] as string);

    if (pkColumns.length === 0) return null;

    return { columns: pkColumns };
  }

  private getForeignKeys(db: SqlJsDatabase, tableName: string): ForeignKeyConstraint[] {
    const result = db.exec(`PRAGMA foreign_key_list("${tableName}")`);
    if (!result[0]) return [];

    const fkMap = new Map<number, ForeignKeyConstraint>();

    for (const row of result[0].values) {
      const fk: ForeignKeyInfo = {
        id: row[0] as number,
        seq: row[1] as number,
        table: row[2] as string,
        from: row[3] as string,
        to: row[4] as string,
        on_update: row[5] as string,
        on_delete: row[6] as string,
      };

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
    switch (action?.toUpperCase()) {
      case 'CASCADE': return 'CASCADE';
      case 'RESTRICT': return 'RESTRICT';
      case 'SET NULL': return 'SET NULL';
      case 'SET DEFAULT': return 'SET DEFAULT';
      default: return 'NO ACTION';
    }
  }

  private getIndexes(db: SqlJsDatabase, tableName: string): Index[] {
    const indexListResult = db.exec(`PRAGMA index_list("${tableName}")`);
    if (!indexListResult[0]) return [];

    const indexes: Index[] = [];

    for (const row of indexListResult[0].values) {
      const info: IndexInfo = {
        seq: row[0] as number,
        name: row[1] as string,
        unique: row[2] as number,
        origin: row[3] as string,
        partial: row[4] as number,
      };

      if (info.name.startsWith('sqlite_autoindex_')) continue;

      const indexInfoResult = db.exec(`PRAGMA index_info("${info.name}")`);
      if (!indexInfoResult[0]) continue;

      const columns = indexInfoResult[0].values
        .sort((a: SqlValue[], b: SqlValue[]) => (a[0] as number) - (b[0] as number))
        .map((col: SqlValue[]) => col[2] as string);

      const index: Index = {
        name: info.name,
        tableName,
        columns,
        unique: info.unique === 1,
        type: "btree",
      };

      if (info.origin === 'pk') {
        index.constraint = { type: 'p' };
      } else if (info.origin === 'u') {
        index.constraint = { type: 'u' };
      }

      indexes.push(index);
    }

    return indexes;
  }

  private getCheckConstraints(db: SqlJsDatabase, tableName: string): CheckConstraint[] {
    const result = db.exec(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${tableName}'`
    );

    if (!result[0] || !result[0].values[0]) return [];

    const sql = result[0].values[0][0] as string;
    const checkRegex = /CHECK\s*\(([^)]+)\)/gi;
    const constraints: CheckConstraint[] = [];
    let match;

    while ((match = checkRegex.exec(sql)) !== null) {
      constraints.push({ expression: match[1]!.trim() });
    }

    return constraints;
  }

  private getUniqueConstraints(indexes: Index[]): UniqueConstraint[] {
    return indexes
      .filter(idx => idx.unique && idx.constraint?.type === 'u')
      .map(idx => ({
        name: idx.name,
        columns: idx.columns,
      }));
  }

  private async extractViews(db: SqlJsDatabase): Promise<View[]> {
    const result = db.exec(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'view'
      ORDER BY name
    `);

    if (!result[0]) return [];

    return result[0].values.map(row => {
      const name = row[0] as string;
      const sql = row[1] as string;
      const defMatch = sql?.match(/AS\s+(.+)$/is);

      return {
        name,
        definition: defMatch?.[1]?.trim() ?? '',
      };
    });
  }

  private async extractTriggers(db: SqlJsDatabase): Promise<Trigger[]> {
    const result = db.exec(`
      SELECT name, tbl_name, sql FROM sqlite_master
      WHERE type = 'trigger'
      ORDER BY name
    `);

    if (!result[0]) return [];

    return result[0].values.map(row => {
      const name = row[0] as string;
      const tblName = row[1] as string;
      const sql = (row[2] as string) || '';

      const timing = sql.match(/\b(BEFORE|AFTER|INSTEAD\s+OF)\b/i)?.[1]?.toUpperCase() as 'BEFORE' | 'AFTER' | 'INSTEAD OF' || 'BEFORE';
      const events: ('INSERT' | 'UPDATE' | 'DELETE')[] = [];
      if (/\bINSERT\b/i.test(sql)) events.push('INSERT');
      if (/\bUPDATE\b/i.test(sql)) events.push('UPDATE');
      if (/\bDELETE\b/i.test(sql)) events.push('DELETE');

      return {
        name,
        tableName: tblName,
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
    return value;
  }
}
