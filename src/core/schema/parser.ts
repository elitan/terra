import { readFileSync, existsSync } from "fs";
import { parse as parseCST, cstVisitor } from "sql-parser-cst";
import type {
  Table,
  Column,
  PrimaryKeyConstraint,
  ForeignKeyConstraint,
  CheckConstraint,
  UniqueConstraint,
  Index,
  EnumType,
} from "../../types/schema";
import { Logger } from "../../utils/logger";

export class SchemaParser {
  parseSchemaFile(filePath: string): Table[] {
    if (!existsSync(filePath)) {
      Logger.error(`✗ Schema file not found: ${filePath}`);
      process.exit(1);
    }

    const content = readFileSync(filePath, "utf-8");
    const { tables } = this.parseSchema(content);
    return tables;
  }

  parseSchema(sql: string): { tables: Table[]; enums: EnumType[] } {
    const { tables, indexes, enums } = this.parseWithCST(sql);
    
    // Associate standalone indexes with their tables
    const tableMap = new Map(tables.map(t => [t.name, t]));
    
    for (const index of indexes) {
      const table = tableMap.get(index.tableName);
      if (table) {
        if (!table.indexes) {
          table.indexes = [];
        }
        table.indexes.push(index);
      }
    }
    
    return { tables, enums };
  }

  parseCreateTableStatements(sql: string): Table[] {
    const { tables } = this.parseWithCST(sql);
    return tables;
  }

  parseCreateIndexStatements(sql: string): Index[] {
    const { indexes } = this.parseWithCST(sql);
    return indexes;
  }

  private parseWithCST(sql: string): { tables: Table[]; indexes: Index[]; enums: EnumType[] } {
    const tables: Table[] = [];
    const indexes: Index[] = [];
    const enums: EnumType[] = [];

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
          } else if (statement.type === "create_type_stmt") {
            const enumType = this.parseCreateTypeFromCST(statement);
            if (enumType) {
              enums.push(enumType);
            }
          } else if (statement.type === "alter_table_stmt") {
            throw new Error(
              "ALTER TABLE statements are not supported in schema definitions. " +
              "PgTerra is a declarative schema tool - please define your complete desired schema " +
              "using CREATE TABLE statements with inline constraints. " +
              "For circular foreign keys, use inline CONSTRAINT syntax."
            );
          } else if (statement.type === "drop_table_stmt" || statement.type === "drop_index_stmt") {
            throw new Error(
              "DROP statements are not supported in schema definitions. " +
              "PgTerra is a declarative schema tool - only include the tables and indexes " +
              "you want to exist. PgTerra will automatically determine what needs to be dropped."
            );
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

    return { tables, indexes, enums };
  }

