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
  IndexTerm,
} from "../../types/schema";
import {
  extractSQLiteCheckExpressions,
  extractSQLiteAutoincrementColumns,
  extractSQLiteColumnCollations,
  extractSQLiteGeneratedExpressions,
  extractSQLiteViewDefinition,
  parseSQLiteIndexDefinition,
  parseSQLiteTriggerMetadata,
  replaceSQLiteCreateTableName,
} from "./sql-parser-utils";
import { normalizeSQLiteIdentifier } from "../../utils/sqlite-identifier";

interface TableInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden?: number;
}

interface ForeignKeyInfo {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexInfo {
  seq: number;
  name: string;
  unique: number;
  origin: string;
}

interface IndexColumnInfo {
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string;
  key: number;
}

interface SqliteMasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface SQLiteTableListRow {
  schema: string;
  name: string;
  type: "table" | "view" | "shadow" | "virtual";
  wr: number;
  strict: number;
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
    const tableList = await client.query<SQLiteTableListRow>("PRAGMA table_list");
    const tableOptions = new Map(
      tableList.rows
        .filter(function (row) {
          return row.schema === "main";
        })
        .map(function (row) {
          return [row.name, row] as const;
        })
    );

    const result: Table[] = [];

    for (const tableRow of tables.rows) {
      const options = tableOptions.get(tableRow.name);
      if (options?.type === "shadow") {
        continue;
      }
      const table = await this.parseTable(
        client,
        tableRow.name,
        tableRow.sql,
        {
          virtual: options?.type === "virtual",
          strict: options?.strict === 1,
          withoutRowid: options?.wr === 1,
        }
      );
      result.push(table);
    }

    this.resolveImplicitForeignKeyColumns(result);
    return result;
  }

  private resolveImplicitForeignKeyColumns(tables: Table[]): void {
    const tablesByName = new Map(
      tables.map(function (table) {
        return [normalizeSQLiteIdentifier(table.name), table] as const;
      })
    );

    for (const table of tables) {
      for (const foreignKey of table.foreignKeys || []) {
        if (foreignKey.referencedColumns.length === foreignKey.columns.length) {
          continue;
        }
        const parentTable = tablesByName.get(
          normalizeSQLiteIdentifier(foreignKey.referencedTable)
        );
        const primaryKeyColumns = parentTable?.primaryKey?.columns || [];
        if (
          foreignKey.referencedColumns.length === 0 &&
          primaryKeyColumns.length === foreignKey.columns.length
        ) {
          foreignKey.referencedColumns = [...primaryKeyColumns];
        }
      }
    }
  }

  private async parseTable(
    client: SQLiteClient,
    tableName: string,
    createSql: string | null,
    tableOptions: {
      virtual: boolean;
      strict: boolean;
      withoutRowid: boolean;
    }
  ): Promise<Table> {
    const rawCreateStatement = createSql?.trim().replace(/;+\s*$/g, "") || "";
    const createStatement = replaceSQLiteCreateTableName(
      rawCreateStatement,
      tableName
    )
      ? rawCreateStatement
      : "";
    const tableInfo = await client.query<TableInfo>(
      `PRAGMA table_xinfo(${this.quoteIdentifier(tableName)})`
    );
    const columns = this.getColumns(tableInfo.rows, tableName, createSql);
    const primaryKey = this.getPrimaryKey(tableInfo.rows);
    const foreignKeys = await this.getForeignKeys(client, tableName);
    const indexes = await this.getIndexes(client, tableName);
    const checkConstraints = await this.getCheckConstraints(client, tableName);
    const uniqueConstraints = await this.getUniqueConstraints(client, tableName);
    const autoincrementColumns = extractSQLiteAutoincrementColumns(createStatement);

    return {
      name: tableName,
      columns,
      createStatement: createStatement || undefined,
      virtual: tableOptions.virtual || undefined,
      strict: tableOptions.strict,
      withoutRowid: tableOptions.withoutRowid,
      autoincrementColumns: autoincrementColumns.length > 0
        ? autoincrementColumns
        : undefined,
      primaryKey: primaryKey || undefined,
      foreignKeys: foreignKeys.length > 0 ? foreignKeys : undefined,
      checkConstraints: checkConstraints.length > 0 ? checkConstraints : undefined,
      uniqueConstraints: uniqueConstraints.length > 0 ? uniqueConstraints : undefined,
      indexes: indexes.filter(idx => !idx.constraint),
    };
  }

  private getColumns(
    rows: TableInfo[],
    tableName: string,
    createSql: string | null
  ): Column[] {
    const generatedExpressions = extractSQLiteGeneratedExpressions(createSql || "");
    const collations = extractSQLiteColumnCollations(createSql || "");
    const inspector = this;

    return rows
      .filter(function (row) {
        return row.hidden !== 1;
      })
      .map(function (row) {
        const generated = row.hidden === 2 || row.hidden === 3;
        const expression = generatedExpressions.get(row.name);
        if (generated && expression === undefined) {
          throw new Error(
            `Unable to inspect generated expression for SQLite column "${tableName}.${row.name}"`
          );
        }

        const generatedMetadata = generated && expression !== undefined
          ? {
              always: true,
              expression,
              stored: row.hidden === 3,
            }
          : undefined;
        const collation = collations.get(row.name);

        return {
          name: row.name,
          type: inspector.normalizeType(row.type),
          nullable: row.notnull === 0 && row.pk === 0,
          default: row.dflt_value
            ? inspector.normalizeDefault(row.dflt_value)
            : undefined,
          ...(collation ? { collation: { name: collation } } : {}),
          generated: generatedMetadata,
        };
      });
  }

