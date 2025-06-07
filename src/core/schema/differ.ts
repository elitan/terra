import type { Table, Column, PrimaryKeyConstraint } from "../../types/schema";
import {
  generateCreateTableStatement,
  columnsAreDifferent,
  normalizeType,
  generateAddPrimaryKeySQL,
  generateDropPrimaryKeySQL,
} from "../../utils/sql";

export class SchemaDiffer {
  generateMigrationPlan(
    desiredSchema: Table[],
    currentSchema: Table[]
  ): string[] {
    const statements: string[] = [];

    // Create a map of current tables for easy lookup
    const currentTables = new Map(currentSchema.map((t) => [t.name, t]));
    const desiredTables = new Map(desiredSchema.map((t) => [t.name, t]));

    // Handle new tables
    for (const table of desiredSchema) {
      if (!currentTables.has(table.name)) {
        statements.push(generateCreateTableStatement(table));
      } else {
        // Handle existing tables - ORDER MATTERS!
        const currentTable = currentTables.get(table.name)!;

        // 1. First handle primary key changes that involve dropping constraints
        const primaryKeyDropStatements = this.generatePrimaryKeyDropStatements(
          table,
          currentTable
        );
        statements.push(...primaryKeyDropStatements);

        // 2. Then handle column changes (now that blocking constraints are removed)
        const columnStatements = this.generateColumnStatements(
          table,
          currentTable
        );
        statements.push(...columnStatements);

        // 3. Finally handle primary key additions/modifications
        const primaryKeyAddStatements = this.generatePrimaryKeyAddStatements(
          table,
          currentTable
        );
        statements.push(...primaryKeyAddStatements);
      }
    }

    // Handle dropped tables
    for (const table of currentSchema) {
      if (!desiredTables.has(table.name)) {
        statements.push(`DROP TABLE ${table.name};`);
      }
    }

    return statements;
  }

  private generateColumnStatements(
    desiredTable: Table,
    currentTable: Table
  ): string[] {
    const statements: string[] = [];

    const currentColumns = new Map(
      currentTable.columns.map((c) => [c.name, c])
    );
    const desiredColumns = new Map(
      desiredTable.columns.map((c) => [c.name, c])
    );

    // Add new columns
    for (const column of desiredTable.columns) {
      if (!currentColumns.has(column.name)) {
        let statement = `ALTER TABLE ${desiredTable.name} ADD COLUMN ${column.name} ${column.type}`;
        if (!column.nullable) statement += " NOT NULL";
        if (column.default) statement += ` DEFAULT ${column.default}`;
        statements.push(statement + ";");
      } else {
        // Check for column modifications
        const currentColumn = currentColumns.get(column.name)!;
        if (columnsAreDifferent(column, currentColumn)) {
          // Handle actual column modifications
          const modificationStatements =
            this.generateColumnModificationStatements(
              desiredTable.name,
              column,
              currentColumn
            );
          statements.push(...modificationStatements);
        }
      }
    }

    // Drop removed columns
    for (const column of currentTable.columns) {
      if (!desiredColumns.has(column.name)) {
        statements.push(
          `ALTER TABLE ${desiredTable.name} DROP COLUMN ${column.name};`
        );
      }
    }

    return statements;
  }