  private parseCreateTableFromCST(node: any): Table | null {
    try {
      // Extract table name
      const tableName = this.extractTableNameFromCST(node);
      if (!tableName) return null;

      // Extract columns
      const columns = this.extractColumnsFromCST(node);

      // Extract ALL constraints in a unified way
      const constraints = this.extractAllConstraintsFromCST(node, tableName);

      return {
        name: tableName,
        columns,
        primaryKey: constraints.primaryKey,
        foreignKeys: constraints.foreignKeys.length > 0 ? constraints.foreignKeys : undefined,
        checkConstraints: constraints.checkConstraints.length > 0 ? constraints.checkConstraints : undefined,
        uniqueConstraints: constraints.uniqueConstraints.length > 0 ? constraints.uniqueConstraints : undefined,
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

      // Extract basic constraints (just for column properties)
      const constraints = this.extractBasicConstraintsFromCST(node);

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

  private extractBasicConstraintsFromCST(node: any): {
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

  // Unified constraint extraction - handles ALL constraint types
  private extractAllConstraintsFromCST(node: any, tableName: string): {
    primaryKey?: PrimaryKeyConstraint;
    foreignKeys: ForeignKeyConstraint[];
    checkConstraints: CheckConstraint[];
    uniqueConstraints: UniqueConstraint[];
  } {
    const foreignKeys: ForeignKeyConstraint[] = [];
    const checkConstraints: CheckConstraint[] = [];
    const uniqueConstraints: UniqueConstraint[] = [];
    const columnPrimaryKeys: string[] = [];
    let tableLevelPrimaryKey: PrimaryKeyConstraint | undefined;

    try {
      const columnItems = node.columns?.expr?.items || [];

      for (const item of columnItems) {
        if (item.type === "column_definition") {
          // Extract column-level constraints
          this.extractColumnConstraints(item, columnPrimaryKeys, checkConstraints, uniqueConstraints);
        } else if (item.type === "constraint") {
          // Extract named table-level constraints
          const pk = this.extractNamedConstraint(item, tableLevelPrimaryKey, foreignKeys, checkConstraints, uniqueConstraints);
          if (pk) tableLevelPrimaryKey = pk;
        } else if (item.type === "constraint_primary_key") {
          // Extract direct table-level primary key
          tableLevelPrimaryKey = this.parseTableConstraintFromCST(item);
        } else if (item.type === "constraint_foreign_key") {
          // Extract direct table-level foreign key
          const fk = this.parseForeignKeyConstraintFromCST(item);
          if (fk) foreignKeys.push(fk);
        } else if (item.type === "constraint_check") {
          // Extract direct table-level check constraint
          const check = this.parseCheckConstraintFromCST(item);
          if (check) checkConstraints.push(check);
        } else if (item.type === "constraint_unique") {
          // Extract direct table-level unique constraint
          const unique = this.parseUniqueConstraintFromCST(item);
          if (unique) uniqueConstraints.push(unique);
        }
      }
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to extract constraints: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Build final primary key constraint
    const primaryKey = this.buildPrimaryKeyConstraint(
      columnPrimaryKeys,
      tableLevelPrimaryKey,
      tableName
    );

    return {
      primaryKey,
      foreignKeys,
      checkConstraints,
      uniqueConstraints,
    };
  }

  private extractColumnConstraints(
    columnNode: any,
    columnPrimaryKeys: string[],
    checkConstraints: CheckConstraint[],
    uniqueConstraints: UniqueConstraint[]
  ): void {
    const columnName = columnNode.name?.text || columnNode.name?.name;
    if (!columnName) return;

    try {
      if (columnNode.constraints && Array.isArray(columnNode.constraints)) {
        for (const constraint of columnNode.constraints) {
          if (constraint.type === "constraint_primary_key") {
            columnPrimaryKeys.push(columnName);
          } else if (constraint.type === "constraint_check") {
            const check = this.parseColumnCheckConstraint(constraint, columnName);
            if (check) checkConstraints.push(check);
          } else if (constraint.type === "constraint_unique") {
            const unique = this.parseColumnUniqueConstraint(constraint, columnName);
            if (unique) uniqueConstraints.push(unique);
          }
        }
      }
    } catch (error) {
      Logger.warning(`⚠️ Failed to extract column constraints for ${columnName}`);
    }
  }

  private extractNamedConstraint(
    item: any,
    tableLevelPrimaryKey: PrimaryKeyConstraint | undefined,
    foreignKeys: ForeignKeyConstraint[],
    checkConstraints: CheckConstraint[],
    uniqueConstraints: UniqueConstraint[]
  ): PrimaryKeyConstraint | undefined {
    const constraintName = item.name?.name?.text || item.name?.name?.name;
    const constraint = item.constraint;

    if (!constraint) return tableLevelPrimaryKey;

    try {
      if (constraint.type === "constraint_primary_key") {
        const pk = this.parseTableConstraintFromCST(constraint);
        if (pk) {
          pk.name = constraintName;
          return pk; // Return the primary key to be assigned
        }
      } else if (constraint.type === "constraint_foreign_key") {
        const fk = this.parseForeignKeyConstraintFromCST(constraint);
        if (fk) {
          fk.name = constraintName;
          foreignKeys.push(fk);
        }
      } else if (constraint.type === "constraint_check") {
        const check = this.parseCheckConstraintFromCST(constraint);
        if (check) {
          check.name = constraintName;
          checkConstraints.push(check);
        }
      } else if (constraint.type === "constraint_unique") {
        const unique = this.parseUniqueConstraintFromCST(constraint);
        if (unique) {
          unique.name = constraintName;
          uniqueConstraints.push(unique);
        }
      }
    } catch (error) {
      Logger.warning(`⚠️ Failed to extract named constraint ${constraintName}`);
    }
    
    return tableLevelPrimaryKey;
  }

  // Constraint parsing methods
  private parseCheckConstraintFromCST(node: any): CheckConstraint | null {
    try {
      // Extract constraint name if present
      let constraintName: string | undefined;
      if (node.name) {
        constraintName = node.name.text || node.name.name;
      }

      // Extract the check expression
      // The expression might be wrapped in parentheses, so handle paren_expr
      let exprNode = node.expr;
      if (exprNode?.type === "paren_expr" && exprNode.expr) {
        exprNode = exprNode.expr;
      }
      
      const expression = this.serializeExpressionFromCST(exprNode);
      if (!expression || expression === "unknown_expression") {
        return null;
      }

      return {
        name: constraintName,
        expression,
      };
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to parse check constraint: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private parseColumnCheckConstraint(node: any, columnName: string): CheckConstraint | null {
    try {
      // Column-level check constraints usually don't have explicit names
      // We'll generate a name based on the column
      const constraintName = `${columnName}_check`;

      // Extract the check expression
      let exprNode = node.expr;
      if (exprNode?.type === "paren_expr" && exprNode.expr) {
        exprNode = exprNode.expr;
      }
      
      const expression = this.serializeExpressionFromCST(exprNode);
      if (!expression || expression === "unknown_expression") {
        return null;
      }

      return {
        name: constraintName,
        expression,
      };
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to parse column-level check constraint: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private parseForeignKeyConstraintFromCST(node: any): ForeignKeyConstraint | null {
    try {
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

      // Extract referenced table and columns from references property
      let referencedTable: string | undefined;
      const referencedColumns: string[] = [];

      if (node.references) {
        referencedTable = node.references.table?.text || node.references.table?.name;
        
        if (node.references.columns?.expr?.items) {
          for (const col of node.references.columns.expr.items) {
            let colName: string | undefined;
            if (col.type === "index_specification" && col.expr) {
              colName = col.expr.text || col.expr.name;
            } else {
              colName = col.text || col.name?.text || col.name?.name;
            }

            if (colName) {
              referencedColumns.push(colName);
            }
          }
        }
      }

      if (!referencedTable || columns.length === 0 || referencedColumns.length === 0) {
        return null;
      }

      // Extract ON DELETE and ON UPDATE actions from references.options
      const onDelete = this.extractReferentialActionFromReferences(node.references, 'DELETE');
      const onUpdate = this.extractReferentialActionFromReferences(node.references, 'UPDATE');

      return {
        name: constraintName,
        columns,
        referencedTable,
        referencedColumns,
        onDelete,
        onUpdate,
      };
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to parse foreign key constraint: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private extractReferentialActionFromReferences(references: any, actionType: 'DELETE' | 'UPDATE'): 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | undefined {
    try {
      // Look for referential actions in the references.options array
      if (!references?.options || !Array.isArray(references.options)) {
        return undefined;
      }

      for (const option of references.options) {
        // Check if this option matches the action type we're looking for
        if (option.type === 'referential_action') {
          const eventType = option.eventKw?.name || option.eventKw?.text;
          if (eventType === actionType) {
            const actionName = option.actionKw?.name || option.actionKw?.text;
            return this.mapActionName(actionName);
          }
        }
      }

      return undefined;
    } catch (error) {
      return undefined;
    }
  }

  private mapActionName(actionName: string | undefined): 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | undefined {
    if (!actionName) return undefined;
    
    switch (actionName.toUpperCase()) {
      case 'CASCADE':
        return 'CASCADE';
      case 'RESTRICT':
        return 'RESTRICT';
      case 'SET NULL':
      case 'SETNULL':
        return 'SET NULL';
      case 'SET DEFAULT':
      case 'SETDEFAULT':
        return 'SET DEFAULT';
      default:
        return undefined;
    }
  }

  private parseUniqueConstraintFromCST(node: any): UniqueConstraint | null {
    try {
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

      if (columns.length === 0) {
        return null;
      }

      // Extract deferrable properties
      let deferrable: boolean | undefined;
      let initiallyDeferred: boolean | undefined;

      // Look for DEFERRABLE and INITIALLY DEFERRED keywords
      if (node.deferrable || node.deferrableKw) {
        deferrable = true;
      }
      
      if (node.initiallyDeferred || node.initiallyDeferredKw || node.initially) {
        initiallyDeferred = true;
      }

      return {
        name: constraintName,
        columns,
        deferrable,
        initiallyDeferred,
      };
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to parse unique constraint: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private parseColumnUniqueConstraint(node: any, columnName: string): UniqueConstraint | null {
    try {
      // Column-level unique constraints usually don't have explicit names
      // We'll generate a name based on the column
      const constraintName = `${columnName}_unique`;

      return {
        name: constraintName,
        columns: [columnName],
      };
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to parse column-level unique constraint: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
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
      } else if (expr.type === "boolean_literal") {
        // Handle boolean literals properly 
        return String(expr.value || expr.valueKw?.text || expr.text);
      } else if (expr.type === "keyword") {
        return expr.text;
      } else if (expr.type === "function_call" || expr.type === "func_call") {
        // Handle function calls like NOW(), CURRENT_TIMESTAMP
        const funcName = expr.name?.text || expr.name?.name || expr.name;
        if (funcName) {
          // Special cases for PostgreSQL keywords that look like functions but aren't
          const keywordFunctions = ['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'LOCALTIME', 'LOCALTIMESTAMP'];
          if (keywordFunctions.includes(funcName.toUpperCase()) && !expr.args) {
            return funcName;
          }
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
      } else if (expr.type === "cast_operator_expr" || expr.type === "cast_expr") {
        // Handle cast expressions like '{}'::jsonb
        const left = this.serializeDefaultValueFromCST(expr.left || expr.expr);
        const right = expr.right?.name?.text || expr.right?.name?.name || expr.type_name?.name?.text || "unknown_type";
        return `${left}::${right}`;
      } else if (expr.type === "named_data_type") {
        // Handle named data types in cast expressions
        return expr.name?.text || expr.name?.name || "unknown_type";
      } else if (expr.text) {
        return expr.text;
      }

      // If we can't serialize properly, try to extract text directly
      if (typeof expr === "string") {
        return expr;
      }

      // Last resort: log the issue and return null to indicate we couldn't parse it
      Logger.warning(`⚠️ Unable to serialize default value: ${JSON.stringify(expr)}`);
      return "NULL";
    } catch (error) {
      Logger.warning(`⚠️ Error serializing default value: ${error instanceof Error ? error.message : String(error)}`);
      return "NULL";
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

      // Extract columns and detect expressions
      const indexColumnInfo =
        this.extractIndexColumnsAndExpressionsFromCST(node);
      if (indexColumnInfo.columns.length === 0 && !indexColumnInfo.expression) {
        return null;
      }

      // Extract index type (default is btree)
      const indexType = this.extractIndexTypeFromCST(node);

      // Extract unique flag
      const unique = this.extractIndexUniqueFromCST(node);

      // Extract concurrent flag
      const concurrent = this.extractIndexConcurrentFromCST(node);

      // Extract WHERE clause for partial indexes
      const whereClause = this.extractIndexWhereClauseFromCST(node);

      // Extract storage parameters
      const storageParameters = this.extractIndexStorageParametersFromCST(node);

      // Extract tablespace
      const tablespace = this.extractIndexTablespaceFromCST(node);

      return {
        name: indexName,
        tableName,
        columns: indexColumnInfo.columns,
        type: indexType,
        unique,
        concurrent,
        where: whereClause,
        expression: indexColumnInfo.expression,
        storageParameters:
          storageParameters && Object.keys(storageParameters).length > 0
            ? storageParameters
            : undefined,
        tablespace,
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

  private extractIndexColumnsAndExpressionsFromCST(node: any): {
    columns: string[];
    expression?: string;
  } {
    const columns: string[] = [];
    let expression: string | undefined;

    try {
      // Index columns are typically in node.columns.expr.items
      const columnItems = node.columns?.expr?.items || [];

      // Check if we have exactly one item and it's an expression (not just a simple column)
      if (columnItems.length === 1) {
        const singleItem = columnItems[0];

        // Check if this looks like an expression (function call, complex expression, etc.)
        if (this.isIndexExpression(singleItem)) {
          expression = this.serializeExpressionFromCST(
            singleItem.expr || singleItem
          );
          return { columns: [], expression };
        }
      }

      // Handle regular column names or multiple columns
      for (const columnNode of columnItems) {
        let columnName: string | undefined;

        // Handle different CST structures for index columns
        if (columnNode.type === "index_specification" && columnNode.expr) {
          // Check if expr is a simple identifier (column name) vs expression
          if (
            columnNode.expr.type === "identifier" ||
            columnNode.expr.type === "column_ref"
          ) {
            columnName = columnNode.expr.text || columnNode.expr.name;
          } else {
            // This is an expression, not a simple column
            Logger.info(
              "Found expression in multi-column context, treating as complex expression"
            );
            expression = this.serializeExpressionFromCST(columnNode.expr);
            return { columns: [], expression };
          }
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

    return { columns, expression };
  }

  private isIndexExpression(node: any): boolean {
    // Check if the node represents an expression rather than a simple column reference

    // Function calls are definitely expressions
    if (
      node.type === "function_call" ||
      node.expr?.type === "function_call" ||
      node.type === "func_call" ||
      node.expr?.type === "func_call"
    ) {
      return true;
    }

    // Parenthesized expressions
    if (
      node.type === "parenthesized_expr" ||
      node.expr?.type === "parenthesized_expr"
    ) {
      return true;
    }

    // Binary operations (e.g., EXTRACT(YEAR FROM date_col))
    if (node.type === "binary_expr" || node.expr?.type === "binary_expr") {
      return true;
    }

    // Type casts
    if (node.type === "cast_expr" || node.expr?.type === "cast_expr") {
      return true;
    }

    // Case expressions
    if (node.type === "case_expr" || node.expr?.type === "case_expr") {
      return true;
    }

    // For index_specification nodes, check the inner expr
    if (node.type === "index_specification" && node.expr) {
      return this.isIndexExpression(node.expr);
    }

    return false;
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

  private extractIndexStorageParametersFromCST(
    node: any
  ): Record<string, string> | undefined {
    try {
      const parameters: Record<string, string> = {};

      // Look for WITH clause in the clauses array
      if (node.clauses && Array.isArray(node.clauses)) {
        for (const clause of node.clauses) {
          if (
            clause.type === "postgresql_with_options" &&
            clause.options?.expr?.items
          ) {
            // Extract storage parameters from the WITH clause
            for (const option of clause.options.expr.items) {
              if (option.type === "table_option") {
                // Extract parameter name and value
                const key = option.name?.text || option.name?.name;
                let value: string | undefined;

                if (option.value) {
                  if (option.value.text) {
                    value = option.value.text;
                  } else if (option.value.valueKw?.text) {
                    value = option.value.valueKw.text;
                  } else {
                    value = this.serializeExpressionFromCST(option.value);
                  }
                }

                if (key && value !== undefined) {
                  parameters[key] = value;
                }
              }
            }
          }
        }
      }

      return Object.keys(parameters).length > 0 ? parameters : undefined;
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to extract storage parameters: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return undefined;
    }
  }

  private extractIndexTablespaceFromCST(node: any): string | undefined {
    try {
      // Look for TABLESPACE clause in the clauses array
      if (node.clauses && Array.isArray(node.clauses)) {
        for (const clause of node.clauses) {
          if (clause.type === "tablespace_clause") {
            // Extract tablespace name
            return (
              clause.name?.text ||
              clause.name?.name ||
              clause.tablespace?.text ||
              clause.tablespace?.name
            );
          }
        }
      }
      return undefined;
    } catch (error) {
      Logger.warning(
        `⚠️ Failed to extract tablespace: ${
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

      // Binary expressions (comparison, logical operators, etc.)
      if (expr.type === "binary_expr" || expr.type === "binary_op_expr") {
        const left = this.serializeExpressionFromCST(expr.left);
        
        // Extract operator - it might be a string or an object with text/name
        let operator = "=";
        if (typeof expr.operator === "string") {
          operator = expr.operator;
        } else if (expr.operator?.text) {
          operator = expr.operator.text;
        } else if (expr.operator?.name) {
          operator = expr.operator.name;
        }
        
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

      // Function calls (handle both "function_call" and "func_call" types)
      if (expr.type === "function_call" || expr.type === "func_call") {
        const funcName = expr.name?.text || expr.name?.name || "unknown_func";

        // Special cases for PostgreSQL keywords that look like functions but aren't
        const keywordFunctions = ['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'LOCALTIME', 'LOCALTIMESTAMP'];
        if (keywordFunctions.includes(funcName.toUpperCase()) && !expr.args) {
          return funcName;
        }

        // Handle function arguments
        let args = "";

        // PostgreSQL CST structure: args.expr.args.items
        if (expr.args?.expr?.args?.items) {
          const argStrings = expr.args.expr.args.items.map((arg: any) =>
            this.serializeExpressionFromCST(arg)
          );
          args = argStrings.join(", ");
        }
        // Alternative structure: args.expr.items
        else if (expr.args?.expr?.items) {
          const argStrings = expr.args.expr.items.map((arg: any) =>
            this.serializeExpressionFromCST(arg)
          );
          args = argStrings.join(", ");
        }
        // Simple array structure
        else if (expr.args && Array.isArray(expr.args)) {
          const argStrings = expr.args.map((arg: any) =>
            this.serializeExpressionFromCST(arg)
          );
          args = argStrings.join(", ");
        }

        return `${funcName}(${args})`;
      }

      // Parenthesized expressions (handle both "parenthesized_expr" and "paren_expr")
      if ((expr.type === "parenthesized_expr" || expr.type === "paren_expr") && expr.expr) {
        return `(${this.serializeExpressionFromCST(expr.expr)})`;
      }

      // Unary expressions (e.g., NOT)
      if (expr.type === "unary_op_expr" || expr.type === "prefix_op_expr") {
        const operator = expr.operator?.text || expr.operator?.name || expr.operator || "";
        const operand = this.serializeExpressionFromCST(
          expr.operand || expr.expr
        );
        return `${operator} ${operand}`;
      }

      // INTERVAL expressions
      if (expr.type === "interval_expr" || expr.type === "interval_literal") {
        if (expr.type === "interval_literal") {
          // Handle interval_literal structure: INTERVAL 'value'
          const value = expr.string?.text || expr.string?.value || "'1 day'";
          return `INTERVAL ${value}`;
        } else {
          // Handle interval_expr structure: INTERVAL value unit
          const value = this.serializeExpressionFromCST(expr.value || expr.expr);
          const unit = expr.unit?.text || expr.unit?.name || "DAY";
          return `INTERVAL ${value} ${unit}`;
        }
      }

      // Keywords (CURRENT_DATE, CURRENT_TIMESTAMP, etc.)
      if (expr.type === "keyword") {
        return expr.text || expr.name || String(expr.value);
      }

      // BETWEEN expressions
      if (expr.type === "between_expr") {
        const value = this.serializeExpressionFromCST(expr.left || expr.expr);
        const low = this.serializeExpressionFromCST(expr.begin || expr.low);
        const high = this.serializeExpressionFromCST(expr.end || expr.high);
        return `${value} BETWEEN ${low} AND ${high}`;
      }

      // IN expressions  
      if (expr.type === "in_expr") {
        const value = this.serializeExpressionFromCST(expr.expr);
        const list = expr.list?.expr?.items || [];
        const items = list.map((item: any) => this.serializeExpressionFromCST(item)).join(", ");
        return `${value} IN (${items})`;
      }

      // IS NULL / IS NOT NULL expressions
      if (expr.type === "is_expr") {
        const value = this.serializeExpressionFromCST(expr.expr);
        const operator = expr.not ? "IS NOT" : "IS";
        const test = expr.test?.text || "NULL";
        return `${value} ${operator} ${test}`;
      }

      // Regular expressions (~, ~*, !~, !~*)
      if (expr.type === "match_expr") {
        const left = this.serializeExpressionFromCST(expr.left);
        const operator = expr.operator?.text || "~";
        const right = this.serializeExpressionFromCST(expr.right);
        return `${left} ${operator} ${right}`;
      }

      // Cast expressions (e.g., '{}' :: jsonb, value::type)
      if (expr.type === "cast_operator_expr" || expr.type === "cast_expr") {
        const left = this.serializeExpressionFromCST(expr.left || expr.expr);
        const right = this.serializeExpressionFromCST(expr.right || expr.type_name || expr.dataType);
        return `${left}::${right}`;
      }

      // Named data types (for cast expressions)
      if (expr.type === "named_data_type") {
        return expr.name?.text || expr.name?.name || "unknown_type";
      }

      // JSON/JSONB operators (?, ?&, ?|, ->, ->>, #>, #>>, @>, <@, etc.)
      if (expr.type === "json_expr" || expr.type === "jsonb_expr") {
        const left = this.serializeExpressionFromCST(expr.left);
        const operator = expr.operator?.text || expr.operator?.name || "?";
        const right = this.serializeExpressionFromCST(expr.right);
        return `${left} ${operator} ${right}`;
      }

      // PostgreSQL-specific operators (including JSON operators)
      if (expr.type === "pg_operator_expr" || expr.type === "postfix_op_expr") {
        const left = this.serializeExpressionFromCST(expr.left || expr.expr);
        const operator = expr.operator?.text || expr.operator?.name || "?";
        
        // Handle binary operators
        if (expr.right) {
          const right = this.serializeExpressionFromCST(expr.right);
          return `${left} ${operator} ${right}`;
        }
        
        // Handle postfix operators
        return `${left}${operator}`;
      }

      // Array/subscript expressions [index] and JSON path access
      if (expr.type === "subscript_expr" || expr.type === "array_subscript") {
        const array = this.serializeExpressionFromCST(expr.expr || expr.left);
        const index = this.serializeExpressionFromCST(expr.index || expr.right);
        return `${array}[${index}]`;
      }

      // List expressions (for IN clauses, function arguments, etc.)
      if (expr.type === "list_expr") {
        const items = expr.items?.map((item: any) => this.serializeExpressionFromCST(item)) || [];
        return items.join(", ");
      }

      // CASE expressions
      if (expr.type === "case_expr") {
        let result = "CASE";
        if (expr.expr) {
          result += ` ${this.serializeExpressionFromCST(expr.expr)}`;
        }
        
        if (expr.whenList && Array.isArray(expr.whenList)) {
          for (const whenClause of expr.whenList) {
            const when = this.serializeExpressionFromCST(whenClause.when);
            const then = this.serializeExpressionFromCST(whenClause.then);
            result += ` WHEN ${when} THEN ${then}`;
          }
        }
        
        if (expr.else) {
          result += ` ELSE ${this.serializeExpressionFromCST(expr.else)}`;
        }
        
        result += " END";
        return result;
      }

      // Fallback: try to extract any available text
      if (expr.value !== undefined) {
        return String(expr.value);
      }

      // Log what we're missing for debugging  
      Logger.warning(`⚠️ Unhandled expression type: ${expr.type || 'undefined'}, structure: ${JSON.stringify(expr, null, 2)}`);

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

  private parseCreateTypeFromCST(node: any): EnumType | null {
    try {
      // Extract type name
      const typeName = this.extractTypeNameFromCST(node);
      if (!typeName) return null;

      // Check if this is an ENUM type
      if (!this.isEnumTypeFromCST(node)) {
        // For now, we only support ENUM types
        Logger.warning(`⚠️ Unsupported type definition: ${typeName}. Only ENUM types are currently supported.`);
        return null;
      }

      // Extract ENUM values
      const enumValues = this.extractEnumValuesFromCST(node);
      if (enumValues.length === 0) {
        throw new Error(
          `Invalid ENUM type '${typeName}': ENUM types must have at least one value. ` +
          `Empty ENUM types are not allowed in PostgreSQL.`
        );
      }

      return {
        name: typeName,
        values: enumValues,
      };
    } catch (error) {
      // If it's a validation error (e.g., empty ENUM), propagate it
      if (error instanceof Error && error.message.includes('Invalid ENUM type')) {
        throw error;
      }
      
      // For other parsing errors, log and return null
      Logger.warning(
        `⚠️ Failed to parse CREATE TYPE from CST: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private extractTypeNameFromCST(node: any): string | null {
    try {
      return node.name?.text || node.name?.name || null;
    } catch (error) {
      return null;
    }
  }

  private isEnumTypeFromCST(node: any): boolean {
    try {
      // Check if the node has an enum_type_definition
      return node.definition?.type === "enum_type_definition";
    } catch (error) {
      return false;
    }
  }

  private extractEnumValuesFromCST(node: any): string[] {
    const values: string[] = [];
    
    try {
      // ENUM values are in node.definition.values.expr.items based on the debug output
      const enumItems = node.definition?.values?.expr?.items || [];

      for (const valueNode of enumItems) {
        const value = this.extractStringValueFromCST(valueNode);
        if (value) {
          values.push(value);
        }
      }
    } catch (error) {
      Logger.warning(`⚠️ Failed to extract ENUM values: ${error instanceof Error ? error.message : String(error)}`);
    }

    return values;
  }

  private extractStringValueFromCST(node: any): string | null {
    try {
      // Handle string literals
      if (node.type === "string_literal" || node.type === "literal") {
        return node.text?.replace(/^'|'$/g, '') || node.value || null;
      }
      
      // Handle direct text
      if (typeof node.text === 'string') {
        return node.text.replace(/^'|'$/g, '');
      }

      // Handle value property
      if (typeof node.value === 'string') {
        return node.value.replace(/^'|'$/g, '');
      }

      return null;
    } catch (error) {
      return null;
    }
  }
}
