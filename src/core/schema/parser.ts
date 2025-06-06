import { readFileSync, existsSync } from "fs";
import pkg from "node-sql-parser";
const { Parser } = pkg;
import type { Table, Column } from "../../types/schema";
import { Logger } from "../../utils/logger";

export class SchemaParser {
  private parser: any;

  constructor() {
    this.parser = new Parser();
  }

  parseSchemaFile(filePath: string): Table[] {
    if (!existsSync(filePath)) {
      Logger.error(`✗ Schema file not found: ${filePath}`);
      process.exit(1);
    }

    const content = readFileSync(filePath, "utf-8");
    return this.parseCreateTableStatements(content);
  }

  parseCreateTableStatements(sql: string): Table[] {
    const tables: Table[] = [];

    try {
      // Split SQL into individual statements
      const statements = this.splitSqlStatements(sql);

      for (const statement of statements) {
        const trimmed = statement.trim();
        if (!trimmed || !trimmed.toLowerCase().startsWith("create table")) {
          continue;
        }

        try {
          const ast = this.parser.astify(trimmed, { database: "postgresql" });

          // Handle both single statements and arrays
          const createStatements = Array.isArray(ast) ? ast : [ast];

          for (const stmt of createStatements) {
            if (stmt.type === "create" && stmt.keyword === "table") {
              const table = this.parseCreateTableAst(stmt);
              if (table) {
                tables.push(table);
              }
            }
          }
        } catch (error) {
          Logger.warning(
            `⚠️ Failed to parse statement: ${trimmed.substring(0, 100)}...`
          );
          Logger.warning(
            `Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    } catch (error) {
      Logger.error(
        `✗ Failed to parse SQL: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return tables;
  }

  private splitSqlStatements(sql: string): string[] {
    // Simple split on semicolons - node-sql-parser handles the complex parsing
    return sql
      .split(";")
      .map((stmt) => stmt.trim())
      .filter((stmt) => stmt.length > 0);
  }

  private parseCreateTableAst(ast: any): Table | null {
    try {
      const tableName = this.extractTableName(ast.table);
      if (!tableName) return null;

      const columns = this.parseColumnsFromAst(ast.create_definitions || []);

      return {
        name: tableName,
        columns,
      };
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to parse table from AST: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private extractTableName(tableInfo: any): string | null {
    if (Array.isArray(tableInfo) && tableInfo.length > 0) {
      const firstTable = tableInfo[0];
      return firstTable?.table || null;
    }
    if (typeof tableInfo === "string") {
      return tableInfo;
    }
    if (tableInfo && typeof tableInfo === "object") {
      return tableInfo.table || tableInfo.name || null;
    }
    return null;
  }

  private parseColumnsFromAst(definitions: any[]): Column[] {
    const columns: Column[] = [];

    for (const def of definitions) {
      if (def.resource === "column" && def.column) {
        const column = this.parseColumnDefinitionFromAst(def);
        if (column) {
          columns.push(column);
        }
      }
    }

    return columns;
  }

  private parseColumnDefinitionFromAst(def: any): Column | null {
    try {
      // Extract column name from the nested structure
      const name =
        def.column?.column?.expr?.value || def.column?.column || def.column;
      if (!name || typeof name !== "string") return null;

      // Parse data type
      const type = this.parseDataType(def.definition);

      // Parse constraints - check both definition and top-level fields
      const constraints = this.parseConstraints(def);

      // Parse default value
      const defaultValue = this.parseDefaultValue(def);

      return {
        name,
        type,
        nullable: !constraints.notNull && !constraints.primary,
        default: defaultValue,
        primary: constraints.primary,
      };
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to parse column: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private parseDataType(definition: any): string {
    if (!definition || !definition.dataType) {
      return "UNKNOWN";
    }

    let type = definition.dataType.toUpperCase();

    // Handle type parameters (e.g., VARCHAR(255), DECIMAL(10,2))
    if (definition.length !== undefined) {
      if (Array.isArray(definition.length)) {
        // Multiple parameters like DECIMAL(10,2)
        type += `(${definition.length.join(",")})`;
      } else {
        // Single parameter like VARCHAR(255)
        type += `(${definition.length})`;
      }
    }

    // Handle scale for DECIMAL/NUMERIC types
    if (definition.scale !== undefined) {
      if (definition.length !== undefined) {
        // Already has length, add scale
        type = type.replace(")", `,${definition.scale})`);
      } else {
        // Only scale, no length (unusual but possible)
        type += `(${definition.scale})`;
      }
    }

    return type;
  }

  private parseConstraints(def: any): {
    notNull: boolean;
    primary: boolean;
  } {
    let notNull = false;
    let primary = false;

    // Check for primary key at the top level
    if (def.primary_key === "primary key") {
      primary = true;
      notNull = true; // Primary key implies not null
    }

    // Check for NOT NULL constraint
    if (def.nullable?.type === "not null") {
      notNull = true;
    }

    // Also check definition.constraint for other constraints
    if (def.definition && def.definition.constraint) {
      const constraints = Array.isArray(def.definition.constraint)
        ? def.definition.constraint
        : [def.definition.constraint];

      for (const constraint of constraints) {
        if (constraint === "not null" || constraint === "NOT NULL") {
          notNull = true;
        } else if (
          constraint === "primary key" ||
          constraint === "PRIMARY KEY"
        ) {
          primary = true;
          notNull = true; // Primary key implies not null
        }
      }
    }

    return { notNull, primary };
  }

  private parseDefaultValue(def: any): string | undefined {
    const defaultVal = def.default_val || def.definition?.default_val;

    if (!defaultVal) {
      return undefined;
    }

    // The default value is often nested in a "value" property
    const actualValue = defaultVal.value || defaultVal;

    return this.serializeValue(actualValue);
  }

  private serializeValue(value: any): string {
    if (value === null || value === undefined) {
      return "NULL";
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (typeof value === "object") {
      if (value.type === "single_quote_string" || value.type === "string") {
        return `'${value.value}'`;
      } else if (value.type === "number") {
        return String(value.value);
      } else if (value.type === "function") {
        const funcName = value.name;
        const args =
          value.args && Array.isArray(value.args)
            ? value.args.map((arg: any) => this.serializeValue(arg)).join(", ")
            : "";
        return `${funcName}(${args})`;
      } else if (value.type === "column_ref") {
        return value.column;
      }
    }
    return String(value);
  }
}
