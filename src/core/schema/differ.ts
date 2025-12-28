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
  getQualifiedTableName,
} from "../../utils/sql";
import { SQLBuilder } from "../../utils/sql-builder";
import { DependencyResolver } from "./dependency-resolver";

/**
 * Represents a single alteration that can be part of a batched ALTER TABLE statement
 */
type TableAlteration =
  | { type: "add_column"; column: Column }
  | { type: "drop_column"; columnName: string }
  | { type: "alter_column_type"; columnName: string; newType: string; usingClause?: string }
  | { type: "alter_column_set_default"; columnName: string; default: string }
  | { type: "alter_column_drop_default"; columnName: string }
  | { type: "alter_column_set_not_null"; columnName: string }
  | { type: "alter_column_drop_not_null"; columnName: string }
  | { type: "add_primary_key"; constraint: PrimaryKeyConstraint }
  | { type: "drop_primary_key"; constraintName: string }
  | { type: "add_check"; constraint: CheckConstraint }
  | { type: "drop_check"; constraintName: string }
  | { type: "add_foreign_key"; constraint: ForeignKeyConstraint }
  | { type: "drop_foreign_key"; constraintName: string }
  | { type: "add_unique"; constraint: UniqueConstraint }
  | { type: "drop_unique"; constraintName: string };

export class SchemaDiffer {
  private options: MigrationOptions;

  constructor(options: MigrationOptions = DEFAULT_MIGRATION_OPTIONS) {
    this.options = { ...DEFAULT_MIGRATION_OPTIONS, ...options };
  }

  /**
   * Helper to check if an index is backed by a constraint.
   * Constraint-backed indexes should be managed via ALTER TABLE ADD/DROP CONSTRAINT
   * rather than CREATE/DROP INDEX for proper batching and PostgreSQL semantics.
   */
  private isConstraintBackedIndex(index: Index): boolean {
    return index.constraint !== undefined;
  }

