import type {
  Table,
  Column,
  Index,
  IndexTerm,
  ForeignKeyConstraint,
  CheckConstraint,
} from "../../types/schema";
import type { MigrationPlan } from "../../types/migration";
import { ValidationError } from "../../types/errors";
import {
  canonicalizeSQLiteDefinitionIdentifiers,
  canonicalizeSQLiteForeignKeyDefinition,
  extractSQLiteColumnDefinition,
  isSQLiteRowidAliasColumnDefinition,
  parseSQLiteTableDefinition,
  replaceSQLiteColumnDefinitionName,
  replaceSQLiteCreateTableName,
} from "./sql-parser-utils";
import { chooseSQLiteRecreationTableName } from "../../utils/sqlite-recreation";
import {
  collectSQLiteSchemaIdentifiers,
  normalizeSQLiteIdentifier,
} from "../../utils/sqlite-identifier";

interface ColumnChange {
  type: 'add' | 'drop' | 'modify';
  column: Column;
  oldColumn?: Column;
}

interface TableChanges {
  requiresRecreate: boolean;
  columnChanges: ColumnChange[];
  indexesToAdd: Index[];
  indexesToDrop: Index[];
  foreignKeysChanged: boolean;
  checkConstraintsChanged: boolean;
  uniqueConstraintsChanged: boolean;
}

interface SQLiteRecreationCopyColumns {
  target: string[];
  source: string[];
}

const SQLITE_ROWID_NAMES = ["rowid", "oid", "_rowid_"] as const;

function indexBySQLiteIdentifier<T extends { name: string }>(
  items: readonly T[]
): Map<string, T> {
  return new Map(items.map(function (item) {
    return [normalizeSQLiteIdentifier(item.name), item] as const;
  }));
}

export class SQLiteDiffer {
  generateMigrationPlan(desired: Table[], current: Table[]): MigrationPlan {
    const statements: string[] = [];
    const currentMap = indexBySQLiteIdentifier(current);
    const desiredMap = indexBySQLiteIdentifier(desired);
    const occupiedSchemaNames = new Set<string>();
    for (const table of [...desired, ...current]) {
      occupiedSchemaNames.add(table.name);
      for (const index of table.indexes || []) {
        occupiedSchemaNames.add(index.name);
      }
    }

    for (const table of desired) {
      const currentTable = currentMap.get(normalizeSQLiteIdentifier(table.name));

      if (!currentTable) {
        statements.push(this.generateCreateTable(table));
        for (const index of table.indexes || []) {
          if (!index.constraint) {
            statements.push(this.generateCreateIndex(index));
          }
        }
      } else {
        const changes = this.detectChanges(table, currentTable);

        if (changes.requiresRecreate) {
          const temporaryTableName = chooseSQLiteRecreationTableName(
            table.name,
            occupiedSchemaNames
          );
          occupiedSchemaNames.add(temporaryTableName);
          const nullableRowidPromotion =
            this.getNullableRowidAliasPromotionColumn(table, currentTable);
          const rowidGuardTableName = nullableRowidPromotion
            ? chooseSQLiteRecreationTableName(
                `${table.name}_rowid_guard`,
                occupiedSchemaNames
              )
            : undefined;
          if (rowidGuardTableName) {
            occupiedSchemaNames.add(rowidGuardTableName);
          }
          statements.push(
            ...this.generateTableRecreation(
              table,
              currentTable,
              temporaryTableName,
              rowidGuardTableName
            )
          );
        } else {
          for (const change of changes.columnChanges) {
            if (change.type === 'add') {
              statements.push(this.generateAddColumn(table, change.column));
            }
          }
          for (const index of changes.indexesToDrop) {
            statements.push(`DROP INDEX IF EXISTS ${this.quoteIdentifier(index.name)};`);
          }
          for (const index of changes.indexesToAdd) {
            statements.push(this.generateCreateIndex(index));
          }
        }
      }
    }

    for (const table of current) {
      if (!desiredMap.has(normalizeSQLiteIdentifier(table.name))) {
        statements.push(`DROP TABLE IF EXISTS ${this.quoteIdentifier(table.name)};`);
      }
    }

    return {
      transactional: statements,
      concurrent: [],
      deferred: [],
      hasChanges: statements.length > 0,
    };
  }

