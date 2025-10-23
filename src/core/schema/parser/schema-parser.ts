/**
 * Schema Parser
 *
 * Main parser class that orchestrates parsing of SQL schema definitions.
 * Handles file I/O and coordinates all sub-parsers.
 */

import { readFileSync, existsSync } from "fs";
import { parse, loadModule } from "pgsql-parser";
import { Logger } from "../../../utils/logger";
import { parseCreateTable } from "./tables/table-parser";
import { parseCreateIndex } from "./index-parser";
import { parseCreateType } from "./enum-parser";
import { parseCreateView, parseCreateMaterializedView } from "./view-parser";
import { parseCreateFunction } from "./function-parser";
import { parseCreateProcedure } from "./procedure-parser";
import { parseCreateTrigger } from "./trigger-parser";
import { parseCreateSequence } from "./sequence-parser";
import { parseCreateExtension } from "./extension-parser";
import { parseCreateSchema } from "./schema-definition-parser";
import type { Table, Index, EnumType, View, Function, Procedure, Trigger, Sequence, Extension, SchemaDefinition, Comment } from "../../../types/schema";
import { ParserError } from "../../../types/errors";

let wasmInitialized = false;

export class SchemaParser {
  private async ensureWasmLoaded() {
    if (!wasmInitialized) {
      await loadModule();
      wasmInitialized = true;
    }
  }

  /**
   * Extract error context from pgsql-parser error message
   */
  private extractErrorContext(errorMessage: string, sql: string): { line?: number; column?: number; snippet?: string } {
    // pgsql-parser errors sometimes contain position info like:
    // "syntax error at or near "something" at line X"
    // or just "syntax error at or near "something""

    // Try to extract quoted text that caused the error
    const nearMatch = errorMessage.match(/at or near "([^"]+)"/);
    const problemText = nearMatch ? nearMatch[1] : null;

    if (!problemText) {
      return {};
    }

