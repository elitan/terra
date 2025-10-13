/**
 * Schema Parser
 *
 * Main parser class that orchestrates parsing of SQL schema definitions.
 * Handles file I/O and coordinates all sub-parsers.
 */

import { readFileSync, existsSync } from "fs";
import { parse as parseCST } from "sql-parser-cst";
import { Logger } from "../../../utils/logger";
import { parseCreateTable } from "./tables/table-parser";
import { parseCreateIndex } from "./index-parser";
import { parseCreateType } from "./enum-parser";
import { parseCreateView } from "./view-parser";
import { parseCreateFunction } from "./function-parser";
import { parseCreateProcedure } from "./procedure-parser";
import { parseCreateTrigger } from "./trigger-parser";
import { parseCreateSequence } from "./sequence-parser";
import { parseCreateExtension } from "./extension-parser";
import { parseCreateSchema } from "./schema-definition-parser";
import type { Table, Index, EnumType, View, Function, Procedure, Trigger, Sequence, Extension, SchemaDefinition, Comment } from "../../../types/schema";
import { ParserError } from "../../../types/errors";

export class SchemaParser {
  /**
   * Parse schema from a file path
   */
  parseSchemaFile(filePath: string): {
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
  } {
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
  parseSchema(
    sql: string,
    filePath?: string
  ): {
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
  } {
    const { tables, indexes, enums, views, functions, procedures, triggers, sequences, extensions, schemas, comments } = this.parseWithCST(sql, filePath);

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
  parseCreateTableStatements(sql: string): Table[] {
    const { tables } = this.parseWithCST(sql);
    return tables;
  }

  /**
   * Parse CREATE INDEX statements
   */
  parseCreateIndexStatements(sql: string): Index[] {
    const { indexes } = this.parseWithCST(sql);
    return indexes;
  }

  /**
   * Parse CREATE VIEW statements
   */
  parseCreateViewStatements(sql: string): View[] {
    const { views } = this.parseWithCST(sql);
    return views;
  }

  /**
   * Parse SQL using sql-parser-cst and extract all schema objects
   */
  private parseWithCST(
    sql: string,
    filePath?: string
  ): {
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
  } {
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

    // First, extract CREATE EXTENSION statements manually (sql-parser-cst doesn't support them yet)
    const extensionMatches = this.extractExtensionStatements(sql);
    extensions.push(...extensionMatches);

    // Extract COMMENT ON statements manually (sql-parser-cst doesn't support them yet)
    const commentMatches = this.extractCommentStatements(sql);
    comments.push(...commentMatches);

    // Remove CREATE EXTENSION and COMMENT ON statements from SQL before parsing with CST
    let cleanedSql = sql;
    const extensionRegex = /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)(?:\s+WITH\s+)?(?:\s+SCHEMA\s+(\w+))?(?:\s+VERSION\s+'([^']+)')?(?:\s+CASCADE)?[^;]*;/gi;
    cleanedSql = cleanedSql.replace(extensionRegex, '');

    const commentRegex = /COMMENT\s+ON\s+(?:SCHEMA|TABLE|COLUMN|VIEW|FUNCTION|INDEX|TYPE)\s+[^;]+;/gi;
    cleanedSql = cleanedSql.replace(commentRegex, '');

    try {
      const cst = parseCST(cleanedSql, {
        dialect: "postgresql",
        includeSpaces: true,
        includeNewlines: true,
        includeComments: true,
        includeRange: true,
      });

      // Extract statements from the CST
      if (cst.statements) {
        for (const statement of cst.statements) {
          if (statement.type === "create_table_stmt") {
            const table = parseCreateTable(statement);
            if (table) {
              tables.push(table);
            }
          } else if (statement.type === "create_index_stmt") {
            const index = parseCreateIndex(statement);
            if (index) {
              indexes.push(index);
            }
          } else if (statement.type === "create_type_stmt") {
            const enumType = parseCreateType(statement);
            if (enumType) {
              enums.push(enumType);
            }
          } else if (statement.type === "create_view_stmt") {
            const view = parseCreateView(statement, sql);
            if (view) {
              views.push(view);
            }
          } else if (statement.type === "create_function_stmt") {
            const func = parseCreateFunction(statement);
            if (func) {
              functions.push(func);
            }
          } else if (statement.type === "create_procedure_stmt") {
            const proc = parseCreateProcedure(statement);
            if (proc) {
              procedures.push(proc);
            }
          } else if (statement.type === "create_trigger_stmt") {
            const trigger = parseCreateTrigger(statement);
            if (trigger) {
              triggers.push(trigger);
            }
          } else if (statement.type === "create_sequence_stmt") {
            const sequence = parseCreateSequence(statement);
            if (sequence) {
              sequences.push(sequence);
            }
          } else if (statement.type === "create_schema_stmt") {
            const schema = parseCreateSchema(statement);
            if (schema) {
              schemas.push(schema);
            }
          } else if (statement.type === "alter_table_stmt") {
            throw new ParserError(
              "ALTER TABLE statements are not supported in schema definitions. " +
                "Terra is a declarative schema tool - please define your complete desired schema " +
                "using CREATE TABLE statements with inline constraints. " +
                "For circular foreign keys, use inline CONSTRAINT syntax.",
              filePath
            );
          } else if (
            statement.type === "drop_table_stmt" ||
            statement.type === "drop_index_stmt"
          ) {
            throw new ParserError(
              "DROP statements are not supported in schema definitions. " +
                "Terra is a declarative schema tool - only include the tables and indexes " +
                "you want to exist. Terra will automatically determine what needs to be dropped.",
              filePath
            );
          }
        }
      }
    } catch (error) {
      // If it's already a ParserError, re-throw it
      if (error instanceof ParserError) {
        throw error;
      }

      // Handle CST parser errors (FormattedSyntaxError)
      if (error instanceof Error) {
        // Extract line and column from error message if available
        // CST errors have format like: "--> undefined:12:48" or "--> filename:12:48"
        const lineColMatch = error.message.match(/-->\s+(?:.*?):(\d+):(\d+)/);
        const line = lineColMatch?.[1] ? parseInt(lineColMatch[1]) : undefined;
        const column = lineColMatch?.[2] ? parseInt(lineColMatch[2]) : undefined;

        throw new ParserError(
          error.message,
          filePath,
          line,
          column
        );
      }

      // Unknown error type
      throw new ParserError(
        `Unexpected parser error: ${String(error)}`,
        filePath
      );
    }

    return { tables, indexes, enums, views, functions, procedures, triggers, sequences, extensions, schemas, comments };
  }