  private detectChanges(desired: Table, current: Table): TableChanges {
    const changes: TableChanges = {
      requiresRecreate: false,
      columnChanges: [],
      indexesToAdd: [],
      indexesToDrop: [],
      foreignKeysChanged: false,
      checkConstraintsChanged: false,
      uniqueConstraintsChanged: false,
    };
    const identifiers = collectSQLiteSchemaIdentifiers(
      [desired, current],
      [],
      []
    );

    const currentColMap = indexBySQLiteIdentifier(current.columns);
    const desiredColMap = indexBySQLiteIdentifier(desired.columns);

    for (const col of desired.columns) {
      const currentCol = currentColMap.get(normalizeSQLiteIdentifier(col.name));
      if (!currentCol) {
        changes.columnChanges.push({ type: 'add', column: col });
        if (col.generated?.stored) {
          changes.requiresRecreate = true;
        }
      } else if (this.columnsDiffer(col, currentCol, identifiers)) {
        changes.requiresRecreate = true;
        changes.columnChanges.push({ type: 'modify', column: col, oldColumn: currentCol });
      }
    }

    for (const col of current.columns) {
      if (!desiredColMap.has(normalizeSQLiteIdentifier(col.name))) {
        changes.requiresRecreate = true;
        changes.columnChanges.push({ type: 'drop', column: col });
      }
    }

    if (this.primaryKeysDiffer(desired, current)) {
      changes.requiresRecreate = true;
    }

    if (this.foreignKeysDiffer(desired.foreignKeys, current.foreignKeys)) {
      changes.requiresRecreate = true;
      changes.foreignKeysChanged = true;
    }

    if (this.checkConstraintsDiffer(
      desired.checkConstraints,
      current.checkConstraints,
      identifiers
    )) {
      changes.requiresRecreate = true;
      changes.checkConstraintsChanged = true;
    }

    if (this.uniqueConstraintsDiffer(desired.uniqueConstraints, current.uniqueConstraints)) {
      changes.requiresRecreate = true;
      changes.uniqueConstraintsChanged = true;
    }

    if (this.tableOptionsDiffer(desired, current)) {
      changes.requiresRecreate = true;
    }

    if (this.tableDefinitionsDiffer(desired, current, identifiers)) {
      changes.requiresRecreate = true;
    }

    const currentIndexMap = indexBySQLiteIdentifier(current.indexes || []);
    const desiredIndexMap = indexBySQLiteIdentifier(desired.indexes || []);

    for (const index of desired.indexes || []) {
      if (!index.constraint) {
        const currentIndex = currentIndexMap.get(
          normalizeSQLiteIdentifier(index.name)
        );
        if (!currentIndex || this.indexesDiffer(
          index,
          currentIndex,
          identifiers
        )) {
          changes.indexesToAdd.push(index);
          if (currentIndex) {
            changes.indexesToDrop.push(currentIndex);
          }
        }
      }
    }

    for (const index of current.indexes || []) {
      if (
        !index.constraint &&
        !desiredIndexMap.has(normalizeSQLiteIdentifier(index.name))
      ) {
        changes.indexesToDrop.push(index);
      }
    }

    return changes;
  }