    // Find the first occurrence of the problem text in the SQL
    const lines = sql.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] || '';
      const col = lineText.indexOf(problemText);

      if (col !== -1) {
        // Found it! Extract context
        const line = i + 1;
        const column = col + 1;

        // Get snippet: current line + 2 lines before and after
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 3);
        const contextLines = lines.slice(start, end);

        // Add line numbers and highlight the problem line
        const snippet = contextLines.map((l, idx) => {
          const lineNum = start + idx + 1;
          const marker = lineNum === line ? '→' : ' ';
          return `${marker} ${lineNum.toString().padStart(4)} | ${l}`;
        }).join('\n');

        return { line, column, snippet };
      }
    }

    return {};
  }

  /**
   * Auto-quote common reserved keywords when used as identifiers
   */
  private autoQuoteReservedKeywords(sql: string): string {
    // List of commonly used PostgreSQL reserved keywords that users might use as column names
    // Note: Excludes highly ambiguous keywords like 'table', 'column', 'index' that appear in DDL
    const keywords = [
      'user', 'year', 'month', 'day', 'hour', 'minute', 'second',
      'order', 'group', 'limit', 'offset',
      'key', 'value', 'comment', 'status'
    ];

    // Pattern to match unquoted identifiers in column definitions
    // This handles: column_name TYPE constraints
    // Only match after whitespace or comma to ensure it's in a column position
    for (const keyword of keywords) {
      // Match keyword preceded by whitespace/comma and followed by a type
      // Make sure it's not already quoted and not preceded by CREATE/ALTER
      const pattern = new RegExp(`(?<![CREATE|ALTER]\\s{1,20})(?<=\\s|,)\\b${keyword}\\b(?=\\s+(INTEGER|INT|INT2|INT4|INT8|SMALLINT|BIGINT|VARCHAR|TEXT|BOOLEAN|BOOL|TIMESTAMP|DATE|TIME|NUMERIC|DECIMAL|REAL|DOUBLE|SERIAL|BIGSERIAL|UUID|JSONB|JSON))`, 'gi');
      sql = sql.replace(pattern, `"${keyword}"`);

      // Also match in UNIQUE constraints: UNIQUE (column1, keyword, column3)
      const uniquePattern = new RegExp(`(UNIQUE\\s*\\([^)]*?)\\b${keyword}\\b`, 'gi');
      sql = sql.replace(uniquePattern, `$1"${keyword}"`);

      // Also match in PRIMARY KEY and FOREIGN KEY constraints
      const keyPattern = new RegExp(`((?:PRIMARY|FOREIGN)\\s+KEY\\s*\\([^)]*?)\\b${keyword}\\b`, 'gi');
      sql = sql.replace(keyPattern, `$1"${keyword}"`);
    }

    return sql;
  }

  /**
   * Parse schema from a file path
   */
  async parseSchemaFile(filePath: string): Promise<{
    tables: Table[];
    enums: EnumType[];
    views: View[];
    functions: Function[];
    procedures: Procedure[];
    triggers: Trigger[];
    sequences: Sequence[];
    extensions: Extension[];
    schemas: SchemaDefinition[];
    comments: Comment[];
  }> {
    if (!existsSync(filePath)) {
      throw new ParserError(
        `Schema file not found: ${filePath}`,
        filePath
      );
    }

    const content = readFileSync(filePath, "utf-8");
    return this.parseSchema(content, filePath);
  }

  /**
   * Parse schema from SQL string
   */
  async parseSchema(
    sql: string,
    filePath?: string
  ): Promise<{
    tables: Table[];
    enums: EnumType[];
    views: View[];
    functions: Function[];
    procedures: Procedure[];
    triggers: Trigger[];
    sequences: Sequence[];
    extensions: Extension[];
    schemas: SchemaDefinition[];
    comments: Comment[];
  }> {
    await this.ensureWasmLoaded();

    const { tables, indexes, enums, views, functions, procedures, triggers, sequences, extensions, schemas, comments } = await this.parseWithPgsql(sql, filePath);

    // Associate standalone indexes with their tables
    const tableMap = new Map(tables.map((t) => [t.name, t]));

    for (const index of indexes) {
      const table = tableMap.get(index.tableName);
      if (table) {
        if (!table.indexes) {
          table.indexes = [];
        }
        table.indexes.push(index);
      }
    }

    return { tables, enums, views, functions, procedures, triggers, sequences, extensions, schemas, comments };
  }

  /**
   * Parse CREATE TABLE statements
   */
  async parseCreateTableStatements(sql: string): Promise<Table[]> {
    await this.ensureWasmLoaded();
    const { tables } = await this.parseWithPgsql(sql);
    return tables;
  }

  /**
   * Parse CREATE INDEX statements
   */
  async parseCreateIndexStatements(sql: string): Promise<Index[]> {
    await this.ensureWasmLoaded();
    const { indexes } = await this.parseWithPgsql(sql);
    return indexes;
  }

  /**
   * Parse CREATE VIEW statements
   */
  async parseCreateViewStatements(sql: string): Promise<View[]> {
    await this.ensureWasmLoaded();
    const { views } = await this.parseWithPgsql(sql);
    return views;
  }

  /**
   * Parse SQL using pgsql-parser and extract all schema objects
   */
  private async parseWithPgsql(
    sql: string,
    filePath?: string
  ): Promise<{
    tables: Table[];
    indexes: Index[];
    enums: EnumType[];
    views: View[];
    functions: Function[];
    procedures: Procedure[];
    triggers: Trigger[];
    sequences: Sequence[];
    extensions: Extension[];
    schemas: SchemaDefinition[];
    comments: Comment[];
  }> {
    const tables: Table[] = [];
    const indexes: Index[] = [];
    const enums: EnumType[] = [];
    const views: View[] = [];
    const functions: Function[] = [];
    const procedures: Procedure[] = [];
    const triggers: Trigger[] = [];
    const sequences: Sequence[] = [];
    const extensions: Extension[] = [];
    const schemas: SchemaDefinition[] = [];
    const comments: Comment[] = [];

    // Auto-quote reserved keywords that are commonly used as column names
    sql = this.autoQuoteReservedKeywords(sql);

    // Handle empty SQL (after keyword quoting to preserve empty checks correctly)
    if (!sql || sql.trim() === '') {
      return { tables, indexes, enums, views, functions, procedures, triggers, sequences, extensions, schemas, comments };
    }

    try {
      const ast = await parse(sql);

      if (!ast.stmts) {
        return { tables, indexes, enums, views, functions, procedures, triggers, sequences, extensions, schemas, comments };
      }

      for (const stmtWrapper of ast.stmts) {
        const stmt = stmtWrapper.stmt;

        if (stmt.CreateStmt) {
          const table = parseCreateTable(stmt.CreateStmt);
          if (table) {
            tables.push(table);
          }
        } else if (stmt.IndexStmt) {
          const index = parseCreateIndex(stmt.IndexStmt);
          if (index) {
            indexes.push(index);
          }
        } else if (stmt.CreateEnumStmt) {
          const enumType = parseCreateType(stmt.CreateEnumStmt);
          if (enumType) {
            enums.push(enumType);
          }
        } else if (stmt.ViewStmt) {
          const view = parseCreateView(stmt.ViewStmt, sql);
          if (view) {
            views.push(view);
          }
        } else if (stmt.CreateTableAsStmt) {
          const view = parseCreateMaterializedView(stmt.CreateTableAsStmt);
          if (view) {
            views.push(view);
          }
        } else if (stmt.CreateFunctionStmt) {
          const func = parseCreateFunction(stmt.CreateFunctionStmt);
          if (func) {
            functions.push(func);
          }
        } else if (stmt.CreateProcedureStmt) {
          const proc = parseCreateProcedure(stmt.CreateProcedureStmt);
          if (proc) {
            procedures.push(proc);
          }
        } else if (stmt.CreateTrigStmt) {
          const trigger = parseCreateTrigger(stmt.CreateTrigStmt);
          if (trigger) {
            triggers.push(trigger);
          }
        } else if (stmt.CreateSeqStmt) {
          const sequence = parseCreateSequence(stmt.CreateSeqStmt);
          if (sequence) {
            sequences.push(sequence);
          }
        } else if (stmt.CreateExtensionStmt) {
          const extension = parseCreateExtension(stmt.CreateExtensionStmt);
          if (extension) {
            extensions.push(extension);
          }
        } else if (stmt.CreateSchemaStmt) {
          const schema = parseCreateSchema(stmt.CreateSchemaStmt);
          if (schema) {
            schemas.push(schema);
          }
        } else if (stmt.CommentStmt) {
          const comment = this.parseCommentStmt(stmt.CommentStmt);
          if (comment) {
            comments.push(comment);
          }
        } else if (stmt.AlterTableStmt) {
          throw new ParserError(
            "ALTER TABLE statements are not supported in schema definitions. " +
              "Terra is a declarative schema tool - please define your complete desired schema " +
              "using CREATE TABLE statements with inline constraints. " +
              "For circular foreign keys, use inline CONSTRAINT syntax.",
            filePath
          );
        } else if (stmt.DropStmt) {
          throw new ParserError(
            "DROP statements are not supported in schema definitions. " +
              "Terra is a declarative schema tool - only include the tables and indexes " +
              "you want to exist. Terra will automatically determine what needs to be dropped.",
            filePath
          );
        }
      }
    } catch (error) {
      if (error instanceof ParserError) {
        throw error;
      }

      if (error instanceof Error) {
        // Try to extract line/column info from pgsql-parser error message
        const { line, column, snippet } = this.extractErrorContext(error.message, sql);

        throw new ParserError(
          error.message,
          filePath,
          line,
          column,
          snippet
        );
      }

      throw new ParserError(
        `Unexpected parser error: ${String(error)}`,
        filePath
      );
    }

    return { tables, indexes, enums, views, functions, procedures, triggers, sequences, extensions, schemas, comments };
  }

  /**
   * Parse COMMENT ON statement
   */
  private parseCommentStmt(stmt: any): Comment | null {
    if (!stmt.objtype || !stmt.comment) {
      return null;
    }

    const objectTypeMap: Record<string, Comment['objectType']> = {
      'OBJECT_TABLE': 'TABLE',
      'OBJECT_COLUMN': 'COLUMN',
      'OBJECT_VIEW': 'VIEW',
      'OBJECT_INDEX': 'INDEX',
      'OBJECT_SCHEMA': 'SCHEMA',
      'OBJECT_TYPE': 'TYPE',
      'OBJECT_FUNCTION': 'FUNCTION',
    };

    const objectType = objectTypeMap[stmt.objtype];
    if (!objectType) {
      return null;
    }

    // For COLUMN comments, we need to extract table name, column name, and optionally schema
    if (objectType === 'COLUMN' && stmt.object) {
      const parts = this.extractObjectParts(stmt.object);

      if (parts.length === 2 && parts[0] && parts[1]) {
        // Format: table.column
        return {
          objectType,
          objectName: parts[0], // table name
          columnName: parts[1], // column name
          comment: stmt.comment
        };
      } else if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
        // Format: schema.table.column
        return {
          objectType,
          objectName: parts[1], // table name
          schemaName: parts[0], // schema name
          columnName: parts[2], // column name
          comment: stmt.comment
        };
      }
    }

    // For other object types, extract name normally
    let objectName = '';
    let schemaName: string | undefined;

    if (stmt.object) {
      const parts = this.extractObjectParts(stmt.object);
      if (parts.length === 2 && objectType !== 'SCHEMA' && parts[0] && parts[1]) {
        // Format: schema.object
        schemaName = parts[0];
        objectName = parts[1];
      } else {
        objectName = parts[parts.length - 1] || '';
      }
    }

    return {
      objectType,
      objectName,
      schemaName,
      comment: stmt.comment
    };
  }

  /**
   * Extract object parts from AST node (returns array of parts)
   */
  private extractObjectParts(obj: any): string[] {
    if (obj.String?.sval) {
      return [obj.String.sval];
    }

    if (obj.List?.items) {
      return obj.List.items.map((item: any) => {
        if (item.String?.sval) return item.String.sval;
        return String(item);
      });
    }

    if (Array.isArray(obj)) {
      return obj.map(item => {
        if (item.String?.sval) return item.String.sval;
        return String(item);
      });
    }

    return [String(obj)];
  }

}