  /**
   * Extract CREATE EXTENSION statements manually using regex
   * This is a workaround until sql-parser-cst supports CREATE EXTENSION
   */
  private extractExtensionStatements(sql: string): Extension[] {
    const extensions: Extension[] = [];
    const extensionRegex = /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)(?:\s+WITH\s+)?(?:\s+SCHEMA\s+(\w+))?(?:\s+VERSION\s+'([^']+)')?(\s+CASCADE)?[^;]*;/gi;

    let match;
    while ((match = extensionRegex.exec(sql)) !== null) {
      // Skip if extension name is not captured (shouldn't happen with our regex, but be safe)
      if (!match[1]) continue;

      const extension: Extension = {
        name: match[1],
        schema: match[2] || undefined,
        version: match[3] || undefined,
        cascade: !!match[4],
      };
      extensions.push(extension);
    }

    return extensions;
  }

  /**
   * Extract COMMENT ON statements manually using regex
   * This is a workaround until sql-parser-cst supports COMMENT ON
   */
  private extractCommentStatements(sql: string): Comment[] {
    const comments: Comment[] = [];
    const commentRegex = /COMMENT\s+ON\s+(SCHEMA|TABLE|COLUMN|VIEW|FUNCTION|INDEX|TYPE)\s+([^\s]+(?:\s+IS)?)\s+IS\s+'([^']+)';/gi;

    let match;
    while ((match = commentRegex.exec(sql)) !== null) {
      const objectType = match[1].toUpperCase() as Comment['objectType'];
      const objectPath = match[2].replace(/\s+IS$/, '').trim();
      const commentText = match[3];

      const comment: Comment = {
        objectType,
        objectName: objectPath,
        comment: commentText,
      };

      comments.push(comment);
    }

    return comments;
  }
}