  private columnsDiffer(
    desired: Column,
    current: Column,
    identifiers: readonly string[]
  ): boolean {
    if (this.normalizeType(desired.type) !== this.normalizeType(current.type)) {
      return true;
    }
    if (desired.nullable !== current.nullable) {
      return true;
    }
    if (this.normalizeDefault(desired.default) !== this.normalizeDefault(current.default)) {
      return true;
    }
    if (
      normalizeSQLiteIdentifier(desired.collation?.name || "BINARY") !==
      normalizeSQLiteIdentifier(current.collation?.name || "BINARY")
    ) {
      return true;
    }
    if (desired.generated || current.generated) {
      if (!desired.generated || !current.generated) {
        return true;
      }
      if (
        desired.generated.stored !== current.generated.stored ||
        this.normalizeSQLiteExpression(
          desired.generated.expression,
          identifiers
        ) !== this.normalizeSQLiteExpression(
          current.generated.expression,
          identifiers
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private primaryKeysDiffer(desired: Table, current: Table): boolean {
    const desiredPk = desired.primaryKey?.columns || [];
    const currentPk = current.primaryKey?.columns || [];

    if (desiredPk.length !== currentPk.length) return true;
    return desiredPk.some(function (column, index) {
      return normalizeSQLiteIdentifier(column) !==
        normalizeSQLiteIdentifier(currentPk[index] || "");
    });
  }

  private foreignKeysDiffer(desired?: ForeignKeyConstraint[], current?: ForeignKeyConstraint[]): boolean {
    const d = desired || [];
    const c = current || [];
    if (d.length !== c.length) return true;

    const desiredSignatures = d.map(function (foreignKey) {
      return SQLiteDiffer.foreignKeySignature(foreignKey);
    }).sort();
    const currentSignatures = c.map(function (foreignKey) {
      return SQLiteDiffer.foreignKeySignature(foreignKey);
    }).sort();
    return desiredSignatures.some(function (signature, index) {
      return signature !== currentSignatures[index];
    });
  }

  private static foreignKeySignature(foreignKey: ForeignKeyConstraint): string {
    return [
      foreignKey.columns.map(normalizeSQLiteIdentifier).join("\0"),
      normalizeSQLiteIdentifier(foreignKey.referencedTable),
      foreignKey.referencedColumns.map(normalizeSQLiteIdentifier).join("\0"),
      foreignKey.onDelete || "NO ACTION",
      foreignKey.onUpdate || "NO ACTION",
      foreignKey.initiallyDeferred ? "DEFERRED" : "IMMEDIATE",
    ].join("\u0001");
  }

  private checkConstraintsDiffer(
    desired: CheckConstraint[] | undefined,
    current: CheckConstraint[] | undefined,
    identifiers: readonly string[]
  ): boolean {
    const d = desired || [];
    const c = current || [];
    if (d.length !== c.length) return true;

    const differ = this;
    const dExprs = d.map(function (constraint) {
      return differ.normalizeSQLiteExpression(
        constraint.expression,
        identifiers
      );
    }).sort();
    const cExprs = c.map(function (constraint) {
      return differ.normalizeSQLiteExpression(
        constraint.expression,
        identifiers
      );
    }).sort();

    return dExprs.some(function (expression, index) {
      return expression !== cExprs[index];
    });
  }

  private uniqueConstraintsDiffer(
    desired: Table["uniqueConstraints"],
    current: Table["uniqueConstraints"]
  ): boolean {
    const desiredColumns = (desired || [])
      .map(function (constraint) {
        return constraint.columns.map(function (column, index) {
          const collation = constraint.collations?.[index] || "BINARY";
          return `${normalizeSQLiteIdentifier(column)}\0${normalizeSQLiteIdentifier(collation)}`;
        }).join("\0");
      })
      .sort();
    const currentColumns = (current || [])
      .map(function (constraint) {
        return constraint.columns.map(function (column, index) {
          const collation = constraint.collations?.[index] || "BINARY";
          return `${normalizeSQLiteIdentifier(column)}\0${normalizeSQLiteIdentifier(collation)}`;
        }).join("\0");
      })
      .sort();

    if (desiredColumns.length !== currentColumns.length) {
      return true;
    }
    return desiredColumns.some(function (columns, index) {
      return columns !== currentColumns[index];
    });
  }

  private indexesDiffer(
    desired: Index,
    current: Index,
    identifiers: readonly string[]
  ): boolean {
    if (desired.terms || current.terms) {
      if (!desired.terms || !current.terms) {
        return true;
      }
      if (this.indexTermsDiffer(desired.terms, current.terms, identifiers)) {
        return true;
      }
    } else if (
      desired.columns.map(normalizeSQLiteIdentifier).join("\0") !==
      current.columns.map(normalizeSQLiteIdentifier).join("\0")
    ) {
      return true;
    }
    if (desired.unique !== current.unique) return true;
    return this.normalizeSQLiteExpression(desired.where, identifiers) !==
      this.normalizeSQLiteExpression(current.where, identifiers);
  }

  private tableOptionsDiffer(desired: Table, current: Table): boolean {
    if (Boolean(desired.virtual) !== Boolean(current.virtual)) {
      return true;
    }
    if (Boolean(desired.strict) !== Boolean(current.strict)) {
      return true;
    }
    if (Boolean(desired.withoutRowid) !== Boolean(current.withoutRowid)) {
      return true;
    }

    const desiredAutoincrement = (desired.autoincrementColumns || [])
      .map(normalizeSQLiteIdentifier)
      .sort();
    const currentAutoincrement = (current.autoincrementColumns || [])
      .map(normalizeSQLiteIdentifier)
      .sort();
    return desiredAutoincrement.join("\0") !== currentAutoincrement.join("\0");
  }

  private tableDefinitionsDiffer(
    desired: Table,
    current: Table,
    identifiers: readonly string[]
  ): boolean {
    if (!desired.createStatement || !current.createStatement) {
      return false;
    }

    if (desired.virtual || current.virtual) {
      const desiredStatement = replaceSQLiteCreateTableName(
        desired.createStatement,
        "__terradb_table__"
      ) || desired.createStatement;
      const currentStatement = replaceSQLiteCreateTableName(
        current.createStatement,
        "__terradb_table__"
      ) || current.createStatement;
      return this.normalizeSql(
        canonicalizeSQLiteDefinitionIdentifiers(
          desiredStatement,
          identifiers
        )
      ) !== this.normalizeSql(
        canonicalizeSQLiteDefinitionIdentifiers(
          currentStatement,
          identifiers
        )
      );
    }

    const desiredDefinition = parseSQLiteTableDefinition(desired.createStatement);
    const currentDefinition = parseSQLiteTableDefinition(current.createStatement);
    const currentColumns = new Map(
      currentDefinition.columns.map(function (column) {
        return [
          normalizeSQLiteIdentifier(column.name),
          column.definition,
        ] as const;
      })
    );

    for (const column of desiredDefinition.columns) {
      const currentColumn = currentColumns.get(
        normalizeSQLiteIdentifier(column.name)
      );
      if (!currentColumn) {
        continue;
      }
      const desiredCanonical = replaceSQLiteColumnDefinitionName(
        canonicalizeSQLiteDefinitionIdentifiers(
          canonicalizeSQLiteForeignKeyDefinition(column.definition),
          identifiers
        ),
        "__terradb_column__"
      );
      const currentCanonical = replaceSQLiteColumnDefinitionName(
        canonicalizeSQLiteDefinitionIdentifiers(
          canonicalizeSQLiteForeignKeyDefinition(currentColumn),
          identifiers
        ),
        "__terradb_column__"
      );
      if (
        this.normalizeSql(desiredCanonical) !==
        this.normalizeSql(currentCanonical)
      ) {
        return true;
      }
    }

    const desiredConstraints = this.normalizeDefinitions(
      desiredDefinition.constraints,
      identifiers
    );
    const currentConstraints = this.normalizeDefinitions(
      currentDefinition.constraints,
      identifiers
    );
    return desiredConstraints.join("\0") !== currentConstraints.join("\0");
  }

  private normalizeDefinitions(
    definitions: string[],
    identifiers: readonly string[]
  ): string[] {
    const differ = this;
    return definitions.map(function (definition) {
      return differ.normalizeSql(
        canonicalizeSQLiteDefinitionIdentifiers(
          canonicalizeSQLiteForeignKeyDefinition(definition),
          identifiers
        )
      ) || "";
    }).sort();
  }

  private indexTermsDiffer(
    desired: IndexTerm[],
    current: IndexTerm[],
    identifiers: readonly string[]
  ): boolean {
    if (desired.length !== current.length) {
      return true;
    }

    for (let index = 0; index < desired.length; index += 1) {
      const term = desired[index]!;
      const currentTerm = current[index];
      if (!currentTerm ||
        normalizeSQLiteIdentifier(term.column || "") !==
          normalizeSQLiteIdentifier(currentTerm.column || "") ||
        this.normalizeSQLiteExpression(term.expression, identifiers) !==
          this.normalizeSQLiteExpression(currentTerm.expression, identifiers) ||
        normalizeSQLiteIdentifier(
          typeof term.collation === "string" ? term.collation : "BINARY"
        ) !== normalizeSQLiteIdentifier(
          typeof currentTerm.collation === "string"
            ? currentTerm.collation
            : "BINARY"
        ) ||
        (term.order || "ASC") !== (currentTerm.order || "ASC")) {
        return true;
      }
    }

    return false;
  }

  private generateCreateTable(table: Table): string {
    if (table.createStatement?.trim()) {
      const createStatement = replaceSQLiteCreateTableName(
        table.createStatement.trim().replace(/;+\s*$/g, ""),
        table.name
      );
      if (!createStatement) {
        throw new Error(`Unable to rewrite CREATE TABLE statement for "${table.name}"`);
      }
      return `${createStatement};`;
    }

    const parts: string[] = [];

    for (const col of table.columns) {
      parts.push(this.generateColumnDefinition(col));
    }

    if (table.primaryKey && table.primaryKey.columns.length > 0) {
      const pkCols = this.quoteIdentifiers(table.primaryKey.columns);
      parts.push(`PRIMARY KEY (${pkCols})`);
    }

    for (const fk of table.foreignKeys || []) {
      const fkCols = this.quoteIdentifiers(fk.columns);
      const refCols = this.quoteIdentifiers(fk.referencedColumns);
      let fkDef = `FOREIGN KEY (${fkCols}) REFERENCES ${this.quoteIdentifier(fk.referencedTable)} (${refCols})`;
      if (fk.onDelete && fk.onDelete !== 'NO ACTION') {
        fkDef += ` ON DELETE ${fk.onDelete}`;
      }
      if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') {
        fkDef += ` ON UPDATE ${fk.onUpdate}`;
      }
      if (fk.initiallyDeferred) {
        fkDef += " DEFERRABLE INITIALLY DEFERRED";
      }
      parts.push(fkDef);
    }

    for (const uc of table.uniqueConstraints || []) {
      const differ = this;
      const ucCols = uc.columns.map(function (column, index) {
        const quotedColumn = differ.quoteIdentifier(column);
        const collation = uc.collations?.[index];
        return collation
          ? `${quotedColumn} COLLATE ${differ.quoteIdentifier(collation)}`
          : quotedColumn;
      }).join(", ");
      const name = uc.name
        ? `CONSTRAINT ${this.quoteIdentifier(uc.name)} `
        : "";
      parts.push(`${name}UNIQUE (${ucCols})`);
    }

    for (const cc of table.checkConstraints || []) {
      parts.push(`CHECK (${cc.expression})`);
    }

    return `CREATE TABLE ${this.quoteIdentifier(table.name)} (\n${parts.map(p => '  ' + p).join(',\n')}\n);`;
  }

  private generateCreateIndex(index: Index): string {
    if (index.createStatement?.trim()) {
      return `${index.createStatement.trim().replace(/;+\s*$/g, "")};`;
    }

    const unique = index.unique ? 'UNIQUE ' : '';
    const cols = this.quoteIdentifiers(index.columns);
    let sql = `CREATE ${unique}INDEX ${this.quoteIdentifier(index.name)} ON ${this.quoteIdentifier(index.tableName)} (${cols})`;
    if (index.where) {
      sql += ` WHERE ${index.where}`;
    }
    return sql + ';';
  }

  private generateAddColumn(table: Table, column: Column): string {
    const exactDefinition = table.createStatement
      ? extractSQLiteColumnDefinition(table.createStatement, column.name)
      : undefined;
    const definition = exactDefinition
      ? replaceSQLiteColumnDefinitionName(exactDefinition, column.name)
      : this.generateColumnDefinition(column);
    if (!definition) {
      throw new Error(`Unable to rewrite SQLite column definition for "${column.name}"`);
    }
    return `ALTER TABLE ${this.quoteIdentifier(table.name)} ADD COLUMN ${definition};`;
  }

  private generateColumnDefinition(column: Column): string {
    let definition = `${this.quoteIdentifier(column.name)} ${column.type}`;

    if (column.collation) {
      definition += ` COLLATE ${this.quoteIdentifier(column.collation.name)}`;
    }

    if (column.generated) {
      definition += ` GENERATED ALWAYS AS (${column.generated.expression})`;
      definition += column.generated.stored ? " STORED" : " VIRTUAL";
    }
    if (!column.nullable) {
      definition += " NOT NULL";
    }
    if (!column.generated && column.default !== undefined) {
      definition += ` DEFAULT ${column.default}`;
    }

    return definition;
  }

  private generateTableRecreation(
    desired: Table,
    current: Table,
    tempName: string = `_${desired.name}_new`,
    rowidGuardTableName: string = `_${desired.name}_rowid_guard_new`
  ): string[] {
    const statements: string[] = [];
    const nullableRowidPromotion =
      this.getNullableRowidAliasPromotionColumn(desired, current);
    if (nullableRowidPromotion) {
      statements.push(
        ...this.generateNullableRowidPromotionGuard(
          current.name,
          nullableRowidPromotion,
          rowidGuardTableName
        )
      );
    }

    const tempTable = { ...desired, name: tempName };
    statements.push(this.generateCreateTable(tempTable));

    const copyColumns = this.getRecreationCopyColumns(desired, current);

    if (copyColumns.target.length > 0) {
      statements.push(
        `INSERT OR ABORT INTO ${this.quoteIdentifier(tempName)} (${copyColumns.target.join(", ")}) ` +
        `SELECT ${copyColumns.source.join(", ")} FROM ${this.quoteIdentifier(current.name)};`
      );
    }

    if (
      (desired.autoincrementColumns || []).length > 0 &&
      (current.autoincrementColumns || []).length > 0
    ) {
      statements.push(...this.generateSequencePreservation(current.name, tempName));
    }

    statements.push(`DROP TABLE ${this.quoteIdentifier(desired.name)};`);
    statements.push(
      `ALTER TABLE ${this.quoteIdentifier(tempName)} RENAME TO ${this.quoteIdentifier(desired.name)};`
    );

    for (const index of desired.indexes || []) {
      if (!index.constraint) {
        statements.push(this.generateCreateIndex(index));
      }
    }

    return statements;
  }

  private generateNullableRowidPromotionGuard(
    tableName: string,
    columnName: string,
    guardTableName: string
  ): string[] {
    const quotedGuard = this.quoteIdentifier(guardTableName);
    const quotedColumn = this.quoteIdentifier(columnName);
    return [
      `CREATE TABLE ${quotedGuard} (${quotedColumn} INTEGER NOT NULL);`,
      `INSERT INTO ${quotedGuard} (${quotedColumn}) SELECT ${quotedColumn} ` +
        `FROM ${this.quoteIdentifier(tableName)} ` +
        `WHERE ${quotedColumn} IS NULL LIMIT 1;`,
      `DROP TABLE ${quotedGuard};`,
    ];
  }

  private isOrdinaryRowidTable(table: Table): boolean {
    return !table.virtual && !table.withoutRowid;
  }

  private getNullableRowidAliasPromotionColumn(
    desired: Table,
    current: Table
  ): string | undefined {
    const desiredAlias = this.getRowidAlias(desired);
    if (!desiredAlias) {
      return undefined;
    }

    const normalizedDesiredAlias = normalizeSQLiteIdentifier(desiredAlias);
    const currentColumn = current.columns.find(function (column) {
      return normalizeSQLiteIdentifier(column.name) ===
        normalizedDesiredAlias;
    });
    return currentColumn?.nullable ? currentColumn.name : undefined;
  }

  private getRecreationCopyColumns(
    desired: Table,
    current: Table
  ): SQLiteRecreationCopyColumns {
    const desiredRowidAlias = this.getRowidAlias(desired);
    const currentRowidAlias = this.getRowidAlias(current);
    const normalizedDesiredAlias = desiredRowidAlias
      ? normalizeSQLiteIdentifier(desiredRowidAlias)
      : undefined;
    const normalizedCurrentAlias = currentRowidAlias
      ? normalizeSQLiteIdentifier(currentRowidAlias)
      : undefined;
    const currentColumnNames = new Set(
      current.columns.map(function (column) {
        return normalizeSQLiteIdentifier(column.name);
      })
    );
    const promotesExistingColumnToRowidAlias =
      normalizedDesiredAlias !== undefined &&
      normalizedDesiredAlias !== normalizedCurrentAlias &&
      currentColumnNames.has(normalizedDesiredAlias);
    const transfersRowid =
      this.isOrdinaryRowidTable(desired) &&
      this.isOrdinaryRowidTable(current) &&
      !promotesExistingColumnToRowidAlias;
    const target: string[] = [];
    const source: string[] = [];

    if (transfersRowid) {
      const targetRowid = desiredRowidAlias ?? this.getVisibleRowidName(desired);
      const sourceRowid = currentRowidAlias ?? this.getVisibleRowidName(current);
      if (!targetRowid || !sourceRowid) {
        throw new ValidationError(
          `Unable to preserve hidden SQLite ROWID for table "${desired.name}" ` +
          "because all ROWID names are shadowed by declared columns. " +
          "Migrate the table manually or intentionally promote an existing " +
          "INTEGER column to INTEGER PRIMARY KEY",
          desired.name,
          "rowid"
        );
      }
      target.push(this.quoteIdentifier(targetRowid));
      source.push(this.quoteIdentifier(sourceRowid));
    }

    for (const column of desired.columns) {
      const normalizedName = normalizeSQLiteIdentifier(column.name);
      if (
        column.generated ||
        (transfersRowid && normalizedName === normalizedDesiredAlias) ||
        !currentColumnNames.has(normalizedName)
      ) {
        continue;
      }
      const quotedName = this.quoteIdentifier(column.name);
      target.push(quotedName);
      source.push(quotedName);
    }

    return { target, source };
  }

  private getRowidAlias(table: Table): string | undefined {
    if (!this.isOrdinaryRowidTable(table) || table.primaryKey?.columns.length !== 1) {
      return undefined;
    }

    const primaryKeyName = table.primaryKey.columns[0] || "";
    const primaryKeyColumn = table.columns.find(function (column) {
      return normalizeSQLiteIdentifier(column.name) ===
        normalizeSQLiteIdentifier(primaryKeyName);
    });
    if (!primaryKeyColumn) {
      return undefined;
    }

    if (!table.createStatement) {
      return primaryKeyColumn.type.toUpperCase() === "INTEGER"
        ? primaryKeyColumn.name
        : undefined;
    }

    const definition = extractSQLiteColumnDefinition(
      table.createStatement,
      primaryKeyColumn.name
    );
    return definition && isSQLiteRowidAliasColumnDefinition(definition)
      ? primaryKeyColumn.name
      : undefined;
  }

  private getVisibleRowidName(table: Table): string | undefined {
    const declaredNames = new Set(
      table.columns.map(function (column) {
        return normalizeSQLiteIdentifier(column.name);
      })
    );
    return SQLITE_ROWID_NAMES.find(function (name) {
      return !declaredNames.has(name);
    });
  }

  private generateSequencePreservation(tableName: string, tempName: string): string[] {
    const tableValue = this.quoteStringLiteral(tableName);
    const tempValue = this.quoteStringLiteral(tempName);
    return [
      `UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT MAX(seq) FROM sqlite_sequence WHERE name = ${tableValue}), seq)) WHERE name = ${tempValue};`,
      `INSERT INTO sqlite_sequence(name, seq) SELECT ${tempValue}, seq FROM sqlite_sequence WHERE name = ${tableValue} AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ${tempValue});`,
    ];
  }

  private normalizeType(type: string): string {
    return type.toUpperCase();
  }

  private normalizeDefault(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    return value;
  }

  private normalizeSQLiteExpression(
    value: string | undefined,
    identifiers: readonly string[]
  ): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    return this.normalizeSql(
      canonicalizeSQLiteDefinitionIdentifiers(value, identifiers)
    );
  }

  private normalizeSql(value: string | undefined): string | undefined {
    if (value === undefined) {
      return undefined;
    }

    let normalized = "";
    let quote: string | undefined;

    for (let index = 0; index < value.length; index += 1) {
      const character = value[index] || "";
      if (quote) {
        normalized += character;
        if (character === quote) {
          if (value[index + 1] === quote) {
            normalized += quote;
            index += 1;
          } else {
            quote = undefined;
          }
        }
      } else if (character === "'" || character === '"' || character === "`") {
        quote = character;
        normalized += character;
      } else if (character === "[") {
        quote = "]";
        normalized += character;
      } else if (/\s/u.test(character)) {
        if (normalized.length > 0 && !normalized.endsWith(" ")) {
          normalized += " ";
        }
      } else {
        normalized += character;
      }
    }

    return normalized.trim();
  }

  private quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }

  private quoteIdentifiers(values: string[]): string {
    const differ = this;
    return values.map(function (value) {
      return differ.quoteIdentifier(value);
    }).join(", ");
  }

  private quoteStringLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }
}