  private getPrimaryKey(rows: TableInfo[]): PrimaryKeyConstraint | null {
    const pkColumns = rows.filter(row => row.pk > 0).sort((a, b) => a.pk - b.pk);

    if (pkColumns.length === 0) {
      return null;
    }

    return {
      columns: pkColumns.map(col => col.name),
    };
  }

  private async getForeignKeys(client: SQLiteClient, tableName: string): Promise<ForeignKeyConstraint[]> {
    const fks = await client.query<ForeignKeyInfo>(
      `PRAGMA foreign_key_list(${this.quoteIdentifier(tableName)})`
    );

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
      if (fk.to !== null) {
        constraint.referencedColumns.push(fk.to);
      }
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
    const indexList = await client.query<IndexInfo>(
      `PRAGMA index_list(${this.quoteIdentifier(tableName)})`
    );
    const result: Index[] = [];

    for (const idx of indexList.rows) {
      if (idx.origin !== "c" || idx.name.startsWith('sqlite_autoindex_')) {
        continue;
      }

      const indexInfo = await client.query<IndexColumnInfo>(
        `PRAGMA index_xinfo(${this.quoteIdentifier(idx.name)})`
      );
      const keyColumns = indexInfo.rows
        .filter(function (column) {
          return column.key === 1;
        })
        .sort(function (left, right) {
          return left.seqno - right.seqno;
        });
      const createResult = await client.query<SqliteMasterRow>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
        [idx.name]
      );
      const createStatement = createResult.rows[0]?.sql
        ?.trim()
        .replace(/;+\s*$/g, "");
      if (!createStatement) {
        throw new Error(`Unable to inspect CREATE statement for SQLite index "${idx.name}"`);
      }

      const definition = parseSQLiteIndexDefinition(createStatement);
      if (definition.expressions.length !== keyColumns.length) {
        throw new Error(`Unable to inspect indexed terms for SQLite index "${idx.name}"`);
      }

      const terms: IndexTerm[] = keyColumns.map(function (column, position) {
        const common = {
          collation: column.coll,
          order: column.desc === 1 ? "DESC" as const : "ASC" as const,
        };
        if (column.cid === -2) {
          return {
            expression: definition.expressions[position]!,
            ...common,
          };
        }
        if (column.name === null) {
          throw new Error(`Unable to inspect column for SQLite index "${idx.name}"`);
        }
        return { column: column.name, ...common };
      });
      const columns = terms.flatMap(function (term) {
        return term.column === undefined ? [] : [term.column];
      });

      const index: Index = {
        name: idx.name,
        tableName,
        columns,
        unique: idx.unique === 1,
        type: "btree",
        sortOrders: terms.map(function (term) {
          return term.order || "ASC";
        }),
        terms,
        createStatement,
      };

      if (definition.where !== undefined) {
        index.where = definition.where;
      }

      result.push(index);
    }

    return result.sort(function (left, right) {
      return left.name.localeCompare(right.name);
    });
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
    return extractSQLiteCheckExpressions(sql).map(function (expression) {
      return { expression };
    });
  }

  private async getUniqueConstraints(
    client: SQLiteClient,
    tableName: string
  ): Promise<UniqueConstraint[]> {
    const indexList = await client.query<IndexInfo>(
      `PRAGMA index_list(${this.quoteIdentifier(tableName)})`
    );
    const constraints: UniqueConstraint[] = [];

    for (const index of indexList.rows) {
      if (index.origin !== "u") {
        continue;
      }

      const indexInfo = await client.query<IndexColumnInfo>(
        `PRAGMA index_xinfo(${this.quoteIdentifier(index.name)})`
      );
      const keyColumns = indexInfo.rows
        .filter(function (column) {
          return column.key === 1;
        })
        .sort(function (left, right) {
          return left.seqno - right.seqno;
        });
      if (keyColumns.some(function (column) {
        return column.name === null;
      })) {
        throw new Error(
          `Unable to inspect UNIQUE constraint columns for SQLite index "${index.name}"`
        );
      }
      const columns = keyColumns
        .map(function (column) {
          return column.name as string;
        });
      const collations = keyColumns.map(function (column) {
        return column.coll;
      });
      constraints.push({ columns, collations });
    }

    return constraints.sort(function (left, right) {
      return left.columns.join("\0").localeCompare(right.columns.join("\0"));
    });
  }

  async getCurrentViews(client: SQLiteClient): Promise<View[]> {
    const views = await client.query<SqliteMasterRow>(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'view'
      ORDER BY name
    `);

    return views.rows.map(function (row) {
      const createStatement = row.sql?.trim().replace(/;+\s*$/g, "") || "";
      return {
        name: row.name,
        definition: extractSQLiteViewDefinition(createStatement),
        createStatement: createStatement || undefined,
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

    return triggers.rows.map(function (row) {
      const sql = row.sql || '';
      const metadata = parseSQLiteTriggerMetadata(sql);

      return {
        name: row.name,
        tableName: row.tbl_name,
        timing: metadata.timing,
        events: metadata.events,
        functionName: '',
        definition: sql.trim().replace(/;+\s*$/g, ''),
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

  private quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }
}
