import { readFileSync, existsSync } from "fs";
import { parse as parseCST, cstVisitor } from "sql-parser-cst";
import type {
  Table,
  Column,
  PrimaryKeyConstraint,
  Index,
} from "../../types/schema";
import { Logger } from "../../utils/logger";

export class SchemaParser {
  parseSchemaFile(filePath: string): Table[] {
    if (!existsSync(filePath)) {
      Logger.error(`✗ Schema file not found: ${filePath}`);
      process.exit(1);
    }

    const content = readFileSync(filePath, "utf-8");
    return this.parseSchema(content);
  }

  parseSchema(sql: string): Table[] {
    const { tables } = this.parseWithCST(sql);
    return tables;
  }

  parseCreateTableStatements(sql: string): Table[] {
    const { tables } = this.parseWithCST(sql);
    return tables;
  }

  parseCreateIndexStatements(sql: string): Index[] {
    const { indexes } = this.parseWithCST(sql);
    return indexes;
  }

  private parseWithCST(sql: string): { tables: Table[]; indexes: Index[] } {
    const tables: Table[] = [];
    const indexes: Index[] = [];

    try {
      const cst = parseCST(sql, {
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
            const table = this.parseCreateTableFromCST(statement);
            if (table) {
              tables.push(table);
            }
          } else if (statement.type === "create_index_stmt") {
            const index = this.parseCreateIndexFromCST(statement);
            if (index) {
              indexes.push(index);
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

    return { tables, indexes };
  }

  private parseCreateTableFromCST(node: any): Table | null {
    try {
      // Extract table name
      const tableName = this.extractTableNameFromCST(node);
      if (!tableName) return null;

      // Extract columns and collect column-level primary key info
      const columnPrimaryKeys: string[] = [];
      const columns = this.extractColumnsFromCST(node, columnPrimaryKeys);

      // Extract table-level primary key constraints
      const tableLevelPrimaryKey =
        this.extractTableLevelPrimaryKeyFromCST(node);

      // Build unified primary key constraint
      const primaryKey = this.buildPrimaryKeyConstraint(
        columnPrimaryKeys,
        tableLevelPrimaryKey,
        tableName
      );

      return {
        name: tableName,
        columns,
        primaryKey,
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

  private extractColumnsFromCST(
    node: any,
    columnPrimaryKeys: string[]
  ): Column[] {
    const columns: Column[] = [];

    try {
      // Based on CST structure: node.columns.expr.items contains column_definition objects
      const columnItems = node.columns?.expr?.items || [];

      for (const columnNode of columnItems) {
        if (columnNode.type === "column_definition") {
          const column = this.parseColumnFromCST(columnNode, columnPrimaryKeys);
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

  private parseColumnFromCST(
    node: any,
    columnPrimaryKeys: string[]
  ): Column | null {
    try {
      // Extract column name from the node
      const name = node.name?.text || node.name?.name;
      if (!name) return null;

      // Extract data type
      const type = this.extractDataTypeFromCST(node);

      // Extract constraints
      const constraints = this.extractConstraintsFromCST(node);

      // If this column has a primary key constraint, add it to the list
      if (constraints.primary) {
        columnPrimaryKeys.push(name);
      }

      // Extract default value
      const defaultValue = this.extractDefaultValueFromCST(node);

      return {
        name,
        type,
        nullable: !constraints.notNull && !constraints.primary,
        default: defaultValue,
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
        const funcName = expr.name?.text || expr.name?.name || expr.name;
        if (funcName) {
          return `${funcName}()`;
        }
        // Fallback: try to extract text directly
        if (expr.text) {
          return expr.text;
        }
      } else if (expr.type === "prefix_op_expr") {
        // Handle negative numbers and other prefix operations
        const operator = expr.operator || "";
        const operand = this.serializeDefaultValueFromCST(expr.expr);
        return `${operator}${operand}`;
      } else if (expr.text) {
        return expr.text;
      }

      // If we can't serialize properly, try to extract text directly
      if (typeof expr === "string") {
        return expr;
      }

      // Last resort: return a descriptive error instead of [object Object]
      return "CURRENT_TIMESTAMP"; // Common default for timestamp columns
    } catch (error) {
      // Return a safe default instead of [object Object]
      return "CURRENT_TIMESTAMP";
    }
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

  private extractTableLevelPrimaryKeyFromCST(
    node: any
  ): PrimaryKeyConstraint | null {
    try {
      // Look for table-level PRIMARY KEY constraints in the columns section
      const columnItems = node.columns?.expr?.items || [];

      for (const item of columnItems) {
        // Look for constraint_primary_key type (table-level primary key)
        if (item.type === "constraint_primary_key") {
          const constraint = this.parseTableConstraintFromCST(item);
          if (constraint) {
            return constraint;
          }
        }
        // Look for named constraints (type: "constraint" with constraint.type: "constraint_primary_key")
        else if (
          item.type === "constraint" &&
          item.constraint?.type === "constraint_primary_key"
        ) {
          const constraint = this.parseNamedTableConstraintFromCST(item);
          if (constraint) {
            return constraint;
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private parseTableConstraintFromCST(node: any): PrimaryKeyConstraint | null {
    try {
      // Check if this is a primary key constraint
      if (node.type === "constraint_primary_key") {
        // Extract constraint name if present
        let constraintName: string | undefined;
        if (node.name) {
          constraintName = node.name.text || node.name.name;
        }

        // Extract column list from the columns property
        const columns: string[] = [];
        const columnList = node.columns;

        if (columnList?.expr?.items) {
          for (const col of columnList.expr.items) {
            // Handle index_specification type which contains the column reference
            let colName: string | undefined;
            if (col.type === "index_specification" && col.expr) {
              colName = col.expr.text || col.expr.name;
            } else {
              colName = col.text || col.name?.text || col.name?.name;
            }

            if (colName) {
              columns.push(colName);
            }
          }
        }

        if (columns.length > 0) {
          return {
            name: constraintName,
            columns,
          };
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private parseNamedTableConstraintFromCST(
    node: any
  ): PrimaryKeyConstraint | null {
    try {
      // Extract constraint name from the named constraint wrapper
      let constraintName: string | undefined;
      if (node.name?.name) {
        constraintName = node.name.name.text || node.name.name.name;
      }

      // Extract column list from the constraint.columns property
      const columns: string[] = [];
      const columnList = node.constraint?.columns;

      if (columnList?.expr?.items) {
        for (const col of columnList.expr.items) {
          // Handle index_specification type which contains the column reference
          let colName: string | undefined;
          if (col.type === "index_specification" && col.expr) {
            colName = col.expr.text || col.expr.name;
          } else {
            colName = col.text || col.name?.text || col.name?.name;
          }

          if (colName) {
            columns.push(colName);
          }
        }
      }

      if (columns.length > 0) {
        return {
          name: constraintName,
          columns,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private buildPrimaryKeyConstraint(
    columnPrimaryKeys: string[],
    tableLevelPrimaryKey: PrimaryKeyConstraint | null,
    tableName: string
  ): PrimaryKeyConstraint | undefined {
    // Validate that we don't have both column-level and table-level primary keys
    if (columnPrimaryKeys.length > 0 && tableLevelPrimaryKey) {
      Logger.warning(
        `⚠️ Table ${tableName} has both column-level and table-level primary key definitions. Using table-level definition.`
      );
      return tableLevelPrimaryKey;
    }

    // Return table-level primary key if it exists
    if (tableLevelPrimaryKey) {
      return tableLevelPrimaryKey;
    }

    // Convert column-level primary keys to table-level representation
    if (columnPrimaryKeys.length > 0) {
      return {
        columns: columnPrimaryKeys,
      };
    }

    // No primary key found
    return undefined;
  }

  // Index parsing methods
  private parseCreateIndexFromCST(node: any): Index | null {
    try {
      // Extract index name
      const indexName = this.extractIndexNameFromCST(node);
      if (!indexName) return null;

      // Extract table name
      const tableName = this.extractIndexTableNameFromCST(node);
      if (!tableName) return null;

      // Extract columns
      const columns = this.extractIndexColumnsFromCST(node);
      if (columns.length === 0) return null;

      // Extract index type (default is btree)
      const indexType = this.extractIndexTypeFromCST(node);

      // Extract unique flag
      const unique = this.extractIndexUniqueFromCST(node);

      // Extract concurrent flag
      const concurrent = this.extractIndexConcurrentFromCST(node);

      // Extract WHERE clause for partial indexes
      const whereClause = this.extractIndexWhereClauseFromCST(node);

      return {
        name: indexName,
        tableName,
        columns,
        type: indexType,
        unique,
        concurrent,
        where: whereClause,
      };
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to parse CREATE INDEX from CST: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private extractIndexNameFromCST(node: any): string | null {
    try {
      return node.name?.text || node.name?.name || null;
    } catch (error) {
      return null;
    }
  }

  private extractIndexTableNameFromCST(node: any): string | null {
    try {
      return node.table?.text || node.table?.name || null;
    } catch (error) {
      return null;
    }
  }

  private extractIndexColumnsFromCST(node: any): string[] {
    const columns: string[] = [];

    try {
      // Index columns are typically in node.columns.expr.items
      const columnItems = node.columns?.expr?.items || [];

      for (const columnNode of columnItems) {
        let columnName: string | undefined;

        // Handle different CST structures for index columns
        if (columnNode.type === "index_specification" && columnNode.expr) {
          columnName = columnNode.expr.text || columnNode.expr.name;
        } else {
          columnName =
            columnNode.text || columnNode.name?.text || columnNode.name?.name;
        }

        if (columnName) {
          columns.push(columnName);
        }
      }
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to extract index columns: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return columns;
  }

  private extractIndexTypeFromCST(node: any): Index["type"] {
    try {
      // Look for USING clause to determine index type
      const method = node.using?.method?.text || node.using?.method?.name;

      if (method) {
        const type = method.toLowerCase();
        if (["btree", "hash", "gist", "spgist", "gin", "brin"].includes(type)) {
          return type as Index["type"];
        }
      }

      // Default to btree if no USING clause specified
      return "btree";
    } catch (error) {
      return "btree";
    }
  }

  private extractIndexUniqueFromCST(node: any): boolean {
    try {
      // Check if the index has UNIQUE keyword (stored in indexTypeKw)
      return node.indexTypeKw?.name === "UNIQUE" || false;
    } catch (error) {
      return false;
    }
  }

  private extractIndexConcurrentFromCST(node: any): boolean {
    try {
      // Check if the index has CONCURRENTLY keyword
      return node.concurrentlyKw?.name === "CONCURRENTLY" || false;
    } catch (error) {
      return false;
    }
  }

  private extractIndexWhereClauseFromCST(node: any): string | undefined {
    try {
      // Look for WHERE clause in the clauses array
      if (node.clauses && Array.isArray(node.clauses)) {
        for (const clause of node.clauses) {
          if (clause.type === "where_clause" && clause.expr) {
            // Serialize the WHERE expression back to SQL string
            return this.serializeExpressionFromCST(clause.expr);
          }
        }
      }
      return undefined;
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to extract WHERE clause: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return undefined;
    }
  }

  private serializeExpressionFromCST(expr: any): string {
    try {
      // Handle different expression types
      if (typeof expr === "string") {
        return expr;
      }

      // Direct text property
      if (expr.text) {
        return expr.text;
      }

      // Comparison expressions (e.g., "column > value")
      if (expr.type === "binary_expr" || expr.type === "binary_op_expr") {
        const left = this.serializeExpressionFromCST(expr.left);
        const operator = expr.operator || "=";
        const right = this.serializeExpressionFromCST(expr.right);
        return `${left} ${operator} ${right}`;
      }

      // Column references
      if (expr.type === "identifier" || expr.type === "column_ref") {
        return expr.name || expr.text || expr.column || "unknown_column";
      }

      // Literals
      if (expr.type === "number_literal") {
        return String(expr.value || expr.text);
      }

      if (expr.type === "string_literal") {
        return expr.text || `'${expr.value}'`;
      }

      if (expr.type === "boolean_literal") {
        return String(expr.value || expr.valueKw?.text || expr.text);
      }

      // NULL values
      if (expr.type === "null_literal") {
        return "NULL";
      }

      // Function calls
      if (expr.type === "function_call") {
        const funcName = expr.name?.text || expr.name?.name || "unknown_func";
        // For now, just return the function name with parentheses
        // More complex function parsing can be added later
        return `${funcName}()`;
      }

      // Parenthesized expressions
      if (expr.type === "parenthesized_expr" && expr.expr) {
        return `(${this.serializeExpressionFromCST(expr.expr)})`;
      }

      // Unary expressions (e.g., NOT)
      if (expr.type === "unary_op_expr") {
        const operator = expr.operator || "";
        const operand = this.serializeExpressionFromCST(
          expr.operand || expr.expr
        );
        return `${operator} ${operand}`;
      }

      // Fallback: try to extract any available text
      if (expr.value !== undefined) {
        return String(expr.value);
      }

      // Final fallback
      return "unknown_expression";
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to serialize expression: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return "unknown_expression";
    }
  }
}