  private generateColumnModificationStatements(
    tableName: string,
    desiredColumn: Column,
    currentColumn: Column
  ): string[] {
    const statements: string[] = [];

    const normalizedDesiredType = normalizeType(desiredColumn.type);
    const normalizedCurrentType = normalizeType(currentColumn.type);
    const typeIsChanging = normalizedDesiredType !== normalizedCurrentType;
    const defaultIsChanging = desiredColumn.default !== currentColumn.default;

    // Step 1: If type is changing and there's a current default that might conflict, drop it first
    if (typeIsChanging && currentColumn.default && defaultIsChanging) {
      statements.push(
        `ALTER TABLE ${tableName} ALTER COLUMN ${desiredColumn.name} DROP DEFAULT;`
      );
    }

    // Step 2: Change the type if needed
    if (typeIsChanging) {
      const typeConversionSQL = this.generateTypeConversionSQL(
        tableName,
        desiredColumn.name,
        desiredColumn.type,
        currentColumn.type
      );
      statements.push(typeConversionSQL);
    }

    // Step 3: Set the new default if needed (after type change)
    if (defaultIsChanging) {
      if (desiredColumn.default) {
        statements.push(
          `ALTER TABLE ${tableName} ALTER COLUMN ${desiredColumn.name} SET DEFAULT ${desiredColumn.default};`
        );
      } else if (!typeIsChanging || !currentColumn.default) {
        // Only drop default if we didn't already drop it in step 1
        statements.push(
          `ALTER TABLE ${tableName} ALTER COLUMN ${desiredColumn.name} DROP DEFAULT;`
        );
      }
    }

    // Step 4: Handle nullable constraint changes last
    if (desiredColumn.nullable !== currentColumn.nullable) {
      if (!desiredColumn.nullable) {
        statements.push(
          `ALTER TABLE ${tableName} ALTER COLUMN ${desiredColumn.name} SET NOT NULL;`
        );
      } else {
        statements.push(
          `ALTER TABLE ${tableName} ALTER COLUMN ${desiredColumn.name} DROP NOT NULL;`
        );
      }
    }

    return statements;
  }

  private generateTypeConversionSQL(
    tableName: string,
    columnName: string,
    desiredType: string,
    currentType: string
  ): string {
    // Special handling for SERIAL type conversions
    if (desiredType === "SERIAL") {
      // SERIAL can't be used in ALTER COLUMN, must use INTEGER
      // and handle sequence creation separately if needed
      const needsUsing = this.requiresUsingClause(currentType, "INTEGER");

      if (needsUsing) {
        const usingExpression = this.generateUsingExpression(
          columnName,
          currentType,
          "INTEGER"
        );
        return `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE INTEGER USING ${usingExpression};`;
      } else {
        return `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE INTEGER;`;
      }
    }

    // Check if we need a USING clause for type conversion
    const needsUsing = this.requiresUsingClause(currentType, desiredType);

    if (needsUsing) {
      const usingExpression = this.generateUsingExpression(
        columnName,
        currentType,
        desiredType
      );
      return `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE ${desiredType} USING ${usingExpression};`;
    } else {
      return `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE ${desiredType};`;
    }
  }

  private requiresUsingClause(
    currentType: string,
    desiredType: string
  ): boolean {
    // PostgreSQL requires USING clause for these conversions that can't be done automatically
    const currentNormalized = normalizeType(currentType).toLowerCase();
    const desiredNormalized = normalizeType(desiredType).toLowerCase();

    // VARCHAR/TEXT to numeric types needs USING
    if (
      currentNormalized.includes("varchar") ||
      currentNormalized.includes("text")
    ) {
      if (
        desiredNormalized.includes("decimal") ||
        desiredNormalized.includes("numeric") ||
        desiredNormalized.includes("integer") ||
        desiredNormalized.includes("int") ||
        desiredNormalized.includes("boolean")
      ) {
        return true;
      }
    }

    // Other conversions that might need USING clause can be added here
    return false;
  }

  private generateUsingExpression(
    columnName: string,
    currentType: string,
    desiredType: string
  ): string {
    const currentNormalized = normalizeType(currentType).toLowerCase();
    const desiredNormalized = normalizeType(desiredType).toLowerCase();

    // For VARCHAR/TEXT to numeric, try to cast the string to the target type
    if (
      currentNormalized.includes("varchar") ||
      currentNormalized.includes("text")
    ) {
      if (
        desiredNormalized.includes("decimal") ||
        desiredNormalized.includes("numeric")
      ) {
        return `${columnName}::${desiredType}`;
      }
      if (
        desiredNormalized.includes("integer") ||
        desiredNormalized.includes("int")
      ) {
        // For string to integer conversion, first convert to numeric to handle decimal strings, then truncate
        return `TRUNC(${columnName}::DECIMAL)::integer`;
      }
      if (desiredNormalized.includes("boolean")) {
        return `${columnName}::boolean`;
      }
    }

    // Default: just cast to the desired type
    return `${columnName}::${desiredType}`;
  }

