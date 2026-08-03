import type {
  Table,
  Column,
  PrimaryKeyConstraint,
  Index,
  CheckConstraint,
  ForeignKeyConstraint,
  UniqueConstraint,
  ExclusionConstraint,
  IdentityColumn,
  QualifiedName,
  ColumnStorage,
} from "../../types/schema";
import type {
  MigrationContext,
  MigrationPlan,
  MigrationOptions,
} from "../../types/migration";
import { DEFAULT_MIGRATION_OPTIONS } from "../../types/migration";
import { ValidationError } from "../../types/errors";
import {
  generateCreateTableStatement,
  columnsAreDifferent,
  normalizeType,
  normalizeDefault,
  normalizeExpression,
  generateAddPrimaryKeySQL,
  generateDropPrimaryKeySQL,
  generateAddCheckConstraintSQL,
  generateDropCheckConstraintSQL,
  generateAddForeignKeySQL,
  generateDropForeignKeySQL,
  generateAddUniqueConstraintSQL,
  generateDropUniqueConstraintSQL,
  generateUniqueConstraintClause,
  getQualifiedTableName,
  getForeignKeyConstraintName,
  splitSchemaTable,
  getBareTableName,
  generateColumnDefinition,
  generateExclusionConstraintClause,
} from "../../utils/sql";
import { expressionsEqual } from "../../utils/expression-comparator";
import { SQLBuilder } from "../../utils/sql-builder";
import {
  getIdentityOptionChanges,
  identitySequenceNamesDiffer,
  renderIdentityClause,
} from "../../utils/identity";
import {
  collationsAreDifferent,
  getAlterColumnCollation,
  renderCollationName,
} from "../../utils/collation";
import { getColumnPhysicalChanges } from "../../utils/column-physical";
import { renderStorageParameterAssignments } from "../../utils/storage-parameters";
import { DependencyResolver } from "./dependency-resolver";

function normalizeReferencedTableName(referencedTable: string): string {
  const [name, schema] = splitSchemaTable(referencedTable);
  return `${schema || "public"}.${name}`;
}

function findOuterClosingParenthesis(value: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "(") depth++;
    if (character === ")") depth--;
    if (depth === 0) return index;
  }
  return -1;
}

