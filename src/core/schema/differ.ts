import type {
  Table,
  Column,
  PrimaryKeyConstraint,
  Index,
  CheckConstraint,
  ForeignKeyConstraint,
  UniqueConstraint,
} from "../../types/schema";
import type { MigrationPlan, MigrationOptions } from "../../types/migration";
import { DEFAULT_MIGRATION_OPTIONS } from "../../types/migration";
import {
  generateCreateTableStatement,
  columnsAreDifferent,
  normalizeType,
  normalizeDefault,
  generateAddPrimaryKeySQL,
  generateDropPrimaryKeySQL,
  generateAddCheckConstraintSQL,
  generateDropCheckConstraintSQL,
  generateAddForeignKeySQL,
  generateDropForeignKeySQL,
  generateAddUniqueConstraintSQL,
  generateDropUniqueConstraintSQL,
} from "../../utils/sql";
import { SQLBuilder } from "../../utils/sql-builder";

export class SchemaDiffer {
  private options: MigrationOptions;

  constructor(options: MigrationOptions = DEFAULT_MIGRATION_OPTIONS) {
    this.options = { ...DEFAULT_MIGRATION_OPTIONS, ...options };
  }

  generateMigrationPlan(
    desiredSchema: Table[],
    currentSchema: Table[]
  ): MigrationPlan {
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

        // 4. Handle index changes for existing tables
        const indexStatements = this.generateIndexStatements(
          table,
          currentTable
        );
        statements.push(...indexStatements);

        // 5. Handle constraint changes (check, foreign key, unique)
        // Note: Skip explicit FK constraint drops if they'll be auto-dropped by column changes
        const constraintStatements = this.generateConstraintStatementsWithColumnContext(
          table,
          currentTable
        );
        statements.push(...constraintStatements);
      }
    }

    // Handle indexes for new tables (created after table creation)
    for (const table of desiredSchema) {
      if (
        !currentTables.has(table.name) &&
        table.indexes &&
        table.indexes.length > 0
      ) {
        const newTableIndexStatements = this.generateIndexCreationStatements(
          table.indexes
        );
        statements.push(...newTableIndexStatements);
      }
    }

    // Handle constraints for new tables (created after table creation)
    for (const table of desiredSchema) {
      if (!currentTables.has(table.name)) {
        // Generate foreign key constraints
        if (table.foreignKeys && table.foreignKeys.length > 0) {
          for (const fk of table.foreignKeys) {
            statements.push(generateAddForeignKeySQL(table.name, fk));
          }
        }
        
        // Note: Check and unique constraints are already included in CREATE TABLE
        // Only foreign keys need to be added separately
      }
    }

    // Handle dropped tables - constraint changes are handled above, just drop tables
    const tablesToDrop = currentSchema.filter(table => !desiredTables.has(table.name));
    for (const table of tablesToDrop) {
      const sql = new SQLBuilder()
        .p("DROP TABLE")
        .table(table.name)
        .p("CASCADE;")
        .build();
      statements.push(sql);
    }

    // Separate statements into transactional and concurrent
    const transactional: string[] = [];
    const concurrent: string[] = [];

    for (const statement of statements) {
      if (statement.includes("CONCURRENTLY")) {
        concurrent.push(statement);
      } else {
        transactional.push(statement);
      }
    }

    return {
      transactional,
      concurrent,
      hasChanges: transactional.length > 0 || concurrent.length > 0,
    };
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
        const builder = new SQLBuilder()
          .p("ALTER TABLE")
          .table(desiredTable.name)
          .p("ADD COLUMN")
          .ident(column.name)
          .p(column.type);

        if (!column.nullable) builder.p("NOT NULL");
        if (column.default) builder.p(`DEFAULT ${column.default}`);

        statements.push(builder.p(";").build());
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
        const sql = new SQLBuilder()
          .p("ALTER TABLE")
          .table(desiredTable.name)
          .p("DROP COLUMN")
          .ident(column.name)
          .p(";")
          .build();
        statements.push(sql);
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

    // Normalize defaults for comparison (strips type casts like ::text, ::character varying)
    const normalizedCurrentDefault = normalizeDefault(currentColumn.default);
    const normalizedDesiredDefault = normalizeDefault(desiredColumn.default);
    const defaultIsChanging = normalizedDesiredDefault !== normalizedCurrentDefault;

    // Step 1: If type is changing and there's a current default that might conflict, drop it first
    if (typeIsChanging && currentColumn.default && defaultIsChanging) {
      const sql = new SQLBuilder()
        .p("ALTER TABLE")
        .table(tableName)
        .p("ALTER COLUMN")
        .ident(desiredColumn.name)
        .p("DROP DEFAULT;")
        .build();
      statements.push(sql);
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
        const sql = new SQLBuilder()
          .p("ALTER TABLE")
          .table(tableName)
          .p("ALTER COLUMN")
          .ident(desiredColumn.name)
          .p(`SET DEFAULT ${desiredColumn.default};`)
          .build();
        statements.push(sql);
      } else if (!typeIsChanging || !currentColumn.default) {
        // Only drop default if we didn't already drop it in step 1
        const sql = new SQLBuilder()
          .p("ALTER TABLE")
          .table(tableName)
          .p("ALTER COLUMN")
          .ident(desiredColumn.name)
          .p("DROP DEFAULT;")
          .build();
        statements.push(sql);
      }
    }

    // Step 4: Handle nullable constraint changes last
    if (desiredColumn.nullable !== currentColumn.nullable) {
      if (!desiredColumn.nullable) {
        const sql = new SQLBuilder()
          .p("ALTER TABLE")
          .table(tableName)
          .p("ALTER COLUMN")
          .ident(desiredColumn.name)
          .p("SET NOT NULL;")
          .build();
        statements.push(sql);
      } else {
        const sql = new SQLBuilder()
          .p("ALTER TABLE")
          .table(tableName)
          .p("ALTER COLUMN")
          .ident(desiredColumn.name)
          .p("DROP NOT NULL;")
          .build();
        statements.push(sql);
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

      const builder = new SQLBuilder()
        .p("ALTER TABLE")
        .table(tableName)
        .p("ALTER COLUMN")
        .ident(columnName)
        .p("TYPE INTEGER");

      if (needsUsing) {
        const usingExpression = this.generateUsingExpression(
          columnName,
          currentType,
          "INTEGER"
        );
        builder.p(`USING ${usingExpression}`);
      }

      return builder.p(";").build();
    }

    // Check if we need a USING clause for type conversion
    const needsUsing = this.requiresUsingClause(currentType, desiredType);

    const builder = new SQLBuilder()
      .p("ALTER TABLE")
      .table(tableName)
      .p("ALTER COLUMN")
      .ident(columnName)
      .p(`TYPE ${desiredType}`);

    if (needsUsing) {
      const usingExpression = this.generateUsingExpression(
        columnName,
        currentType,
        desiredType
      );
      builder.p(`USING ${usingExpression}`);
    }

    return builder.p(";").build();
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

  // Index-related methods
  private generateIndexStatements(
    desiredTable: Table,
    currentTable: Table
  ): string[] {
    const statements: string[] = [];

    const indexComparison = this.compareIndexes(
      desiredTable.indexes || [],
      currentTable.indexes || []
    );

    // Drop removed indexes first
    statements.push(
      ...this.generateIndexDropStatements(indexComparison.toRemove)
    );

    // Create new indexes
    statements.push(
      ...this.generateIndexCreationStatements(indexComparison.toAdd)
    );

    // Handle modified indexes (drop + create)
    statements.push(
      ...this.generateIndexDropStatements(
        indexComparison.toModify.map((mod) => mod.current)
      )
    );
    statements.push(
      ...this.generateIndexCreationStatements(
        indexComparison.toModify.map((mod) => mod.desired)
      )
    );

    return statements;
  }

  private compareIndexes(
    desiredIndexes: Index[],
    currentIndexes: Index[]
  ): {
    toAdd: Index[];
    toRemove: Index[];
    toModify: { current: Index; desired: Index }[];
  } {
    const currentIndexMap = new Map(
      currentIndexes.map((idx) => [idx.name, idx])
    );
    const desiredIndexMap = new Map(
      desiredIndexes.map((idx) => [idx.name, idx])
    );

    const toAdd: Index[] = [];
    const toRemove: Index[] = [];
    const toModify: { current: Index; desired: Index }[] = [];

    // Find new indexes to add
    for (const desiredIndex of desiredIndexes) {
      if (!currentIndexMap.has(desiredIndex.name)) {
        toAdd.push(desiredIndex);
      } else {
        // Check if existing index needs modification
        const currentIndex = currentIndexMap.get(desiredIndex.name)!;
        if (!this.indexesAreEqual(desiredIndex, currentIndex)) {
          toModify.push({ current: currentIndex, desired: desiredIndex });
        }
      }
    }

    // Find indexes to remove
    for (const currentIndex of currentIndexes) {
      if (!desiredIndexMap.has(currentIndex.name)) {
        toRemove.push(currentIndex);
      }
    }

    return { toAdd, toRemove, toModify };
  }

  private indexesAreEqual(index1: Index, index2: Index): boolean {
    // Compare all relevant properties
    if (index1.tableName !== index2.tableName) return false;
    if (index1.type !== index2.type) return false;
    if (index1.unique !== index2.unique) return false;

    // Compare columns (order matters)
    if (index1.columns.length !== index2.columns.length) return false;
    for (let i = 0; i < index1.columns.length; i++) {
      if (index1.columns[i] !== index2.columns[i]) return false;
    }

    // Compare optional properties
    if (index1.where !== index2.where) return false;
    if (index1.expression !== index2.expression) return false;
    if (index1.tablespace !== index2.tablespace) return false;

    // Compare storage parameters
    const params1 = index1.storageParameters || {};
    const params2 = index2.storageParameters || {};
    const keys1 = Object.keys(params1);
    const keys2 = Object.keys(params2);

    if (keys1.length !== keys2.length) return false;
    for (const key of keys1) {
      if (params1[key] !== params2[key]) return false;
    }

    return true;
  }

  private generateIndexCreationStatements(indexes: Index[]): string[] {
    return indexes.map((index) =>
      this.generateCreateIndexSQL(
        index,
        this.options.useConcurrentIndexes ?? true
      )
    );
  }

  private generateIndexDropStatements(indexes: Index[]): string[] {
    const concurrent = this.options.useConcurrentDrops ?? true;
    return indexes.map((index) => {
      const builder = new SQLBuilder();
      if (concurrent) {
        builder.p("DROP INDEX CONCURRENTLY");
      } else {
        builder.p("DROP INDEX");
      }
      return builder.ident(index.name).p(";").build();
    });
  }

  private generateCreateIndexSQL(
    index: Index,
    useConcurrent: boolean = true
  ): string {
    let sql = "CREATE";

    // Add UNIQUE if specified
    if (index.unique) {
      sql += " UNIQUE";
    }

    sql += " INDEX";

    // Add CONCURRENTLY for production safety (default: true)
    // Can be overridden by explicit index.concurrent setting or global useConcurrent parameter
    const shouldUseConcurrent =
      index.concurrent !== undefined ? index.concurrent : useConcurrent;
    if (shouldUseConcurrent) {
      sql += " CONCURRENTLY";
    }

    sql += ` ${index.name} ON ${index.tableName}`;

    // Add USING clause if not default btree
    if (index.type && index.type !== "btree") {
      sql += ` USING ${index.type.toUpperCase()}`;
    }

    // Add columns or expression
    if (index.expression) {
      sql += ` (${index.expression})`;
    } else {
      sql += ` (${index.columns.join(", ")})`;
    }

    // Add WHERE clause for partial indexes
    if (index.where) {
      sql += ` WHERE ${index.where}`;
    }

    // Add storage parameters
    if (
      index.storageParameters &&
      Object.keys(index.storageParameters).length > 0
    ) {
      const params = Object.entries(index.storageParameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      sql += ` WITH (${params})`;
    }

    // Add tablespace
    if (index.tablespace) {
      sql += ` TABLESPACE ${index.tablespace}`;
    }

    return sql + ";";
  }

  private generateConstraintStatementsWithColumnContext(
    desiredTable: Table,
    currentTable: Table
  ): string[] {
    const statements: string[] = [];

    // Identify dropped columns - these will auto-drop dependent constraints
    const currentColumns = new Set(currentTable.columns.map(c => c.name));
    const desiredColumns = new Set(desiredTable.columns.map(c => c.name));
    const droppedColumns = new Set([...currentColumns].filter(col => !desiredColumns.has(col)));

    // Handle check constraints
    const checkStatements = this.generateCheckConstraintStatements(
      desiredTable.name,
      desiredTable.checkConstraints || [],
      currentTable.checkConstraints || []
    );
    statements.push(...checkStatements);

    // Handle foreign key constraints (skip those that reference dropped columns)
    const foreignKeyStatements = this.generateForeignKeyStatements(
      desiredTable.name,
      desiredTable.foreignKeys || [],
      currentTable.foreignKeys || [],
      droppedColumns
    );
    statements.push(...foreignKeyStatements);

    // Handle unique constraints
    const uniqueStatements = this.generateUniqueConstraintStatements(
      desiredTable.name,
      desiredTable.uniqueConstraints || [],
      currentTable.uniqueConstraints || []
    );
    statements.push(...uniqueStatements);

    return statements;
  }

  private generateCheckConstraintStatements(
    tableName: string,
    desiredConstraints: CheckConstraint[],
    currentConstraints: CheckConstraint[]
  ): string[] {
    const statements: string[] = [];

    // Create maps for easier comparison
    const currentMap = new Map(
      currentConstraints.map(c => [c.name || c.expression, c])
    );
    const desiredMap = new Map(
      desiredConstraints.map(c => [c.name || c.expression, c])
    );

    // Drop removed constraints
    for (const [key, constraint] of currentMap) {
      if (!desiredMap.has(key)) {
        if (constraint.name) {
          statements.push(generateDropCheckConstraintSQL(tableName, constraint.name));
        }
      }
    }

    // Add new constraints
    for (const [key, constraint] of desiredMap) {
      if (!currentMap.has(key)) {
        statements.push(generateAddCheckConstraintSQL(tableName, constraint));
      } else {
        // Check if the constraint has changed (expression is different)
        const currentConstraint = currentMap.get(key)!;
        if (constraint.expression !== currentConstraint.expression) {
          // Drop and recreate
          if (currentConstraint.name) {
            statements.push(generateDropCheckConstraintSQL(tableName, currentConstraint.name));
          }
          statements.push(generateAddCheckConstraintSQL(tableName, constraint));
        }
      }
    }

    return statements;
  }

  private generateForeignKeyStatements(
    tableName: string,
    desiredConstraints: ForeignKeyConstraint[],
    currentConstraints: ForeignKeyConstraint[],
    droppedColumns: Set<string> = new Set()
  ): string[] {
    const statements: string[] = [];

    // Create maps for easier comparison
    const currentMap = new Map(
      currentConstraints.map(c => [
        c.name || `fk_${c.columns.join('_')}_${c.referencedTable}`,
        c
      ])
    );
    const desiredMap = new Map(
      desiredConstraints.map(c => [
        c.name || `fk_${c.columns.join('_')}_${c.referencedTable}`,
        c
      ])
    );

    // Drop removed constraints (but skip those that will be auto-dropped by column removal)
    for (const [key, constraint] of currentMap) {
      if (!desiredMap.has(key)) {
        // Check if this constraint depends on columns being dropped
        const dependsOnDroppedColumn = constraint.columns.some(col => droppedColumns.has(col));
        
        if (!dependsOnDroppedColumn && constraint.name) {
          // Only explicitly drop if it won't be auto-dropped by column removal
          statements.push(generateDropForeignKeySQL(tableName, constraint.name));
        }
      }
    }

    // Add new constraints or modify existing ones
    for (const [key, constraint] of desiredMap) {
      if (!currentMap.has(key)) {
        statements.push(generateAddForeignKeySQL(tableName, constraint));
      } else {
        // Check if the constraint has changed
        const currentConstraint = currentMap.get(key)!;
        if (this.foreignKeysDiffer(constraint, currentConstraint)) {
          // Drop and recreate to modify
          if (currentConstraint.name) {
            statements.push(generateDropForeignKeySQL(tableName, currentConstraint.name));
          }
          statements.push(generateAddForeignKeySQL(tableName, constraint));
        }
      }
    }

    return statements;
  }

  private foreignKeysDiffer(a: ForeignKeyConstraint, b: ForeignKeyConstraint): boolean {
    // Check if columns differ
    if (a.columns.length !== b.columns.length ||
        !a.columns.every((col, i) => col === b.columns[i])) {
      return true;
    }

    // Check if referenced columns differ
    if (a.referencedColumns.length !== b.referencedColumns.length ||
        !a.referencedColumns.every((col, i) => col === b.referencedColumns[i])) {
      return true;
    }

    // Check if referenced table differs
    if (a.referencedTable !== b.referencedTable) {
      return true;
    }

    // Check if action clauses differ
    if (a.onDelete !== b.onDelete || a.onUpdate !== b.onUpdate) {
      return true;
    }

    // Check if deferrable settings differ
    if (a.deferrable !== b.deferrable || a.initiallyDeferred !== b.initiallyDeferred) {
      return true;
    }

    return false;
  }

  private generateUniqueConstraintStatements(
    tableName: string,
    desiredConstraints: UniqueConstraint[],
    currentConstraints: UniqueConstraint[]
  ): string[] {
    const statements: string[] = [];

    // Create maps for easier comparison
    const currentMap = new Map(
      currentConstraints.map(c => [
        c.name || `unique_${c.columns.join('_')}`,
        c
      ])
    );
    const desiredMap = new Map(
      desiredConstraints.map(c => [
        c.name || `unique_${c.columns.join('_')}`,
        c
      ])
    );

    // Drop removed constraints
    for (const [key, constraint] of currentMap) {
      if (!desiredMap.has(key)) {
        if (constraint.name) {
          statements.push(generateDropUniqueConstraintSQL(tableName, constraint.name));
        }
      }
    }

    // Add new constraints
    for (const [key, constraint] of desiredMap) {
      if (!currentMap.has(key)) {
        statements.push(generateAddUniqueConstraintSQL(tableName, constraint));
      }
    }

    return statements;
  }
}