  private generatePrimaryKeyStatements(
    desiredTable: Table,
    currentTable: Table
  ): string[] {
    const statements: string[] = [];

    const primaryKeyChange = this.comparePrimaryKeys(
      desiredTable.primaryKey,
      currentTable.primaryKey
    );

    if (primaryKeyChange.type === "add") {
      statements.push(
        generateAddPrimaryKeySQL(desiredTable.name, primaryKeyChange.desiredPK!)
      );
    } else if (primaryKeyChange.type === "drop") {
      statements.push(
        generateDropPrimaryKeySQL(
          desiredTable.name,
          primaryKeyChange.currentPK!.name!
        )
      );
    } else if (primaryKeyChange.type === "modify") {
      // Drop old primary key first, then add new one
      statements.push(
        generateDropPrimaryKeySQL(
          desiredTable.name,
          primaryKeyChange.currentPK!.name!
        )
      );
      statements.push(
        generateAddPrimaryKeySQL(desiredTable.name, primaryKeyChange.desiredPK!)
      );
    }

    return statements;
  }

  private comparePrimaryKeys(
    desired: PrimaryKeyConstraint | undefined,
    current: PrimaryKeyConstraint | undefined
  ): {
    type: "add" | "drop" | "modify" | "none";
    currentPK?: PrimaryKeyConstraint;
    desiredPK?: PrimaryKeyConstraint;
  } {
    // No primary key in either - no change
    if (!desired && !current) {
      return { type: "none" };
    }

    // Add primary key (none -> some)
    if (desired && !current) {
      return { type: "add", desiredPK: desired };
    }

    // Drop primary key (some -> none)
    if (!desired && current) {
      return { type: "drop", currentPK: current };
    }

    // Both exist - check if they're different
    if (desired && current) {
      if (this.primaryKeysAreEqual(desired, current)) {
        return { type: "none" };
      } else {
        return { type: "modify", currentPK: current, desiredPK: desired };
      }
    }

    return { type: "none" };
  }

  private primaryKeysAreEqual(
    pk1: PrimaryKeyConstraint,
    pk2: PrimaryKeyConstraint
  ): boolean {
    // Compare column arrays
    if (pk1.columns.length !== pk2.columns.length) {
      return false;
    }

    // Check if all columns are the same in the same order
    for (let i = 0; i < pk1.columns.length; i++) {
      if (pk1.columns[i] !== pk2.columns[i]) {
        return false;
      }
    }

    // Note: We don't compare constraint names because they might be auto-generated
    // The important part is the column composition
    return true;
  }

  private generatePrimaryKeyDropStatements(
    desiredTable: Table,
    currentTable: Table
  ): string[] {
    const statements: string[] = [];

    const primaryKeyChange = this.comparePrimaryKeys(
      desiredTable.primaryKey,
      currentTable.primaryKey
    );

    // Only handle drops and the drop part of modify operations
    if (
      primaryKeyChange.type === "drop" ||
      primaryKeyChange.type === "modify"
    ) {
      statements.push(
        generateDropPrimaryKeySQL(
          desiredTable.name,
          primaryKeyChange.currentPK!.name!
        )
      );
    }

    return statements;
  }

  private generatePrimaryKeyAddStatements(
    desiredTable: Table,
    currentTable: Table
  ): string[] {
    const statements: string[] = [];

    const primaryKeyChange = this.comparePrimaryKeys(
      desiredTable.primaryKey,
      currentTable.primaryKey
    );

    // Only handle adds and the add part of modify operations
    if (primaryKeyChange.type === "add" || primaryKeyChange.type === "modify") {
      statements.push(
        generateAddPrimaryKeySQL(desiredTable.name, primaryKeyChange.desiredPK!)
      );
    }

    return statements;
  }
}
