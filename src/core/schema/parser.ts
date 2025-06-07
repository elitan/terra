import { readFileSync, existsSync } from "fs";
import { parse as parseCST, cstVisitor } from "sql-parser-cst";
import type { Table, Column } from "../../types/schema";
import { Logger } from "../../utils/logger";

export class SchemaParser {
  parseSchemaFile(filePath: string): Table[] {
    if (!existsSync(filePath)) {
      Logger.error(`✗ Schema file not found: ${filePath}`);
      process.exit(1);
    }

    const content = readFileSync(filePath, "utf-8");
    return this.parseCreateTableStatements(content);
  }

  parseCreateTableStatements(sql: string): Table[] {
    return this.parseWithCST(sql);
  }

  private parseWithCST(sql: string): Table[] {
    const tables: Table[] = [];

    try {
      const cst = parseCST(sql, {
        dialect: "postgresql",
        includeSpaces: true,
        includeNewlines: true,
        includeComments: true,
        includeRange: true,
      });

      // Extract CREATE TABLE statements directly from the CST
      if (cst.statements) {
        for (const statement of cst.statements) {
          if (statement.type === "create_table_stmt") {
            const table = this.parseCreateTableFromCST(statement);
            if (table) {
              tables.push(table);
            }
          }
        }
      }
    } catch (error) {
      Logger.error(
        `✗ CST parser failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }

    return tables;
  }

  private parseCreateTableFromCST(node: any): Table | null {
    try {
      // Extract table name
      const tableName = this.extractTableNameFromCST(node);
      if (!tableName) return null;

      // Extract columns
      const columns = this.extractColumnsFromCST(node);

      return {
        name: tableName,
        columns,
      };
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to parse CREATE TABLE from CST: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private extractTableNameFromCST(node: any): string | null {
    try {
      // Based on the CST structure, the table name is in the 'name' property
      return node.name?.text || node.name?.name || null;
    } catch (error) {
      return null;
    }
  }

  private extractColumnsFromCST(node: any): Column[] {
    const columns: Column[] = [];

    try {
      // Based on CST structure: node.columns.expr.items contains column_definition objects
      const columnItems = node.columns?.expr?.items || [];

      for (const columnNode of columnItems) {
        if (columnNode.type === "column_definition") {
          const column = this.parseColumnFromCST(columnNode);
          if (column) {
            columns.push(column);
          }
        }
      }
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to extract columns: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return columns;
  }

  private parseColumnFromCST(node: any): Column | null {
    try {
      // Extract column name from the node
      const name = node.name?.text || node.name?.name;
      if (!name) return null;

      // Extract data type
      const type = this.extractDataTypeFromCST(node);

      // Extract constraints
      const constraints = this.extractConstraintsFromCST(node);

      // Extract default value
      const defaultValue = this.extractDefaultValueFromCST(node);

      return {
        name,
        type,
        nullable: !constraints.notNull && !constraints.primary,
        default: defaultValue,
        primary: constraints.primary,
      };
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to parse column from CST: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private extractDataTypeFromCST(node: any): string {
    try {
      // Extract data type from dataType property
      const dataType = node.dataType;
      if (!dataType) return "UNKNOWN";

      // Get the type name
      let type = dataType.name?.text || dataType.name?.name || "UNKNOWN";
      type = type.toUpperCase();

      // Handle type parameters (e.g., VARCHAR(255), DECIMAL(10,2))
      if (dataType.params?.expr?.items) {
        const params = dataType.params.expr.items
          .map((item: any) => item.text || item.value)
          .join(",");
        type += `(${params})`;
      }

      return type;
    } catch (error) {
      return "UNKNOWN";
    }
  }

  private extractConstraintsFromCST(node: any): {
    notNull: boolean;
    primary: boolean;
  } {
    let notNull = false;
    let primary = false;

    try {
      if (node.constraints && Array.isArray(node.constraints)) {
        for (const constraint of node.constraints) {
          if (constraint.type === "constraint_not_null") {
            notNull = true;
          } else if (constraint.type === "constraint_primary_key") {
            primary = true;
          }
        }
      }
    } catch (error) {
      // Ignore extraction errors
    }

    return { notNull, primary };
  }

  private extractDefaultValueFromCST(node: any): string | undefined {
    try {
      if (node.constraints && Array.isArray(node.constraints)) {
        for (const constraint of node.constraints) {
          if (constraint.type === "constraint_default" && constraint.expr) {
            return this.serializeDefaultValueFromCST(constraint.expr);
          }
        }
      }
    } catch (error) {
      // Ignore extraction errors
    }

    return undefined;
  }

  private serializeDefaultValueFromCST(expr: any): string {
    try {
      if (expr.type === "number_literal") {
        return expr.text || String(expr.value);
      } else if (expr.type === "string_literal") {
        // The text property already includes quotes
        return expr.text;
      } else if (expr.type === "keyword") {
        return expr.text;
      } else if (expr.type === "function_call") {
        // Handle function calls like NOW(), CURRENT_TIMESTAMP
        const funcName = expr.name?.text || expr.name;
        return `${funcName}()`;
      } else if (expr.type === "prefix_op_expr") {
        // Handle negative numbers and other prefix operations
        const operator = expr.operator || "";
        const operand = this.serializeDefaultValueFromCST(expr.expr);
        return `${operator}${operand}`;
      } else if (expr.text) {
        return expr.text;
      }
    } catch (error) {
      // Ignore serialization errors
    }

    return String(expr);
  }

  // Helper methods for navigating CST
  private findNodeByType(node: any, type: string): any {
    if (node?.type === type) {
      return node;
    }

    if (node?.children) {
      for (const child of node.children) {
        const found = this.findNodeByType(child, type);
        if (found) return found;
      }
    }

    return null;
  }

  private findNodesByType(node: any, type: string): any[] {
    const results: any[] = [];

    if (node?.type === type) {
      results.push(node);
    }

    if (node?.children) {
      for (const child of node.children) {
        results.push(...this.findNodesByType(child, type));
      }
    }

    return results;
  }
}