function stripBalancedOuterParentheses(value: string): string {
  let normalized = value.trim();
  while (
    normalized.startsWith("(") &&
    normalized.endsWith(")") &&
    findOuterClosingParenthesis(normalized) === normalized.length - 1
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function exclusionElementDefinitionsEqual(
  desired: string,
  current: string
): boolean {
  const normalize = function normalizeDefinition(value: string): string {
    return stripBalancedOuterParentheses(
      value.replace(/\bpg_catalog\./gi, "").replace(/\s+/g, " ").trim()
    );
  };
  const normalizedDesired = normalize(desired);
  const normalizedCurrent = normalize(current);
  return (
    normalizedDesired === normalizedCurrent ||
    expressionsEqual(normalizedDesired, normalizedCurrent)
  );
}

function stringArraysEqual(
  desired: string[] | undefined,
  current: string[] | undefined
): boolean {
  const desiredValues = desired || [];
  const currentValues = current || [];
  return (
    desiredValues.length === currentValues.length &&
    desiredValues.every(function hasSameValue(value, index) {
      return currentValues[index] === value;
    })
  );
}

function getIndexKeyCount(index: Index): number {
  return index.expression ? 1 : index.columns.length;
}

function getIndexSortOrder(index: Index, position: number): 'ASC' | 'DESC' {
  return index.sortOrders?.[position] || 'ASC';
}

function getDefaultNullsOrder(sortOrder: 'ASC' | 'DESC'): 'FIRST' | 'LAST' {
  return sortOrder === 'DESC' ? 'FIRST' : 'LAST';
}

function getEffectiveNullsOrder(
  index: Index,
  position: number
): 'FIRST' | 'LAST' {
  return (
    index.nullsOrders?.[position] ||
    getDefaultNullsOrder(getIndexSortOrder(index, position))
  );
}

function indexNullsOrdersEqual(first: Index, second: Index): boolean {
  const keyCount = Math.max(getIndexKeyCount(first), getIndexKeyCount(second));
  for (let position = 0; position < keyCount; position++) {
    if (
      getEffectiveNullsOrder(first, position) !==
      getEffectiveNullsOrder(second, position)
    ) {
      return false;
    }
  }
  return true;
}

function getNonDefaultNullsOrder(
  index: Index,
  position: number
): 'FIRST' | 'LAST' | undefined {
  const defaultOrder = getDefaultNullsOrder(getIndexSortOrder(index, position));
  const nullsOrder = index.nullsOrders?.[position] || defaultOrder;
  return nullsOrder === defaultOrder ? undefined : nullsOrder;
}

function stringRecordsEqual(
  desired: Record<string, string> | undefined,
  current: Record<string, string> | undefined
): boolean {
  const desiredEntries = Object.entries(desired || {}).sort();
  const currentEntries = Object.entries(current || {}).sort();
  return (
    desiredEntries.length === currentEntries.length &&
    desiredEntries.every(function hasSameEntry(entry, index) {
      return (
        currentEntries[index]?.[0] === entry[0] &&
        currentEntries[index]?.[1] === entry[1]
      );
    })
  );
}

function normalizeExclusionOperatorSchema(
  schema: string | undefined
): string | undefined {
  return schema === "pg_catalog" ? undefined : schema;
}

function exclusionConstraintsDiffer(
  desired: ExclusionConstraint,
  current: ExclusionConstraint
): boolean {
  if (
    (desired.method || "btree").toLowerCase() !==
    (current.method || "btree").toLowerCase()
  ) {
    return true;
  }
  if (desired.elements.length !== current.elements.length) return true;

  for (let index = 0; index < desired.elements.length; index++) {
    const desiredElement = desired.elements[index]!;
    const currentElement = current.elements[index]!;
    if (
      !exclusionElementDefinitionsEqual(
        desiredElement.definition,
        currentElement.definition
      )
    ) {
      return true;
    }
    if (desiredElement.operator.name !== currentElement.operator.name) return true;

    const desiredSchema = normalizeExclusionOperatorSchema(
      desiredElement.operator.schema
    );
    const currentSchema = normalizeExclusionOperatorSchema(
      currentElement.operator.schema
    );
    if (desiredSchema && desiredSchema !== currentSchema) {
      return true;
    }
  }

  if (!stringArraysEqual(desired.include, current.include)) return true;
  if (!stringRecordsEqual(desired.storageParameters, current.storageParameters)) {
    return true;
  }
  if ((desired.tablespace || "pg_default") !== (current.tablespace || "pg_default")) {
    return true;
  }
  if (Boolean(desired.deferrable) !== Boolean(current.deferrable)) return true;
  if (Boolean(desired.initiallyDeferred) !== Boolean(current.initiallyDeferred)) {
    return true;
  }

  if (desired.where && current.where) {
    return !expressionsEqual(desired.where, current.where);
  }
  return desired.where !== current.where;
}

/**
 * Represents a single alteration that can be part of a batched ALTER TABLE statement
 */
type TableAlteration =
  | {
      type: "set_table_storage_parameters";
      parameters: Record<string, string>;
    }
  | { type: "reset_table_storage_parameters"; parameters: string[] }
  | { type: "inherit_parent"; parent: QualifiedName }
  | { type: "no_inherit_parent"; parent: QualifiedName }
  | { type: "set_table_access_method"; accessMethod: string }
  | { type: "set_table_tablespace"; tablespace: string }
  | { type: "add_column"; column: Column }
  | { type: "drop_column"; columnName: string }
  | {
      type: "alter_column_type";
      columnName: string;
      newType: string;
      collation?: QualifiedName;
      usingClause?: string;
    }
  | { type: "alter_column_set_default"; columnName: string; default: string }
  | { type: "alter_column_drop_default"; columnName: string }
  | { type: "alter_column_set_not_null"; columnName: string }
  | { type: "alter_column_drop_not_null"; columnName: string }
  | {
      type: "alter_column_set_storage";
      columnName: string;
      storage: ColumnStorage | 'DEFAULT';
    }
  | {
      type: "alter_column_set_compression";
      columnName: string;
      compression: string;
    }
  | {
      type: "alter_column_add_identity";
      columnName: string;
      identity: IdentityColumn;
    }
  | { type: "alter_column_drop_identity"; columnName: string }
  | {
      type: "alter_column_set_identity_generation";
      columnName: string;
      generation: IdentityColumn['generation'];
    }
  | {
      type: "alter_column_set_identity_option";
      columnName: string;
      clause: string;
      order: number;
    }
  | { type: "add_primary_key"; constraint: PrimaryKeyConstraint }
  | { type: "drop_primary_key"; constraintName: string }
  | { type: "add_check"; constraint: CheckConstraint }
  | { type: "drop_check"; constraintName: string }
  | { type: "add_foreign_key"; constraint: ForeignKeyConstraint }
  | { type: "drop_foreign_key"; constraintName: string }
  | { type: "add_unique"; constraint: UniqueConstraint }
  | { type: "drop_unique"; constraintName: string }
  | { type: "add_exclusion"; constraint: ExclusionConstraint }
  | { type: "drop_exclusion"; constraintName: string };

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
    currentSchema: Table[],
    context: MigrationContext = {}
  ): MigrationPlan {
    this.validateNullsNotDistinctSupport(desiredSchema, context);
    const statements: string[] = [];
    const deferred: string[] = [];
    const orderedDesiredSchema = this.getDeterministicTableOrder(desiredSchema);
    const orderedCurrentSchema = this.getDeterministicTableOrder(currentSchema);

    const currentTables = new Map(
      orderedCurrentSchema.map((table) => [this.getTableKey(table), table])
    );
    const desiredTables = new Map(
      orderedDesiredSchema.map((table) => [this.getTableKey(table), table])
    );

    const newTables = orderedDesiredSchema.filter(
      (table) => !currentTables.has(this.getTableKey(table))
    );
    const tablesToDrop = orderedCurrentSchema.filter(
      (table) => !desiredTables.has(this.getTableKey(table))
    );

    // Use DependencyResolver to handle circular dependencies for new tables
    let orderedNewTables = newTables;
    let foreignKeysToDefer: Array<{ tableName: string; foreignKey: ForeignKeyConstraint }> = [];
    if (newTables.length > 0) {
      const resolverTables = this.createResolverInputTables(newTables);
      const resolver = new DependencyResolver(resolverTables);
      const result = resolver.getCreationOrderWithDetachment();
      foreignKeysToDefer = result.foreignKeysToDefer;
      const newTablesByKey = new Map(
        newTables.map((table) => [this.getTableKey(table), table])
      );
      orderedNewTables = result.order.map(function getTable(tableKey) {
        return newTablesByKey.get(tableKey)!;
      });
    }

    // Create a set of deferred FK keys for quick lookup
    const deferredFKSet = new Set(
      foreignKeysToDefer.map(item => `${item.tableName}:${item.foreignKey.name || item.foreignKey.columns.join(',')}`)
    );

    // Handle new tables
    const existingTables = orderedDesiredSchema.filter((table) =>
      currentTables.has(this.getTableKey(table))
    );
    for (const table of [...orderedNewTables, ...existingTables]) {
      const tableKey = this.getTableKey(table);
      if (!currentTables.has(tableKey)) {
        // Filter out deferred FKs from the table definition
        const filteredTable = {
          ...table,
          foreignKeys: table.foreignKeys?.filter(fk => {
            const key = `${tableKey}:${fk.name || fk.columns.join(',')}`;
            return !deferredFKSet.has(key);
          })
        };
        statements.push(generateCreateTableStatement(filteredTable));

        const physicalAlterations: TableAlteration[] = [];
        for (const column of filteredTable.columns) {
          this.collectColumnPhysicalAlterations(
            column,
            undefined,
            false,
            physicalAlterations
          );
        }
        if (physicalAlterations.length > 0) {
          statements.push(
            this.batchAlterTableChanges(filteredTable, physicalAlterations)
          );
        }
      } else {
        // Handle existing tables using batched ALTER TABLE statements
        const currentTable = currentTables.get(tableKey)!;

        statements.push(
          ...this.generateIdentitySequenceRenameStatements(table, currentTable)
        );

        // Collect all table alterations (columns, constraints, etc.)
        const alterations = this.collectTableAlterations(
          table,
          currentTable,
          context
        );

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
    for (const table of orderedDesiredSchema) {
      if (
        !currentTables.has(this.getTableKey(table)) &&
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
    for (const table of orderedDesiredSchema) {
      const tableKey = this.getTableKey(table);
      if (!currentTables.has(tableKey)) {
        const qualifiedName = getQualifiedTableName(table);

        if (table.foreignKeys && table.foreignKeys.length > 0) {
          for (const fk of table.foreignKeys) {
            const key = `${tableKey}:${fk.name || fk.columns.join(',')}`;
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
      const dropResolverTables = this.createResolverInputTables(tablesToDrop);
      const dropResolver = new DependencyResolver(dropResolverTables);
      const dropResult = dropResolver.getDeletionOrderWithDetachment();
      const tablesToDropByKey = new Map(
        tablesToDrop.map((table) => [this.getTableKey(table), table])
      );

      // Drop cycle-forming FKs first
      for (const { tableName, foreignKey } of dropResult.foreignKeysToDefer) {
        const table = tablesToDropByKey.get(tableName);
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
        const table = tablesToDropByKey.get(tableName);
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

    statements.push(
      ...this.generateTablePersistenceStatements(
        orderedDesiredSchema,
        currentTables
      )
    );

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

  private validateNullsNotDistinctSupport(
    desiredSchema: Table[],
    context: MigrationContext
  ): void {
    const invalidIndexTable = desiredSchema.find(
      function hasNonUniqueNullsNotDistinct(candidate) {
        return candidate.indexes?.some(function hasInvalidIndex(index) {
          return index.nullsNotDistinct && !index.unique;
        });
      }
    );
    if (invalidIndexTable) {
      const tableName = getQualifiedTableName(invalidIndexTable);
      throw new ValidationError(
        `NULLS NOT DISTINCT requires a UNIQUE index on ${tableName}`,
        tableName,
        "nullsNotDistinct",
        true
      );
    }

    const table = desiredSchema.find(function usesNullsNotDistinct(candidate) {
      return (
        candidate.uniqueConstraints?.some(function hasConstraint(constraint) {
          return constraint.nullsNotDistinct;
        }) ||
        candidate.indexes?.some(function hasIndex(index) {
          return index.nullsNotDistinct;
        })
      );
    });
    if (!table) return;

    const tableName = getQualifiedTableName(table);
    if (context.postgresVersionNum === undefined) {
      throw new ValidationError(
        `Cannot safely use NULLS NOT DISTINCT on ${tableName} without the PostgreSQL server version`,
        tableName,
        "nullsNotDistinct",
        true
      );
    }
    if (context.postgresVersionNum < 150000) {
      const serverMajor = Math.floor(context.postgresVersionNum / 10000);
      throw new ValidationError(
        `PostgreSQL ${serverMajor} does not support NULLS NOT DISTINCT; PostgreSQL 15 or newer is required`,
        tableName,
        "nullsNotDistinct",
        true
      );
    }
  }

  private getTableKey(table: Pick<Table, "name" | "schema">): string {
    return `${table.schema || "public"}.${table.name}`;
  }

  private getDeterministicTableOrder(tables: Table[]): Table[] {
    return [...tables].sort((a, b) => this.getTableKey(a).localeCompare(this.getTableKey(b)));
  }

  private generateTablePersistenceStatements(
    desiredTables: Table[],
    currentTables: Map<string, Table>
  ): string[] {
    const transitions = desiredTables.filter((table) => {
      const current = currentTables.get(this.getTableKey(table));
      return Boolean(
        current && Boolean(table.unlogged) !== Boolean(current.unlogged)
      );
    });
    const toLogged = transitions.filter((table) => !table.unlogged);
    const toUnlogged = transitions.filter((table) => table.unlogged);

    return [
      ...this.generateTablePersistenceGroup(toLogged, currentTables, false),
      ...this.generateTablePersistenceGroup(toUnlogged, currentTables, true),
    ];
  }

  private generateTablePersistenceGroup(
    desiredTables: Table[],
    currentTables: Map<string, Table>,
    unlogged: boolean
  ): string[] {
    if (desiredTables.length === 0) return [];

    const tablesByKey = new Map(
      desiredTables.map((table) => [this.getTableKey(table), table])
    );
    const resolver = new DependencyResolver(
      this.createResolverInputTables(desiredTables)
    );
    const result = unlogged
      ? resolver.getDeletionOrderWithDetachment()
      : resolver.getCreationOrderWithDetachment();
    const droppedForeignKeys: string[] = [];
    const restoredForeignKeys: string[] = [];

    const detachedForeignKeys = [...result.foreignKeysToDefer].sort((a, b) => {
      const aKey = `${a.tableName}:${a.foreignKey.name || a.foreignKey.columns.join(",")}`;
      const bKey = `${b.tableName}:${b.foreignKey.name || b.foreignKey.columns.join(",")}`;
      return aKey.localeCompare(bKey);
    });
    for (const detached of detachedForeignKeys) {
      const desiredTable = tablesByKey.get(detached.tableName);
      const currentTable = currentTables.get(detached.tableName);
      if (!desiredTable || !currentTable) continue;

      const desiredForeignKey = (desiredTable.foreignKeys || []).find(
        (foreignKey) =>
          this.foreignKeysMatchForPersistence(
            foreignKey,
            detached.foreignKey
          )
      );
      if (!desiredForeignKey) continue;

      const currentForeignKey = (currentTable.foreignKeys || []).find(
        (foreignKey) =>
          this.foreignKeysMatchForPersistence(desiredForeignKey, foreignKey)
      );
      if (!currentForeignKey?.name) continue;

      const tableName = this.getTableKey(desiredTable);
      droppedForeignKeys.push(
        generateDropForeignKeySQL(tableName, currentForeignKey.name)
      );
      restoredForeignKeys.push(
        generateAddForeignKeySQL(tableName, desiredForeignKey)
      );
    }

    const persistenceStatements = result.order.map((tableKey) => {
      const table = tablesByKey.get(tableKey)!;
      return new SQLBuilder()
        .p("ALTER TABLE")
        .table(table.name, table.schema)
        .p(unlogged ? "SET UNLOGGED;" : "SET LOGGED;")
        .build();
    });

    return [
      ...droppedForeignKeys,
      ...persistenceStatements,
      ...restoredForeignKeys,
    ];
  }

  private foreignKeysMatchForPersistence(
    first: ForeignKeyConstraint,
    second: ForeignKeyConstraint
  ): boolean {
    return !this.foreignKeysDiffer(first, second);
  }

  private createResolverInputTables(tables: Table[]): Table[] {
    const tableKeys = new Set(tables.map((table) => this.getTableKey(table)));
    const keysByName = new Map<string, string[]>();

    for (const table of tables) {
      const key = this.getTableKey(table);
      const matches = keysByName.get(table.name) || [];
      matches.push(key);
      keysByName.set(table.name, matches);
    }

    return tables.map((table) => {
      const resolverName = this.getTableKey(table);
      const foreignKeys = (table.foreignKeys || []).map((foreignKey) => {
        const referencedTable = this.resolveResolverReferencedTableKey(
          foreignKey.referencedTable,
          table.schema,
          tableKeys,
          keysByName
        );
        if (!referencedTable) {
          return foreignKey;
        }
        return { ...foreignKey, referencedTable };
      });
      const differ = this;
      const inherits = (table.inherits || []).map(function mapParent(parent) {
        const parentKey = differ.resolveResolverReferencedTableKey(
          parent.schema ? `${parent.schema}.${parent.name}` : parent.name,
          table.schema,
          tableKeys,
          keysByName
        );
        return parentKey ? { name: parentKey } : parent;
      });

      return {
        ...table,
        name: resolverName,
        schema: undefined,
        foreignKeys,
        inherits,
      };
    });
  }

  private resolveResolverReferencedTableKey(
    referencedTable: string,
    currentSchema: string | undefined,
    tableKeys: Set<string>,
    keysByName: Map<string, string[]>
  ): string | undefined {
    const [referencedName, referencedSchema] = splitSchemaTable(referencedTable);

    if (referencedSchema) {
      const directKey = `${referencedSchema}.${referencedName}`;
      return tableKeys.has(directKey) ? directKey : undefined;
    }

    const schemaKey = `${currentSchema || "public"}.${referencedName}`;
    if (tableKeys.has(schemaKey)) {
      return schemaKey;
    }

    const matches = keysByName.get(referencedName) || [];
    if (matches.length === 1) {
      return matches[0];
    }

    return undefined;
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
          .table(desiredTable.name, desiredTable.schema)
          .p("ADD COLUMN")
          .p(generateColumnDefinition(column));

        statements.push(builder.p(";").build());
        const physicalAlterations: TableAlteration[] = [];
        this.collectColumnPhysicalAlterations(
          column,
          undefined,
          false,
          physicalAlterations
        );
        if (physicalAlterations.length > 0) {
          statements.push(
            this.batchAlterTableChanges(desiredTable, physicalAlterations)
          );
        }
      } else {
        // Check for column modifications
        const currentColumn = currentColumns.get(column.name)!;
        if (columnsAreDifferent(column, currentColumn)) {
          // Handle actual column modifications
          const modificationStatements =
            this.generateColumnModificationStatements(
              desiredTable,
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
    table: Table,
    desiredColumn: Column,
    currentColumn: Column
  ): string[] {
    const statements: string[] = [];
    const tableName = getQualifiedTableName(table);

    // Special handling for generated columns - they need drop and recreate
    const generatedChanging = (desiredColumn.generated || currentColumn.generated) &&
      (!desiredColumn.generated || !currentColumn.generated ||
       !expressionsEqual(desiredColumn.generated.expression, currentColumn.generated.expression) ||
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
        .p(generateColumnDefinition(desiredColumn));

      statements.push(addBuilder.p(";").build());

      const physicalAlterations: TableAlteration[] = [];
      this.collectColumnPhysicalAlterations(
        desiredColumn,
        undefined,
        false,
        physicalAlterations
      );
      if (physicalAlterations.length > 0) {
        statements.push(
          this.batchAlterTableChanges(table, physicalAlterations)
        );
      }

      return statements;
    }

    const normalizedDesiredType = normalizeType(desiredColumn.type);
    const normalizedCurrentType = normalizeType(currentColumn.type);
    const typeIsChanging = normalizedDesiredType !== normalizedCurrentType;
    const collationIsChanging = collationsAreDifferent(
      desiredColumn.collation,
      currentColumn.collation
    );

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

    // Step 2: Change the type or collation if needed
    if (typeIsChanging || collationIsChanging) {
      const collation = getAlterColumnCollation(
        desiredColumn.collation,
        currentColumn.collation,
        typeIsChanging
      );
      const typeConversionSQL = this.generateTypeConversionSQL(
        tableName,
        desiredColumn.name,
        desiredColumn.type,
        currentColumn.type,
        collation
      );
      statements.push(typeConversionSQL);
    }

    const physicalChanges = getColumnPhysicalChanges(
      desiredColumn,
      currentColumn,
      typeIsChanging
    );
    if (physicalChanges.storage) {
      statements.push(
        new SQLBuilder()
          .p("ALTER TABLE")
          .p(tableName)
          .p("ALTER COLUMN")
          .ident(desiredColumn.name)
          .p(`SET STORAGE ${physicalChanges.storage};`)
          .build()
      );
    }

    if (physicalChanges.compression) {
      statements.push(
        new SQLBuilder()
          .p("ALTER TABLE")
          .p(tableName)
          .p("ALTER COLUMN")
          .ident(desiredColumn.name)
          .p(`SET COMPRESSION ${physicalChanges.compression};`)
          .build()
      );
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
    if (!desiredColumn.generated && !currentColumn.generated && desiredColumn.nullable !== currentColumn.nullable) {
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
    currentType: string,
    collation?: QualifiedName
  ): string {
    // SERIAL is not valid in ALTER COLUMN TYPE, so use its underlying type.
    const alterType = desiredType === "SERIAL" ? "INTEGER" : desiredType;
    const needsUsing = this.requiresUsingClause(currentType, alterType);

    const builder = new SQLBuilder()
      .p("ALTER TABLE")
      .p(tableName) // tableName is already qualified
      .p("ALTER COLUMN")
      .ident(columnName)
      .p(`TYPE ${alterType}`);

    if (collation) {
      builder.p(`COLLATE ${renderCollationName(collation)}`);
    }

    if (needsUsing) {
      const usingExpression = this.generateUsingExpression(
        columnName,
        currentType,
        alterType
      );
      builder.p(`USING ${usingExpression}`);
    }

    return builder.p(";").build();
  }

  private requiresUsingClause(
    currentType: string,
    desiredType: string
  ): boolean {
    const currentNormalized = normalizeType(currentType);
    const desiredNormalized = normalizeType(desiredType);

    if (this.isTextLikeType(currentNormalized)) {
      if (desiredNormalized.startsWith("NUMERIC")) {
        return true;
      }
      if (this.isIntegerType(desiredNormalized)) {
        return true;
      }
      if (desiredNormalized === "BOOLEAN") {
        return true;
      }
    }

    return false;
  }

  private generateUsingExpression(
    columnName: string,
    currentType: string,
    desiredType: string
  ): string {
    const currentNormalized = normalizeType(currentType);
    const desiredNormalized = normalizeType(desiredType);
    const quotedCol = `"${columnName.replace(/"/g, '""')}"`;

    if (this.isTextLikeType(currentNormalized)) {
      if (desiredNormalized.startsWith("NUMERIC")) {
        return `${quotedCol}::${desiredType}`;
      }
      if (this.isIntegerType(desiredNormalized)) {
        return `TRUNC(${quotedCol}::DECIMAL)::${this.getIntegerCastType(desiredNormalized)}`;
      }
      if (desiredNormalized === "BOOLEAN") {
        return `TRIM(${quotedCol})::boolean`;
      }
    }

    return `${quotedCol}::${desiredType}`;
  }

  private isTextLikeType(type: string): boolean {
    return type === "TEXT" || type.startsWith("VARCHAR") || type.startsWith("CHAR");
  }

  private isIntegerType(type: string): boolean {
    return type === "INT2" || type === "INT4" || type === "INT8";
  }

  private getIntegerCastType(type: string): string {
    if (type === "INT2") {
      return "smallint";
    }
    if (type === "INT8") {
      return "bigint";
    }
    return "integer";
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

    const toRemove = [...indexComparison.toRemove].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    const toAdd = [...indexComparison.toAdd].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    const toModify = [...indexComparison.toModify].sort((a, b) =>
      a.desired.name.localeCompare(b.desired.name)
    );

    // Drop removed indexes first
    statements.push(
      ...this.generateIndexDropStatements(toRemove)
    );

    // Create new indexes
    statements.push(
      ...this.generateIndexCreationStatements(toAdd)
    );

    // Handle modified indexes (drop + create) - use non-concurrent to keep in same transaction
    for (const mod of toModify) {
      const dropBuilder = new SQLBuilder();
      dropBuilder.p("DROP INDEX");
      if (mod.current.schema) {
        dropBuilder.table(mod.current.name, mod.current.schema);
      } else {
        dropBuilder.ident(mod.current.name);
      }
      dropBuilder.p(";");
      statements.push(dropBuilder.build());
      statements.push(this.generateCreateIndexSQL(mod.desired, false));
    }

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
    if (index1.tableName !== index2.tableName) return false;
    if (index1.type !== index2.type) return false;
    if (index1.unique !== index2.unique) return false;
    if (!stringArraysEqual(index1.include, index2.include)) return false;
    if (
      Boolean(index1.nullsNotDistinct) !== Boolean(index2.nullsNotDistinct)
    ) {
      return false;
    }

    const expr1 = index1.expression;
    const expr2 = index2.expression;

    if (expr1 && expr2) {
      if (!expressionsEqual(expr1, expr2)) return false;
      const sort1 = index1.sortOrders?.[0] || 'ASC';
      const sort2 = index2.sortOrders?.[0] || 'ASC';
      if (sort1 !== sort2) return false;
    } else if (expr1 || expr2) {
      const expressionIndex = expr1 ? index1 : index2;
      const columnIndex = expr1 ? index2 : index1;
      const expression = expr1 || expr2;

      if (!expression || columnIndex.columns.length !== 1) return false;
      if (!this.expressionMatchesColumn(expression, columnIndex.columns[0] || "")) {
        return false;
      }

      const expressionSort = expressionIndex.sortOrders?.[0] || 'ASC';
      const columnSort = columnIndex.sortOrders?.[0] || 'ASC';
      if (expressionSort !== columnSort) return false;
    } else {
      if (index1.columns.length !== index2.columns.length) return false;
      for (let i = 0; i < index1.columns.length; i++) {
        if (index1.columns[i] !== index2.columns[i]) return false;
      }

      const sortOrders1 = index1.sortOrders || index1.columns.map(() => 'ASC');
      const sortOrders2 = index2.sortOrders || index2.columns.map(() => 'ASC');
      if (sortOrders1.length !== sortOrders2.length) return false;
      for (let i = 0; i < sortOrders1.length; i++) {
        if (sortOrders1[i] !== sortOrders2[i]) return false;
      }
    }

    if (!indexNullsOrdersEqual(index1, index2)) return false;

    const where1 = index1.where;
    const where2 = index2.where;
    if (where1 && where2) {
      if (!expressionsEqual(where1, where2)) return false;
    } else if (where1 !== where2) {
      return false;
    }
    if (index1.expressionOpclass !== index2.expressionOpclass) return false;
    if (index1.tablespace !== index2.tablespace) return false;

    const opclasses1 = index1.opclasses || {};
    const opclasses2 = index2.opclasses || {};
    const opKeys1 = Object.keys(opclasses1);
    const opKeys2 = Object.keys(opclasses2);
    if (opKeys1.length !== opKeys2.length) return false;
    for (const key of opKeys1) {
      if (opclasses1[key] !== opclasses2[key]) return false;
    }

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

  private expressionMatchesColumn(expression: string, columnName: string): boolean {
    const normalizedExpression = normalizeExpression(expression)
      .replace(/"/g, "")
      .toLowerCase();
    const normalizedColumn = columnName.replace(/"/g, "").toLowerCase();
    return normalizedExpression === normalizedColumn;
  }

  private generateIndexCreationStatements(indexes: Index[]): string[] {
    const sorted = [...indexes].sort((a, b) => a.name.localeCompare(b.name));
    return sorted.map((index) =>
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
      if (index.schema) {
        builder.table(index.name, index.schema);
      } else {
        builder.ident(index.name);
      }
      return builder.p(";").build();
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
      let expr = index.expression;
      const hasOperators = /[+\-*/%^&|<>=!:]/.test(expr);
      if (hasOperators) {
        expr = `(${expr})`;
      }
      const expressionOpclass = index.expressionOpclass;
      const sortOrder = index.sortOrders?.[0];
      let expressionDefinition = expressionOpclass ? `${expr} ${expressionOpclass}` : expr;
      if (sortOrder === 'DESC') {
        expressionDefinition += ' DESC';
      }
      const nullsOrder = getNonDefaultNullsOrder(index, 0);
      if (nullsOrder) {
        expressionDefinition += ` NULLS ${nullsOrder}`;
      }
      builder.p(`(${expressionDefinition})`);
    } else {
      const quotedColumns = index.columns.map((col, i) => {
        const quoted = `"${col.replace(/"/g, '""')}"`;
        const opclass = index.opclasses?.[col];
        const sortOrder = index.sortOrders?.[i];
        let result = opclass ? `${quoted} ${opclass}` : quoted;
        if (sortOrder === 'DESC') {
          result += ' DESC';
        }
        const nullsOrder = getNonDefaultNullsOrder(index, i);
        if (nullsOrder) {
          result += ` NULLS ${nullsOrder}`;
        }
        return result;
      }).join(", ");
      builder.p(`(${quotedColumns})`);
    }

    if (index.include && index.include.length > 0) {
      const includedColumns = index.include.map(function quoteColumn(column) {
        return new SQLBuilder().ident(column).build();
      });
      builder.p(`INCLUDE (${includedColumns.join(", ")})`);
    }

    if (index.nullsNotDistinct) {
      builder.p("NULLS NOT DISTINCT");
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

    if (index.where) {
      builder.p(`WHERE ${index.where}`);
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

    const findMatchingConstraint = (
      expr: string,
      constraints: CheckConstraint[]
    ): CheckConstraint | undefined => {
      return constraints.find(c => expressionsEqual(expr, c.expression));
    };

    const processedCurrentNames = new Set<string>();

    for (const desired of desiredConstraints) {
      const matchingCurrent = findMatchingConstraint(desired.expression, currentConstraints);
      if (matchingCurrent) {
        if (matchingCurrent.name) {
          processedCurrentNames.add(matchingCurrent.name);
        }
        if (matchingCurrent.name !== desired.name) {
          if (matchingCurrent.name) {
            statements.push(generateDropCheckConstraintSQL(tableName, matchingCurrent.name));
          }
          statements.push(generateAddCheckConstraintSQL(tableName, desired));
        }
      } else {
        statements.push(generateAddCheckConstraintSQL(tableName, desired));
      }
    }

    for (const current of currentConstraints) {
      if (current.name && !processedCurrentNames.has(current.name)) {
        statements.push(generateDropCheckConstraintSQL(tableName, current.name));
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

    const getStructuralKey = (c: ForeignKeyConstraint) =>
      `${c.columns.join(',')}->${c.referencedTable}.${c.referencedColumns.join(',')}`;

    const currentByName = new Map(
      currentConstraints.filter(c => c.name).map(c => [c.name!, c])
    );
    const currentByStructure = new Map(
      currentConstraints.map(c => [getStructuralKey(c), c])
    );

    const matchedCurrentNames = new Set<string>();

    for (const desired of desiredConstraints) {
      const structKey = getStructuralKey(desired);

      if (desired.name) {
        const currentByNameMatch = currentByName.get(desired.name);
        if (currentByNameMatch) {
          matchedCurrentNames.add(desired.name);
          if (this.foreignKeysDiffer(desired, currentByNameMatch)) {
            statements.push(generateDropForeignKeySQL(tableName, desired.name));
            statements.push(generateAddForeignKeySQL(tableName, desired));
          }
        } else {
          statements.push(generateAddForeignKeySQL(tableName, desired));
        }
      } else {
        const currentByStructMatch = currentByStructure.get(structKey);
        if (currentByStructMatch) {
          if (currentByStructMatch.name) {
            matchedCurrentNames.add(currentByStructMatch.name);
          }
          if (this.foreignKeysDiffer(desired, currentByStructMatch)) {
            if (currentByStructMatch.name) {
              statements.push(generateDropForeignKeySQL(tableName, currentByStructMatch.name));
            }
            statements.push(generateAddForeignKeySQL(tableName, desired));
          }
        } else {
          statements.push(generateAddForeignKeySQL(tableName, desired));
        }
      }
    }

    for (const current of currentConstraints) {
      if (current.name && !matchedCurrentNames.has(current.name)) {
        const dependsOnDroppedColumn = current.columns.some(col => droppedColumns.has(col));
        if (!dependsOnDroppedColumn) {
          statements.push(generateDropForeignKeySQL(tableName, current.name));
        }
      }
    }

    return statements;
  }

  private foreignKeysDiffer(a: ForeignKeyConstraint, b: ForeignKeyConstraint): boolean {
    if (a.columns.length !== b.columns.length ||
        !a.columns.every((col, i) => col === b.columns[i])) {
      return true;
    }

    if (a.referencedColumns.length !== b.referencedColumns.length ||
        !a.referencedColumns.every((col, i) => col === b.referencedColumns[i])) {
      return true;
    }

    if (
      normalizeReferencedTableName(a.referencedTable) !==
      normalizeReferencedTableName(b.referencedTable)
    ) {
      return true;
    }

    const normalizeAction = (action: string | undefined) =>
      !action || action === 'NO ACTION' ? undefined : action;
    if (normalizeAction(a.onDelete) !== normalizeAction(b.onDelete) ||
        normalizeAction(a.onUpdate) !== normalizeAction(b.onUpdate)) {
      return true;
    }

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

    const getStructuralKey = (c: UniqueConstraint) =>
      [...c.columns].sort().join(',');

    const currentMap = new Map(
      currentConstraints.map(c => [getStructuralKey(c), c])
    );
    const desiredMap = new Map(
      desiredConstraints.map(c => [getStructuralKey(c), c])
    );

    for (const [key, constraint] of currentMap) {
      if (!desiredMap.has(key)) {
        if (constraint.name) {
          statements.push(generateDropUniqueConstraintSQL(tableName, constraint.name));
        }
      }
    }

    for (const [key, constraint] of desiredMap) {
      const current = currentMap.get(key);
      if (!current) {
        statements.push(generateAddUniqueConstraintSQL(tableName, constraint));
      } else if (this.uniqueConstraintsDiffer(constraint, current)) {
        if (current.name) {
          statements.push(
            generateDropUniqueConstraintSQL(tableName, current.name)
          );
        }
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
    currentTable: Table,
    context: MigrationContext = {}
  ): TableAlteration[] {
    const alterations: TableAlteration[] = [];
    const inheritanceChanges = this.collectTableInheritanceAlterations(
      desiredTable,
      currentTable,
      alterations
    );

    this.collectTableStorageParameterAlterations(
      desiredTable,
      currentTable,
      alterations
    );
    this.collectTableTablespaceAlteration(
      desiredTable,
      currentTable,
      alterations
    );
    this.collectTableAccessMethodAlteration(
      desiredTable,
      currentTable,
      context,
      alterations
    );

    // Collect column alterations
    const comparableCurrentColumns = inheritanceChanges.removed
      ? [...currentTable.columns, ...(currentTable.inheritedColumns || [])]
      : currentTable.columns;
    const currentColumns = new Map(
      comparableCurrentColumns.map((c) => [c.name, c])
    );
    const desiredColumns = new Map(desiredTable.columns.map((c) => [c.name, c]));

    // Add new columns
    for (const column of desiredTable.columns) {
      if (!currentColumns.has(column.name)) {
        alterations.push({ type: "add_column", column });
        this.collectColumnPhysicalAlterations(
          column,
          undefined,
          false,
          alterations
        );
      } else {
        // Check for column modifications
        const currentColumn = currentColumns.get(column.name)!;
        if (columnsAreDifferent(column, currentColumn)) {
          this.collectColumnModificationAlterations(column, currentColumn, alterations);
        }
      }
    }

    // Drop removed columns
    if (!inheritanceChanges.added) {
      for (const column of comparableCurrentColumns) {
        if (!desiredColumns.has(column.name)) {
          alterations.push({ type: "drop_column", columnName: column.name });
        }
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
    let comparableCurrentChecks = currentTable.checkConstraints || [];
    if (inheritanceChanges.removed) {
      comparableCurrentChecks = [
        ...comparableCurrentChecks,
        ...(currentTable.inheritedCheckConstraints || []),
      ];
    } else if (inheritanceChanges.added) {
      const desiredCheckNames = new Set(
        (desiredTable.checkConstraints || []).map(function getName(constraint) {
          return constraint.name;
        })
      );
      comparableCurrentChecks = comparableCurrentChecks.filter(
        function keepDesired(constraint) {
          return desiredCheckNames.has(constraint.name);
        }
      );
    }

    this.collectCheckConstraintAlterations(
      desiredTable.name,
      desiredTable.checkConstraints || [],
      comparableCurrentChecks,
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

    this.collectExclusionConstraintAlterations(
      desiredTable.exclusionConstraints || [],
      currentTable.exclusionConstraints || [],
      alterations
    );

    return alterations;
  }

  private collectTableStorageParameterAlterations(
    desiredTable: Table,
    currentTable: Table,
    alterations: TableAlteration[]
  ): void {
    const desired = desiredTable.storageParameters || {};
    const current = currentTable.storageParameters || {};
    const parametersToSet = Object.fromEntries(
      Object.entries(desired).filter(function filterChanged([name, value]) {
        return current[name] !== value;
      })
    );
    const parametersToReset = Object.keys(current)
      .filter(function filterRemoved(name) {
        return desired[name] === undefined;
      })
      .sort();

    if (Object.keys(parametersToSet).length > 0) {
      alterations.push({
        type: "set_table_storage_parameters",
        parameters: parametersToSet,
      });
    }
    if (parametersToReset.length > 0) {
      alterations.push({
        type: "reset_table_storage_parameters",
        parameters: parametersToReset,
      });
    }
  }

  private collectTableInheritanceAlterations(
    desiredTable: Table,
    currentTable: Table,
    alterations: TableAlteration[]
  ): { added: boolean; removed: boolean } {
    const desired = new Map(
      (desiredTable.inherits || []).map((parent) => [
        this.getInheritanceParentKey(parent, desiredTable.schema),
        parent,
      ])
    );
    const current = new Map(
      (currentTable.inherits || []).map((parent) => [
        this.getInheritanceParentKey(parent, currentTable.schema),
        parent,
      ])
    );
    const additions = [...desired].filter(function filterAdded([key]) {
      return !current.has(key);
    });
    const removals = [...current].filter(function filterRemoved([key]) {
      return !desired.has(key);
    });

    if (additions.length > 0 && removals.length > 0) {
      throw new ValidationError(
        `Changing inheritance parents for ${getQualifiedTableName(desiredTable)} must be applied as separate detach and attach migrations`,
        getQualifiedTableName(desiredTable),
        "inherits",
        desiredTable.inherits
      );
    }

    for (const [, parent] of removals.sort(([a], [b]) => a.localeCompare(b))) {
      alterations.push({ type: "no_inherit_parent", parent });
    }
    for (const [, parent] of additions.sort(([a], [b]) => a.localeCompare(b))) {
      alterations.push({ type: "inherit_parent", parent });
    }
    return {
      added: additions.length > 0,
      removed: removals.length > 0,
    };
  }

  private getInheritanceParentKey(
    parent: QualifiedName,
    childSchema?: string
  ): string {
    return `${parent.schema || childSchema || "public"}.${parent.name}`;
  }

  private collectTableTablespaceAlteration(
    desiredTable: Table,
    currentTable: Table,
    alterations: TableAlteration[]
  ): void {
    const desired = desiredTable.tablespace || "pg_default";
    const current = currentTable.tablespace || "pg_default";
    if (desired !== current) {
      alterations.push({
        type: "set_table_tablespace",
        tablespace: desired,
      });
    }
  }

  private collectTableAccessMethodAlteration(
    desiredTable: Table,
    currentTable: Table,
    context: MigrationContext,
    alterations: TableAlteration[]
  ): void {
    const defaultAccessMethod = context.defaultTableAccessMethod || "heap";
    const desired = desiredTable.accessMethod || defaultAccessMethod;
    const current = currentTable.accessMethod || defaultAccessMethod;
    if (desired === current) {
      return;
    }

    const tableName = getQualifiedTableName(desiredTable);
    if (context.postgresVersionNum === undefined) {
      throw new ValidationError(
        `Cannot safely change the access method of existing table ${tableName} without the PostgreSQL server version`,
        tableName,
        "accessMethod",
        desired
      );
    }

    if (context.postgresVersionNum < 150000) {
      const serverMajor = Math.floor(context.postgresVersionNum / 10000);
      throw new ValidationError(
        `PostgreSQL ${serverMajor} cannot change the access method of existing table ${tableName}; PostgreSQL 15 or newer is required for an in-place change`,
        tableName,
        "accessMethod",
        desired
      );
    }

    alterations.push({
      type: "set_table_access_method",
      accessMethod: desired,
    });
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
       !expressionsEqual(desiredColumn.generated.expression, currentColumn.generated.expression) ||
       desiredColumn.generated.always !== currentColumn.generated.always ||
       desiredColumn.generated.stored !== currentColumn.generated.stored);

    if (generatedChanging) {
      // Drop and recreate - these can't be batched with other operations
      alterations.push({ type: "drop_column", columnName: desiredColumn.name });
      alterations.push({ type: "add_column", column: desiredColumn });
      this.collectColumnPhysicalAlterations(
        desiredColumn,
        undefined,
        false,
        alterations
      );
      return;
    }

    this.collectIdentityAlterations(desiredColumn, currentColumn, alterations);

    const normalizedDesiredType = normalizeType(desiredColumn.type);
    const normalizedCurrentType = normalizeType(currentColumn.type);
    const typeIsChanging = normalizedDesiredType !== normalizedCurrentType;
    const collationIsChanging = collationsAreDifferent(
      desiredColumn.collation,
      currentColumn.collation
    );

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

    // Change the type or collation if needed
    if (typeIsChanging || collationIsChanging) {
      const needsUsing = typeIsChanging &&
        this.requiresUsingClause(currentColumn.type, desiredColumn.type);
      const usingClause = needsUsing
        ? this.generateUsingExpression(desiredColumn.name, currentColumn.type, desiredColumn.type)
        : undefined;
      const collation = getAlterColumnCollation(
        desiredColumn.collation,
        currentColumn.collation,
        typeIsChanging
      );

      // Handle SERIAL specially
      const actualType = desiredColumn.type === "SERIAL" ? "INTEGER" : desiredColumn.type;

      alterations.push({
        type: "alter_column_type",
        columnName: desiredColumn.name,
        newType: actualType,
        collation,
        usingClause,
      });
    }

    this.collectColumnPhysicalAlterations(
      desiredColumn,
      currentColumn,
      typeIsChanging,
      alterations
    );

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
    if (!desiredColumn.generated && !currentColumn.generated && desiredColumn.nullable !== currentColumn.nullable) {
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

  private collectIdentityAlterations(
    desiredColumn: Column,
    currentColumn: Column,
    alterations: TableAlteration[]
  ): void {
    const desiredIdentity = desiredColumn.identity;
    const currentIdentity = currentColumn.identity;

    if (currentIdentity && !desiredIdentity) {
      alterations.push({
        type: "alter_column_drop_identity",
        columnName: desiredColumn.name,
      });
      return;
    }

    if (desiredIdentity && !currentIdentity) {
      alterations.push({
        type: "alter_column_add_identity",
        columnName: desiredColumn.name,
        identity: desiredIdentity,
      });
      return;
    }

    if (!desiredIdentity || !currentIdentity) return;

    if (desiredIdentity.generation !== currentIdentity.generation) {
      alterations.push({
        type: "alter_column_set_identity_generation",
        columnName: desiredColumn.name,
        generation: desiredIdentity.generation,
      });
    }

    const optionChanges = getIdentityOptionChanges(
      desiredIdentity,
      currentIdentity
    );
    for (const change of optionChanges) {
      alterations.push({
        type: "alter_column_set_identity_option",
        columnName: desiredColumn.name,
        clause: change.clause,
        order: change.order,
      });
    }
  }

  private collectColumnPhysicalAlterations(
    desiredColumn: Column,
    currentColumn: Column | undefined,
    typeIsChanging: boolean,
    alterations: TableAlteration[]
  ): void {
    const changes = getColumnPhysicalChanges(
      desiredColumn,
      currentColumn,
      typeIsChanging
    );
    if (changes.storage) {
      alterations.push({
        type: "alter_column_set_storage",
        columnName: desiredColumn.name,
        storage: changes.storage,
      });
    }

    if (changes.compression) {
      alterations.push({
        type: "alter_column_set_compression",
        columnName: desiredColumn.name,
        compression: changes.compression,
      });
    }
  }

  private generateIdentitySequenceRenameStatements(
    desiredTable: Table,
    currentTable: Table
  ): string[] {
    const statements: string[] = [];
    const currentColumns = new Map(
      currentTable.columns.map(function mapColumn(column) {
        return [column.name, column] as const;
      })
    );

    for (const desiredColumn of desiredTable.columns) {
      const desiredName = desiredColumn.identity?.sequenceName;
      const currentName = currentColumns.get(desiredColumn.name)?.identity
        ?.sequenceName;
      if (!identitySequenceNamesDiffer(desiredName, currentName)) continue;
      if (!desiredName || !currentName) continue;

      let currentSchema = currentName.schema;
      if (desiredName.schema && desiredName.schema !== currentSchema) {
        statements.push(
          new SQLBuilder()
            .p("ALTER SEQUENCE")
            .table(currentName.name, currentSchema)
            .p("SET SCHEMA")
            .ident(desiredName.schema)
            .p(";")
            .build()
        );
        currentSchema = desiredName.schema;
      }

      if (desiredName.name !== currentName.name) {
        statements.push(
          new SQLBuilder()
            .p("ALTER SEQUENCE")
            .table(currentName.name, currentSchema)
            .p("RENAME TO")
            .ident(desiredName.name)
            .p(";")
            .build()
        );
      }
    }

    return statements;
  }

  /**
   * Collects check constraint alterations
   */
  private collectCheckConstraintAlterations(
    tableName: string,
    desiredConstraints: CheckConstraint[],
    currentConstraints: CheckConstraint[],
    alterations: TableAlteration[]
  ): void {
    const findMatchingConstraint = (
      expr: string,
      constraints: CheckConstraint[]
    ): CheckConstraint | undefined => {
      return constraints.find(c => expressionsEqual(expr, c.expression));
    };

    const processedCurrentNames = new Set<string>();

    for (const desired of desiredConstraints) {
      const matchingCurrent = findMatchingConstraint(desired.expression, currentConstraints);
      if (matchingCurrent) {
        if (matchingCurrent.name) {
          processedCurrentNames.add(matchingCurrent.name);
        }
        if (desired.name && matchingCurrent.name !== desired.name) {
          if (matchingCurrent.name) {
            alterations.push({
              type: "drop_check",
              constraintName: matchingCurrent.name,
            });
          }
          alterations.push({
            type: "add_check",
            constraint: desired,
          });
        }
      } else {
        alterations.push({
          type: "add_check",
          constraint: desired,
        });
      }
    }

    for (const current of currentConstraints) {
      if (current.name && !processedCurrentNames.has(current.name)) {
        alterations.push({
          type: "drop_check",
          constraintName: current.name,
        });
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
    const getStructuralKey = (c: ForeignKeyConstraint) =>
      `${c.columns.join(',')}->${c.referencedTable}.${c.referencedColumns.join(',')}`;

    const currentByName = new Map(
      currentConstraints.filter(c => c.name).map(c => [c.name!, c])
    );
    const currentByStructure = new Map(
      currentConstraints.map(c => [getStructuralKey(c), c])
    );

    const matchedCurrentNames = new Set<string>();

    for (const desired of desiredConstraints) {
      const structKey = getStructuralKey(desired);

      if (desired.name) {
        const currentByNameMatch = currentByName.get(desired.name);
        if (currentByNameMatch) {
          matchedCurrentNames.add(desired.name);
          if (this.foreignKeysDiffer(desired, currentByNameMatch)) {
            alterations.push({ type: "drop_foreign_key", constraintName: desired.name });
            alterations.push({ type: "add_foreign_key", constraint: desired });
          }
        } else {
          alterations.push({ type: "add_foreign_key", constraint: desired });
        }
      } else {
        const currentByStructMatch = currentByStructure.get(structKey);
        if (currentByStructMatch) {
          if (currentByStructMatch.name) {
            matchedCurrentNames.add(currentByStructMatch.name);
          }
          if (this.foreignKeysDiffer(desired, currentByStructMatch)) {
            if (currentByStructMatch.name) {
              alterations.push({ type: "drop_foreign_key", constraintName: currentByStructMatch.name });
            }
            alterations.push({ type: "add_foreign_key", constraint: desired });
          }
        } else {
          alterations.push({ type: "add_foreign_key", constraint: desired });
        }
      }
    }

    for (const current of currentConstraints) {
      if (current.name && !matchedCurrentNames.has(current.name)) {
        const dependsOnDroppedColumn = current.columns.some(col => droppedColumns.has(col));
        if (!dependsOnDroppedColumn) {
          alterations.push({ type: "drop_foreign_key", constraintName: current.name });
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
    const getStructuralKey = (c: UniqueConstraint) => c.columns.join(',');

    const currentMap = new Map(
      currentConstraints.map(c => [getStructuralKey(c), c])
    );
    const desiredMap = new Map(
      desiredConstraints.map(c => [getStructuralKey(c), c])
    );

    for (const [key, constraint] of currentMap) {
      if (!desiredMap.has(key) && constraint.name) {
        alterations.push({
          type: "drop_unique",
          constraintName: constraint.name,
        });
      }
    }

    for (const [key, constraint] of desiredMap) {
      const current = currentMap.get(key);
      if (!current) {
        alterations.push({
          type: "add_unique",
          constraint,
        });
      } else if (this.uniqueConstraintsDiffer(constraint, current)) {
        if (current.name) {
          alterations.push({
            type: "drop_unique",
            constraintName: current.name,
          });
        }
        alterations.push({ type: "add_unique", constraint });
      }
    }
  }

  private uniqueConstraintsDiffer(
    desired: UniqueConstraint,
    current: UniqueConstraint
  ): boolean {
    return (
      !stringArraysEqual(desired.include, current.include) ||
      !stringRecordsEqual(
        desired.storageParameters,
        current.storageParameters
      ) ||
      (desired.tablespace || "pg_default") !==
        (current.tablespace || "pg_default") ||
      Boolean(desired.nullsNotDistinct) !==
        Boolean(current.nullsNotDistinct) ||
      Boolean(desired.deferrable) !== Boolean(current.deferrable) ||
      Boolean(desired.initiallyDeferred) !==
        Boolean(current.initiallyDeferred)
    );
  }

  private collectExclusionConstraintAlterations(
    desiredConstraints: ExclusionConstraint[],
    currentConstraints: ExclusionConstraint[],
    alterations: TableAlteration[]
  ): void {
    const unmatchedCurrent = new Set(currentConstraints);

    for (const desired of desiredConstraints) {
      let current: ExclusionConstraint | undefined;
      if (desired.name) {
        current = currentConstraints.find(function findByName(constraint) {
          return (
            unmatchedCurrent.has(constraint) &&
            constraint.name === desired.name
          );
        });
      } else {
        current = currentConstraints.find(function findByDefinition(constraint) {
          return (
            unmatchedCurrent.has(constraint) &&
            !exclusionConstraintsDiffer(desired, constraint)
          );
        });
      }

      if (!current) {
        alterations.push({ type: "add_exclusion", constraint: desired });
        continue;
      }

      unmatchedCurrent.delete(current);
      if (exclusionConstraintsDiffer(desired, current)) {
        if (current.name) {
          alterations.push({
            type: "drop_exclusion",
            constraintName: current.name,
          });
        }
        alterations.push({ type: "add_exclusion", constraint: desired });
      }
    }

    for (const current of unmatchedCurrent) {
      if (current.name) {
        alterations.push({
          type: "drop_exclusion",
          constraintName: current.name,
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

    // Sort alterations: drops first, then alters, then adds
    // Within each category, order by dependency (e.g., constraints before columns for drops)
    const operationPriority: Record<string, number> = {
      inherit_parent: 0,
      no_inherit_parent: 0,
      drop_foreign_key: 0,
      drop_exclusion: 1,
      drop_unique: 1,
      drop_check: 2,
      drop_primary_key: 3,
      drop_column: 4,
      alter_column_drop_identity: 5,
      alter_column_type: 10,
      alter_column_set_default: 11,
      alter_column_drop_default: 12,
      add_column: 13,
      alter_column_set_storage: 14,
      alter_column_set_compression: 15,
      alter_column_set_not_null: 16,
      alter_column_add_identity: 17,
      alter_column_set_identity_generation: 18,
      alter_column_set_identity_option: 19,
      alter_column_drop_not_null: 20,
      add_primary_key: 21,
      add_check: 22,
      add_unique: 23,
      add_exclusion: 24,
      add_foreign_key: 25,
      reset_table_storage_parameters: 26,
      set_table_storage_parameters: 27,
      set_table_access_method: 28,
      set_table_tablespace: 29,
    };

    const sorted = [...alterations].sort((a, b) => {
      const priorityDiff =
        (operationPriority[a.type] ?? 99) - (operationPriority[b.type] ?? 99);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      const aKey = this.getAlterationSortKey(table, a);
      const bKey = this.getAlterationSortKey(table, b);
      return aKey.localeCompare(bKey);
    });

    const builder = new SQLBuilder()
      .p("ALTER TABLE")
      .table(table.name, table.schema);

    builder.indentIn();
    builder.mapComma(sorted, (alt, b) => {
      b.nl();
      switch (alt.type) {
        case "set_table_storage_parameters":
          b.p(
            `SET (${renderStorageParameterAssignments(alt.parameters)})`
          );
          break;

        case "inherit_parent":
          b.p("INHERIT").table(alt.parent.name, alt.parent.schema);
          break;

        case "no_inherit_parent":
          b.p("NO INHERIT").table(alt.parent.name, alt.parent.schema);
          break;

        case "reset_table_storage_parameters":
          b.p(`RESET (${alt.parameters.join(", ")})`);
          break;

        case "set_table_access_method":
          b.p("SET ACCESS METHOD").ident(alt.accessMethod);
          break;

        case "set_table_tablespace":
          b.p("SET TABLESPACE").ident(alt.tablespace);
          break;

        case "add_column":
          b.p("ADD COLUMN")
            .p(generateColumnDefinition(alt.column));
          break;

        case "drop_column":
          b.p("DROP COLUMN").ident(alt.columnName);
          break;

        case "alter_column_type":
          b.p("ALTER COLUMN")
            .ident(alt.columnName)
            .p(`TYPE ${alt.newType}`);
          if (alt.collation) {
            b.p(`COLLATE ${renderCollationName(alt.collation)}`);
          }
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

        case "alter_column_set_storage":
          b.p("ALTER COLUMN")
            .ident(alt.columnName)
            .p(`SET STORAGE ${alt.storage}`);
          break;

        case "alter_column_set_compression":
          b.p("ALTER COLUMN")
            .ident(alt.columnName)
            .p(`SET COMPRESSION ${alt.compression}`);
          break;

        case "alter_column_add_identity":
          b.p("ALTER COLUMN")
            .ident(alt.columnName)
            .p(`ADD ${renderIdentityClause(alt.identity)}`);
          break;

        case "alter_column_drop_identity":
          b.p("ALTER COLUMN")
            .ident(alt.columnName)
            .p("DROP IDENTITY");
          break;

        case "alter_column_set_identity_generation":
          b.p("ALTER COLUMN")
            .ident(alt.columnName)
            .p(`SET GENERATED ${alt.generation}`);
          break;

        case "alter_column_set_identity_option":
          b.p("ALTER COLUMN")
            .ident(alt.columnName)
            .p(`SET ${alt.clause}`);
          break;

        case "add_primary_key": {
          const bareTable = getBareTableName(table.name);
          const constraintName = alt.constraint.name || `${bareTable}_pkey`;
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
          if (alt.constraint.name) {
            b.p("ADD CONSTRAINT")
              .ident(alt.constraint.name)
              .p(`CHECK (${alt.constraint.expression})`);
          } else {
            b.p(`ADD CHECK (${alt.constraint.expression})`);
          }
          break;
        }

        case "drop_check":
          b.p("DROP CONSTRAINT").ident(alt.constraintName);
          break;

        case "add_foreign_key": {
          const constraintName = getForeignKeyConstraintName(table.name, alt.constraint);
          const columns = alt.constraint.columns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");
          const referencedColumns = alt.constraint.referencedColumns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");
          b.p("ADD CONSTRAINT")
            .ident(constraintName)
            .p(`FOREIGN KEY (${columns}) REFERENCES`)
            .table(...splitSchemaTable(alt.constraint.referencedTable))
            .p(`(${referencedColumns})`);
          if (alt.constraint.onDelete) {
            b.p(`ON DELETE ${alt.constraint.onDelete}`);
          }
          if (alt.constraint.onUpdate) {
            b.p(`ON UPDATE ${alt.constraint.onUpdate}`);
          }
          if (alt.constraint.deferrable) {
            b.p("DEFERRABLE");
            if (alt.constraint.initiallyDeferred) {
              b.p("INITIALLY DEFERRED");
            }
          }
          break;
        }

        case "drop_foreign_key":
          b.p("DROP CONSTRAINT").ident(alt.constraintName);
          break;

        case "add_unique": {
          b.p("ADD").p(
            generateUniqueConstraintClause(alt.constraint, table.name)
          );
          break;
        }

        case "drop_unique":
          b.p("DROP CONSTRAINT").ident(alt.constraintName);
          break;

        case "add_exclusion":
          b.p("ADD").p(generateExclusionConstraintClause(alt.constraint));
          break;

        case "drop_exclusion":
          b.p("DROP CONSTRAINT").ident(alt.constraintName);
          break;
      }
    });
    builder.indentOut();

    return builder.p(";").build();
  }

  private getAlterationSortKey(table: Table, alteration: TableAlteration): string {
    switch (alteration.type) {
      case "set_table_storage_parameters":
        return renderStorageParameterAssignments(alteration.parameters);
      case "reset_table_storage_parameters":
        return alteration.parameters.join(",");
      case "inherit_parent":
      case "no_inherit_parent":
        return this.getInheritanceParentKey(alteration.parent, table.schema);
      case "set_table_access_method":
        return alteration.accessMethod;
      case "set_table_tablespace":
        return alteration.tablespace;
      case "add_column":
        return alteration.column.name;
      case "drop_column":
        return alteration.columnName;
      case "alter_column_type":
      case "alter_column_set_default":
      case "alter_column_drop_default":
      case "alter_column_set_not_null":
      case "alter_column_drop_not_null":
      case "alter_column_add_identity":
      case "alter_column_drop_identity":
      case "alter_column_set_identity_generation":
      case "alter_column_set_storage":
      case "alter_column_set_compression":
        return alteration.columnName;
      case "alter_column_set_identity_option":
        return `${alteration.columnName}:${String(alteration.order).padStart(2, "0")}:${alteration.clause}`;
      case "add_primary_key":
        return alteration.constraint.name || alteration.constraint.columns.join(",");
      case "drop_primary_key":
        return alteration.constraintName;
      case "add_check":
        return alteration.constraint.name || alteration.constraint.expression;
      case "drop_check":
        return alteration.constraintName;
      case "add_foreign_key":
        return (
          alteration.constraint.name ||
          `${alteration.constraint.columns.join(",")}->${alteration.constraint.referencedTable}.${alteration.constraint.referencedColumns.join(",")}`
        );
      case "drop_foreign_key":
        return alteration.constraintName;
      case "add_unique":
        return alteration.constraint.name || alteration.constraint.columns.join(",");
      case "drop_unique":
        return alteration.constraintName;
      case "add_exclusion":
        return alteration.constraint.name ||
          alteration.constraint.elements
            .map(function getDefinition(element) {
              return `${element.definition}:${element.operator.name}`;
            })
            .join(",");
      case "drop_exclusion":
        return alteration.constraintName;
      default:
        return "";
    }
  }
}