  generateMigrationPlan(
    desiredSchema: Table[],
    currentSchema: Table[]
  ): MigrationPlan {
    const statements: string[] = [];
    const deferred: string[] = [];

    // Create a map of current tables for easy lookup
    const currentTables = new Map(currentSchema.map((t) => [t.name, t]));
    const desiredTables = new Map(desiredSchema.map((t) => [t.name, t]));

    // Identify new tables and tables to drop
    const newTables = desiredSchema.filter(t => !currentTables.has(t.name));
    const tablesToDrop = currentSchema.filter(t => !desiredTables.has(t.name));

    // Use DependencyResolver to handle circular dependencies for new tables
    let foreignKeysToDefer: Array<{ tableName: string; foreignKey: ForeignKeyConstraint }> = [];
    if (newTables.length > 0) {
      const resolver = new DependencyResolver(newTables);
      const result = resolver.getCreationOrderWithDetachment();
      foreignKeysToDefer = result.foreignKeysToDefer;
    }

    // Create a set of deferred FK keys for quick lookup
    const deferredFKSet = new Set(
      foreignKeysToDefer.map(item => `${item.tableName}:${item.foreignKey.name || item.foreignKey.columns.join(',')}`)
    );

    // Handle new tables
    for (const table of desiredSchema) {
      if (!currentTables.has(table.name)) {
        // Filter out deferred FKs from the table definition
        const filteredTable = {
          ...table,
          foreignKeys: table.foreignKeys?.filter(fk => {
            const key = `${table.name}:${fk.name || fk.columns.join(',')}`;
            return !deferredFKSet.has(key);
          })
        };
        statements.push(generateCreateTableStatement(filteredTable));
      } else {
        // Handle existing tables using batched ALTER TABLE statements
        const currentTable = currentTables.get(table.name)!;

        // Collect all table alterations (columns, constraints, etc.)
        const alterations = this.collectTableAlterations(table, currentTable);

        // Generate a single batched ALTER TABLE statement for all compatible operations
        if (alterations.length > 0) {
          const batchedStatement = this.batchAlterTableChanges(table, alterations);
          if (batchedStatement) {
            statements.push(batchedStatement);
          }
        }

        // Handle index changes separately (they use CONCURRENTLY which can't be batched)
        const indexStatements = this.generateIndexStatements(
          table,
          currentTable
        );
        statements.push(...indexStatements);
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
    // Regular FKs go in statements, deferred FKs go in deferred array
    for (const table of desiredSchema) {
      if (!currentTables.has(table.name)) {
        const qualifiedName = getQualifiedTableName(table);

        if (table.foreignKeys && table.foreignKeys.length > 0) {
          for (const fk of table.foreignKeys) {
            const key = `${table.name}:${fk.name || fk.columns.join(',')}`;
            const fkStatement = generateAddForeignKeySQL(qualifiedName, fk);

            if (deferredFKSet.has(key)) {
              // This FK is involved in a cycle, defer it
              deferred.push(fkStatement);
            } else {
              // Regular FK, add immediately after table creation
              statements.push(fkStatement);
            }
          }
        }

        // Note: Check and unique constraints are already included in CREATE TABLE
        // Only foreign keys need to be added separately
      }
    }

    // Handle dropped tables with circular dependency support
    if (tablesToDrop.length > 0) {
      const dropResolver = new DependencyResolver(tablesToDrop);
      const dropResult = dropResolver.getDeletionOrderWithDetachment();

      // Drop cycle-forming FKs first
      for (const { tableName, foreignKey } of dropResult.foreignKeysToDefer) {
        const table = tablesToDrop.find(t => t.name === tableName);
        if (table && foreignKey.name) {
          // generateDropForeignKeySQL expects unqualified table name
          const dropSQL = new SQLBuilder()
            .p("ALTER TABLE")
            .table(table.name, table.schema)
            .p("DROP CONSTRAINT")
            .ident(foreignKey.name)
            .p(";")
            .build();
          statements.push(dropSQL);
        }
      }

      // Then drop tables in the correct order
      for (const tableName of dropResult.order) {
        const table = tablesToDrop.find(t => t.name === tableName);
        if (table) {
          const sql = new SQLBuilder()
            .p("DROP TABLE")
            .table(table.name, table.schema)
            .p("CASCADE;")
            .build();
          statements.push(sql);
        }
      }
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
      deferred,
      hasChanges: transactional.length > 0 || concurrent.length > 0 || deferred.length > 0,
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

    const qualifiedTableName = getQualifiedTableName(desiredTable);

    // Add new columns
    for (const column of desiredTable.columns) {
      if (!currentColumns.has(column.name)) {
        const builder = new SQLBuilder()
          .p("ALTER TABLE")
          .table(desiredTable.name, desiredTable.schema)
          .p("ADD COLUMN")
          .ident(column.name)
          .p(column.type);

        if (column.generated) {
          builder.p(`GENERATED ${column.generated.always ? 'ALWAYS' : 'BY DEFAULT'} AS (${column.generated.expression}) ${column.generated.stored ? 'STORED' : 'VIRTUAL'}`);
        } else {
          if (!column.nullable) builder.p("NOT NULL");
          if (column.default) builder.p(`DEFAULT ${column.default}`);
        }

        statements.push(builder.p(";").build());
      } else {
        // Check for column modifications
        const currentColumn = currentColumns.get(column.name)!;
        if (columnsAreDifferent(column, currentColumn)) {
          // Handle actual column modifications
          const modificationStatements =
            this.generateColumnModificationStatements(
              qualifiedTableName,
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
          .table(desiredTable.name, desiredTable.schema)
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

    // Special handling for generated columns - they need drop and recreate
    const generatedChanging = (desiredColumn.generated || currentColumn.generated) &&
      (!desiredColumn.generated || !currentColumn.generated ||
       desiredColumn.generated.expression !== currentColumn.generated.expression ||
       desiredColumn.generated.always !== currentColumn.generated.always ||
       desiredColumn.generated.stored !== currentColumn.generated.stored);

    if (generatedChanging) {
      // Drop the column and recreate it
      // Note: tableName is already a qualified name (e.g., "schema.table")
      const dropSql = new SQLBuilder()
        .p("ALTER TABLE")
        .p(tableName)
        .p("DROP COLUMN")
        .ident(desiredColumn.name)
        .p(";")
        .build();
      statements.push(dropSql);

      const addBuilder = new SQLBuilder()
        .p("ALTER TABLE")
        .p(tableName)
        .p("ADD COLUMN")
        .ident(desiredColumn.name)
        .p(desiredColumn.type);

      if (desiredColumn.generated) {
        addBuilder.p(`GENERATED ${desiredColumn.generated.always ? 'ALWAYS' : 'BY DEFAULT'} AS (${desiredColumn.generated.expression}) ${desiredColumn.generated.stored ? 'STORED' : 'VIRTUAL'}`);
      } else {
        if (!desiredColumn.nullable) addBuilder.p("NOT NULL");
        if (desiredColumn.default) addBuilder.p(`DEFAULT ${desiredColumn.default}`);
      }

      statements.push(addBuilder.p(";").build());

      return statements;
    }

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
        .p(tableName) // tableName is already qualified
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
          .p(tableName) // tableName is already qualified
          .p("ALTER COLUMN")
          .ident(desiredColumn.name)
          .p(`SET DEFAULT ${desiredColumn.default};`)
          .build();
        statements.push(sql);
      } else if (!typeIsChanging || !currentColumn.default) {
        // Only drop default if we didn't already drop it in step 1
        const sql = new SQLBuilder()
          .p("ALTER TABLE")
          .p(tableName) // tableName is already qualified
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
          .p(tableName) // tableName is already qualified
          .p("ALTER COLUMN")
          .ident(desiredColumn.name)
          .p("SET NOT NULL;")
          .build();
        statements.push(sql);
      } else {
        const sql = new SQLBuilder()
          .p("ALTER TABLE")
          .p(tableName) // tableName is already qualified
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
        .p(tableName) // tableName is already qualified
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
      .p(tableName) // tableName is already qualified
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
        desiredNormalized.includes("bool")
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
      if (desiredNormalized.includes("bool")) {
        return `TRIM(${columnName})::boolean`;
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
    currentTable: Table,
    qualifiedName: string
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
          qualifiedName,
          primaryKeyChange.currentPK!.name!
        )
      );
    }

    return statements;
  }

  private generatePrimaryKeyAddStatements(
    desiredTable: Table,
    currentTable: Table,
    qualifiedName: string
  ): string[] {
    const statements: string[] = [];

    const primaryKeyChange = this.comparePrimaryKeys(
      desiredTable.primaryKey,
      currentTable.primaryKey
    );

    // Only handle adds and the add part of modify operations
    if (primaryKeyChange.type === "add" || primaryKeyChange.type === "modify") {
      statements.push(
        generateAddPrimaryKeySQL(qualifiedName, primaryKeyChange.desiredPK!)
      );
    }

    return statements;
  }

  /**
   * Generates index-related statements (CREATE/DROP INDEX).
   *
   * IMPORTANT: This handles standalone indexes only, NOT constraint-backed indexes.
   * - Standalone indexes use CREATE INDEX [CONCURRENTLY] for production safety
   * - Constraint-backed indexes are handled via ALTER TABLE in uniqueConstraints
   *
   * This distinction enables:
   * - Concurrent index creation/deletion without blocking writes
   * - Batching constraints with other ALTER TABLE operations
   * - Proper PostgreSQL semantics (constraints vs performance indexes)
   */
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
    const builder = new SQLBuilder();

    builder.p("CREATE");

    if (index.unique) {
      builder.p("UNIQUE");
    }

    builder.p("INDEX");

    const shouldUseConcurrent =
      index.concurrent !== undefined ? index.concurrent : useConcurrent;
    if (shouldUseConcurrent) {
      builder.p("CONCURRENTLY");
    }

    builder.ident(index.name).p("ON").table(index.tableName, index.schema);

    if (index.type && index.type !== "btree") {
      builder.p(`USING ${index.type.toUpperCase()}`);
    }

    if (index.expression) {
      builder.p(`(${index.expression})`);
    } else {
      const quotedColumns = index.columns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");
      builder.p(`(${quotedColumns})`);
    }

    if (index.where) {
      builder.p(`WHERE ${index.where}`);
    }

    if (
      index.storageParameters &&
      Object.keys(index.storageParameters).length > 0
    ) {
      const params = Object.entries(index.storageParameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      builder.p(`WITH (${params})`);
    }

    if (index.tablespace) {
      builder.p(`TABLESPACE ${index.tablespace}`);
    }

    return builder.build() + ";";
  }

  private generateConstraintStatementsWithColumnContext(
    desiredTable: Table,
    currentTable: Table,
    qualifiedName: string
  ): string[] {
    const statements: string[] = [];

    // Identify dropped columns - these will auto-drop dependent constraints
    const currentColumns = new Set(currentTable.columns.map(c => c.name));
    const desiredColumns = new Set(desiredTable.columns.map(c => c.name));
    const droppedColumns = new Set([...currentColumns].filter(col => !desiredColumns.has(col)));

    // Handle check constraints
    const checkStatements = this.generateCheckConstraintStatements(
      qualifiedName,
      desiredTable.checkConstraints || [],
      currentTable.checkConstraints || []
    );
    statements.push(...checkStatements);

    // Handle foreign key constraints (skip those that reference dropped columns)
    const foreignKeyStatements = this.generateForeignKeyStatements(
      qualifiedName,
      desiredTable.foreignKeys || [],
      currentTable.foreignKeys || [],
      droppedColumns
    );
    statements.push(...foreignKeyStatements);

    // Handle unique constraints
    const uniqueStatements = this.generateUniqueConstraintStatements(
      qualifiedName,
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

  /**
   * Generates UNIQUE constraint statements using ALTER TABLE ADD/DROP CONSTRAINT.
   *
   * IMPORTANT: These are true constraints, not standalone unique indexes.
   * - Uses ALTER TABLE ADD CONSTRAINT for proper semantics
   * - Can be batched with other table alterations (see batchAlterTableChanges)
   * - Distinct from unique indexes which use CREATE UNIQUE INDEX CONCURRENTLY
   *
   * The distinction is crucial:
   * - Constraints: data integrity, batched with ALTER TABLE
   * - Indexes: performance optimization, created CONCURRENTLY for production safety
   */
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

  /**
   * Collects all alterations for a table (columns, constraints, etc.)
   * This includes everything that can be batched in a single ALTER TABLE statement.
   */
  private collectTableAlterations(
    desiredTable: Table,
    currentTable: Table
  ): TableAlteration[] {
    const alterations: TableAlteration[] = [];

    // Collect column alterations
    const currentColumns = new Map(currentTable.columns.map((c) => [c.name, c]));
    const desiredColumns = new Map(desiredTable.columns.map((c) => [c.name, c]));

    // Add new columns
    for (const column of desiredTable.columns) {
      if (!currentColumns.has(column.name)) {
        alterations.push({ type: "add_column", column });
      } else {
        // Check for column modifications
        const currentColumn = currentColumns.get(column.name)!;
        if (columnsAreDifferent(column, currentColumn)) {
          this.collectColumnModificationAlterations(column, currentColumn, alterations);
        }
      }
    }

    // Drop removed columns
    for (const column of currentTable.columns) {
      if (!desiredColumns.has(column.name)) {
        alterations.push({ type: "drop_column", columnName: column.name });
      }
    }

    // Collect primary key alterations
    const primaryKeyChange = this.comparePrimaryKeys(
      desiredTable.primaryKey,
      currentTable.primaryKey
    );

    if (primaryKeyChange.type === "drop" || primaryKeyChange.type === "modify") {
      alterations.push({
        type: "drop_primary_key",
        constraintName: primaryKeyChange.currentPK!.name!,
      });
    }

    if (primaryKeyChange.type === "add" || primaryKeyChange.type === "modify") {
      alterations.push({
        type: "add_primary_key",
        constraint: primaryKeyChange.desiredPK!,
      });
    }

    // Collect check constraint alterations
    this.collectCheckConstraintAlterations(
      desiredTable.checkConstraints || [],
      currentTable.checkConstraints || [],
      alterations
    );

    // Collect foreign key constraint alterations
    const currentColumns2 = new Set(currentTable.columns.map(c => c.name));
    const desiredColumns2 = new Set(desiredTable.columns.map(c => c.name));
    const droppedColumns = new Set([...currentColumns2].filter(col => !desiredColumns2.has(col)));

    this.collectForeignKeyAlterations(
      desiredTable.foreignKeys || [],
      currentTable.foreignKeys || [],
      droppedColumns,
      alterations
    );

    // Collect unique constraint alterations
    this.collectUniqueConstraintAlterations(
      desiredTable.uniqueConstraints || [],
      currentTable.uniqueConstraints || [],
      alterations
    );

    return alterations;
  }

  /**
   * Collects alterations for column modifications (type, default, nullable changes)
   */
  private collectColumnModificationAlterations(
    desiredColumn: Column,
    currentColumn: Column,
    alterations: TableAlteration[]
  ): void {
    // Special handling for generated columns - they need drop and recreate
    // We'll still do this as separate statements for now (not batched)
    const generatedChanging = (desiredColumn.generated || currentColumn.generated) &&
      (!desiredColumn.generated || !currentColumn.generated ||
       desiredColumn.generated.expression !== currentColumn.generated.expression ||
       desiredColumn.generated.always !== currentColumn.generated.always ||
       desiredColumn.generated.stored !== currentColumn.generated.stored);

    if (generatedChanging) {
      // Drop and recreate - these can't be batched with other operations
      alterations.push({ type: "drop_column", columnName: desiredColumn.name });
      alterations.push({ type: "add_column", column: desiredColumn });
      return;
    }

    const normalizedDesiredType = normalizeType(desiredColumn.type);
    const normalizedCurrentType = normalizeType(currentColumn.type);
    const typeIsChanging = normalizedDesiredType !== normalizedCurrentType;

    const normalizedCurrentDefault = normalizeDefault(currentColumn.default);
    const normalizedDesiredDefault = normalizeDefault(desiredColumn.default);
    const defaultIsChanging = normalizedDesiredDefault !== normalizedCurrentDefault;

    // If type is changing and there's a current default that might conflict, drop it first
    if (typeIsChanging && currentColumn.default && defaultIsChanging) {
      alterations.push({
        type: "alter_column_drop_default",
        columnName: desiredColumn.name,
      });
    }

    // Change the type if needed
    if (typeIsChanging) {
      const needsUsing = this.requiresUsingClause(currentColumn.type, desiredColumn.type);
      const usingClause = needsUsing
        ? this.generateUsingExpression(desiredColumn.name, currentColumn.type, desiredColumn.type)
        : undefined;

      // Handle SERIAL specially
      const actualType = desiredColumn.type === "SERIAL" ? "INTEGER" : desiredColumn.type;

      alterations.push({
        type: "alter_column_type",
        columnName: desiredColumn.name,
        newType: actualType,
        usingClause,
      });
    }

    // Set the new default if needed
    if (defaultIsChanging) {
      if (desiredColumn.default) {
        alterations.push({
          type: "alter_column_set_default",
          columnName: desiredColumn.name,
          default: desiredColumn.default,
        });
      } else if (!typeIsChanging || !currentColumn.default) {
        // Only drop default if we didn't already drop it
        alterations.push({
          type: "alter_column_drop_default",
          columnName: desiredColumn.name,
        });
      }
    }

    // Handle nullable constraint changes
    if (desiredColumn.nullable !== currentColumn.nullable) {
      if (!desiredColumn.nullable) {
        alterations.push({
          type: "alter_column_set_not_null",
          columnName: desiredColumn.name,
        });
      } else {
        alterations.push({
          type: "alter_column_drop_not_null",
          columnName: desiredColumn.name,
        });
      }
    }
  }

  /**
   * Collects check constraint alterations
   */
  private collectCheckConstraintAlterations(
    desiredConstraints: CheckConstraint[],
    currentConstraints: CheckConstraint[],
    alterations: TableAlteration[]
  ): void {
    const currentMap = new Map(
      currentConstraints.map(c => [c.name || c.expression, c])
    );
    const desiredMap = new Map(
      desiredConstraints.map(c => [c.name || c.expression, c])
    );

    // Drop removed constraints
    for (const [key, constraint] of currentMap) {
      if (!desiredMap.has(key) && constraint.name) {
        alterations.push({
          type: "drop_check",
          constraintName: constraint.name,
        });
      }
    }

    // Add new constraints
    for (const [key, constraint] of desiredMap) {
      if (!currentMap.has(key)) {
        alterations.push({
          type: "add_check",
          constraint,
        });
      } else {
        // Check if expression changed
        const currentConstraint = currentMap.get(key)!;
        if (constraint.expression !== currentConstraint.expression && currentConstraint.name) {
          // Drop and recreate
          alterations.push({
            type: "drop_check",
            constraintName: currentConstraint.name,
          });
          alterations.push({
            type: "add_check",
            constraint,
          });
        }
      }
    }
  }

  /**
   * Collects foreign key constraint alterations
   */
  private collectForeignKeyAlterations(
    desiredConstraints: ForeignKeyConstraint[],
    currentConstraints: ForeignKeyConstraint[],
    droppedColumns: Set<string>,
    alterations: TableAlteration[]
  ): void {
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

    // Drop removed constraints (skip those auto-dropped by column removal)
    for (const [key, constraint] of currentMap) {
      if (!desiredMap.has(key)) {
        const dependsOnDroppedColumn = constraint.columns.some(col => droppedColumns.has(col));
        if (!dependsOnDroppedColumn && constraint.name) {
          alterations.push({
            type: "drop_foreign_key",
            constraintName: constraint.name,
          });
        }
      }
    }

    // Add new constraints or modify existing ones
    for (const [key, constraint] of desiredMap) {
      if (!currentMap.has(key)) {
        alterations.push({
          type: "add_foreign_key",
          constraint,
        });
      } else {
        const currentConstraint = currentMap.get(key)!;
        if (this.foreignKeysDiffer(constraint, currentConstraint) && currentConstraint.name) {
          // Drop and recreate
          alterations.push({
            type: "drop_foreign_key",
            constraintName: currentConstraint.name,
          });
          alterations.push({
            type: "add_foreign_key",
            constraint,
          });
        }
      }
    }
  }

  /**
   * Collects unique constraint alterations
   */
  private collectUniqueConstraintAlterations(
    desiredConstraints: UniqueConstraint[],
    currentConstraints: UniqueConstraint[],
    alterations: TableAlteration[]
  ): void {
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
      if (!desiredMap.has(key) && constraint.name) {
        alterations.push({
          type: "drop_unique",
          constraintName: constraint.name,
        });
      }
    }

    // Add new constraints
    for (const [key, constraint] of desiredMap) {
      if (!currentMap.has(key)) {
        alterations.push({
          type: "add_unique",
          constraint,
        });
      }
    }
  }

  /**
   * Batches multiple ALTER TABLE alterations into a single statement.
   * This improves performance by reducing database round trips.
   *
   * @param tableName - Qualified table name
   * @param alterations - List of alterations to batch
   * @returns SQL statement with batched alterations, or empty string if no alterations
   */
  private batchAlterTableChanges(table: Table, alterations: TableAlteration[]): string {
    if (alterations.length === 0) {
      return "";
    }

    // Sort alterations: drops first, then other operations
    // This prevents dependency issues (e.g., dropping a constraint before dropping a column)
    const sorted = [...alterations].sort((a, b) => {
      const isADrop = a.type.startsWith("drop_");
      const isBDrop = b.type.startsWith("drop_");
      if (isADrop && !isBDrop) return -1;
      if (!isADrop && isBDrop) return 1;
      return 0;
    });

    const builder = new SQLBuilder()
      .p("ALTER TABLE")
      .table(table.name, table.schema);

    builder.indentIn();
    builder.mapComma(sorted, (alt, b) => {
      b.nl();
      switch (alt.type) {
        case "add_column":
          b.p("ADD COLUMN")
            .ident(alt.column.name)
            .p(alt.column.type);
          if (alt.column.generated) {
            b.p(`GENERATED ${alt.column.generated.always ? 'ALWAYS' : 'BY DEFAULT'} AS (${alt.column.generated.expression}) ${alt.column.generated.stored ? 'STORED' : 'VIRTUAL'}`);
          } else {
            if (!alt.column.nullable) b.p("NOT NULL");
            if (alt.column.default) b.p(`DEFAULT ${alt.column.default}`);
          }
          break;

        case "drop_column":
          b.p("DROP COLUMN").ident(alt.columnName);
          break;

        case "alter_column_type":
          b.p("ALTER COLUMN")
            .ident(alt.columnName)
            .p(`TYPE ${alt.newType}`);
          if (alt.usingClause) {
            b.p(`USING ${alt.usingClause}`);
          }
          break;

        case "alter_column_set_default":
          b.p("ALTER COLUMN")
            .ident(alt.columnName)
            .p(`SET DEFAULT ${alt.default}`);
          break;

        case "alter_column_drop_default":
          b.p("ALTER COLUMN")
            .ident(alt.columnName)
            .p("DROP DEFAULT");
          break;

        case "alter_column_set_not_null":
          b.p("ALTER COLUMN")
            .ident(alt.columnName)
            .p("SET NOT NULL");
          break;

        case "alter_column_drop_not_null":
          b.p("ALTER COLUMN")
            .ident(alt.columnName)
            .p("DROP NOT NULL");
          break;

        case "add_primary_key": {
          const constraintName = alt.constraint.name || `pk_${table.name}`;
          const columns = alt.constraint.columns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");
          b.p("ADD CONSTRAINT")
            .ident(constraintName)
            .p(`PRIMARY KEY (${columns})`);
          break;
        }

        case "drop_primary_key":
          b.p("DROP CONSTRAINT").ident(alt.constraintName);
          break;

        case "add_check": {
          const constraintName = alt.constraint.name || `check_${table.name}_${Date.now()}`;
          b.p("ADD CONSTRAINT")
            .ident(constraintName)
            .p(`CHECK (${alt.constraint.expression})`);
          break;
        }

        case "drop_check":
          b.p("DROP CONSTRAINT").ident(alt.constraintName);
          break;

        case "add_foreign_key": {
          const constraintName = alt.constraint.name || `fk_${table.name}_${alt.constraint.referencedTable}`;
          const columns = alt.constraint.columns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");
          const referencedColumns = alt.constraint.referencedColumns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");
          b.p("ADD CONSTRAINT")
            .ident(constraintName)
            .p(`FOREIGN KEY (${columns}) REFERENCES`)
            .table(alt.constraint.referencedTable)
            .p(`(${referencedColumns})`);
          if (alt.constraint.onDelete) {
            b.p(`ON DELETE ${alt.constraint.onDelete}`);
          }
          if (alt.constraint.onUpdate) {
            b.p(`ON UPDATE ${alt.constraint.onUpdate}`);
          }
          break;
        }

        case "drop_foreign_key":
          b.p("DROP CONSTRAINT").ident(alt.constraintName);
          break;

        case "add_unique": {
          const constraintName = alt.constraint.name || `unique_${table.name}_${alt.constraint.columns.join('_')}`;
          const columns = alt.constraint.columns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");
          b.p("ADD CONSTRAINT")
            .ident(constraintName)
            .p(`UNIQUE (${columns})`);
          break;
        }

        case "drop_unique":
          b.p("DROP CONSTRAINT").ident(alt.constraintName);
          break;
      }
    });
    builder.indentOut();

    return builder.p(";").build();
  }
}
