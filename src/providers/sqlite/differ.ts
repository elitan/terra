import type {
  Table,
  Column,
  Index,
  IndexTerm,
  ForeignKeyConstraint,
  CheckConstraint,
} from "../../types/schema";
import type { MigrationPlan } from "../../types/migration";
import {
  extractSQLiteColumnDefinition,
  parseSQLiteTableDefinition,
  removeSQLiteForeignKeyTargetColumns,
  replaceSQLiteColumnDefinitionName,
  replaceSQLiteCreateTableName,
} from "./sql-parser-utils";
import { chooseSQLiteRecreationTableName } from "../../utils/sqlite-recreation";

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

export class SQLiteDiffer {
  generateMigrationPlan(desired: Table[], current: Table[]): MigrationPlan {
    const statements: string[] = [];
    const currentMap = new Map(current.map(t => [t.name, t]));
    const desiredMap = new Map(desired.map(t => [t.name, t]));
    const occupiedSchemaNames = new Set<string>();
    for (const table of [...desired, ...current]) {
      occupiedSchemaNames.add(table.name);
      for (const index of table.indexes || []) {
        occupiedSchemaNames.add(index.name);
      }
    }

    for (const table of desired) {
      const currentTable = currentMap.get(table.name);

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
          statements.push(
            ...this.generateTableRecreation(
              table,
              currentTable,
              temporaryTableName
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
      if (!desiredMap.has(table.name)) {
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

    const currentColMap = new Map(current.columns.map(c => [c.name, c]));
    const desiredColMap = new Map(desired.columns.map(c => [c.name, c]));

    for (const col of desired.columns) {
      const currentCol = currentColMap.get(col.name);
      if (!currentCol) {
        changes.columnChanges.push({ type: 'add', column: col });
        if (col.generated?.stored) {
          changes.requiresRecreate = true;
        }
      } else if (this.columnsDiffer(col, currentCol)) {
        changes.requiresRecreate = true;
        changes.columnChanges.push({ type: 'modify', column: col, oldColumn: currentCol });
      }
    }

    for (const col of current.columns) {
      if (!desiredColMap.has(col.name)) {
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

    if (this.checkConstraintsDiffer(desired.checkConstraints, current.checkConstraints)) {
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

    if (this.tableDefinitionsDiffer(desired, current)) {
      changes.requiresRecreate = true;
    }

    const currentIndexMap = new Map((current.indexes || []).map(i => [i.name, i]));
    const desiredIndexMap = new Map((desired.indexes || []).map(i => [i.name, i]));

    for (const index of desired.indexes || []) {
      if (!index.constraint) {
        const currentIndex = currentIndexMap.get(index.name);
        if (!currentIndex || this.indexesDiffer(index, currentIndex)) {
          changes.indexesToAdd.push(index);
          if (currentIndex) {
            changes.indexesToDrop.push(currentIndex);
          }
        }
      }
    }

    for (const index of current.indexes || []) {
      if (!index.constraint && !desiredIndexMap.has(index.name)) {
        changes.indexesToDrop.push(index);
      }
    }

    return changes;
  }

  private columnsDiffer(desired: Column, current: Column): boolean {
    if (this.normalizeType(desired.type) !== this.normalizeType(current.type)) {
      return true;
    }
    if (desired.nullable !== current.nullable) {
      return true;
    }
    if (this.normalizeDefault(desired.default) !== this.normalizeDefault(current.default)) {
      return true;
    }
    if (desired.generated || current.generated) {
      if (!desired.generated || !current.generated) {
        return true;
      }
      if (
        desired.generated.stored !== current.generated.stored ||
        desired.generated.expression.trim() !== current.generated.expression.trim()
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
    return desiredPk.some((col, i) => col !== currentPk[i]);
  }

  private foreignKeysDiffer(desired?: ForeignKeyConstraint[], current?: ForeignKeyConstraint[]): boolean {
    const d = desired || [];
    const c = current || [];
    if (d.length !== c.length) return true;

    const dSorted = [...d].sort((a, b) => a.columns.join(',').localeCompare(b.columns.join(',')));
    const cSorted = [...c].sort((a, b) => a.columns.join(',').localeCompare(b.columns.join(',')));

    for (let i = 0; i < dSorted.length; i++) {
      const dItem = dSorted[i]!;
      const cItem = cSorted[i]!;
      if (dItem.columns.join(',') !== cItem.columns.join(',')) return true;
      if (dItem.referencedTable !== cItem.referencedTable) return true;
      if (dItem.referencedColumns.join(',') !== cItem.referencedColumns.join(',')) return true;
      if (dItem.onDelete !== cItem.onDelete) return true;
      if (dItem.onUpdate !== cItem.onUpdate) return true;
    }

    return false;
  }

  private checkConstraintsDiffer(desired?: CheckConstraint[], current?: CheckConstraint[]): boolean {
    const d = desired || [];
    const c = current || [];
    if (d.length !== c.length) return true;

    const dExprs = d.map(x => x.expression).sort();
    const cExprs = c.map(x => x.expression).sort();

    return dExprs.some((expr, i) => expr !== cExprs[i]);
  }

  private uniqueConstraintsDiffer(
    desired: Table["uniqueConstraints"],
    current: Table["uniqueConstraints"]
  ): boolean {
    const desiredColumns = (desired || [])
      .map(function (constraint) {
        return constraint.columns.join("\0");
      })
      .sort();
    const currentColumns = (current || [])
      .map(function (constraint) {
        return constraint.columns.join("\0");
      })
      .sort();

    if (desiredColumns.length !== currentColumns.length) {
      return true;
    }
    return desiredColumns.some(function (columns, index) {
      return columns !== currentColumns[index];
    });
  }

  private indexesDiffer(desired: Index, current: Index): boolean {
    if (desired.terms || current.terms) {
      if (!desired.terms || !current.terms) {
        return true;
      }
      if (this.indexTermsDiffer(desired.terms, current.terms)) {
        return true;
      }
    } else if (desired.columns.join(',') !== current.columns.join(',')) {
      return true;
    }
    if (desired.unique !== current.unique) return true;
    if (this.normalizeSql(desired.where) !== this.normalizeSql(current.where)) return true;
    return false;
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

    const desiredAutoincrement = [...(desired.autoincrementColumns || [])].sort();
    const currentAutoincrement = [...(current.autoincrementColumns || [])].sort();
    return desiredAutoincrement.join("\0") !== currentAutoincrement.join("\0");
  }

  private tableDefinitionsDiffer(desired: Table, current: Table): boolean {
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
      return this.normalizeSql(desiredStatement) !==
        this.normalizeSql(currentStatement);
    }

    const desiredDefinition = parseSQLiteTableDefinition(desired.createStatement);
    const currentDefinition = parseSQLiteTableDefinition(current.createStatement);
    const currentColumns = new Map(
      currentDefinition.columns.map(function (column) {
        return [column.name, column.definition] as const;
      })
    );

    for (const column of desiredDefinition.columns) {
      const currentColumn = currentColumns.get(column.name);
      if (!currentColumn) {
        continue;
      }
      const desiredCanonical = replaceSQLiteColumnDefinitionName(
        removeSQLiteForeignKeyTargetColumns(column.definition),
        "__terradb_column__"
      );
      const currentCanonical = replaceSQLiteColumnDefinitionName(
        removeSQLiteForeignKeyTargetColumns(currentColumn),
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
      desiredDefinition.constraints
    );
    const currentConstraints = this.normalizeDefinitions(
      currentDefinition.constraints
    );
    return desiredConstraints.join("\0") !== currentConstraints.join("\0");
  }

  private normalizeDefinitions(definitions: string[]): string[] {
    const differ = this;
    return definitions.map(function (definition) {
      return differ.normalizeSql(
        removeSQLiteForeignKeyTargetColumns(definition)
      ) || "";
    }).sort();
  }

  private indexTermsDiffer(desired: IndexTerm[], current: IndexTerm[]): boolean {
    if (desired.length !== current.length) {
      return true;
    }

    for (let index = 0; index < desired.length; index += 1) {
      const term = desired[index]!;
      const currentTerm = current[index];
      if (!currentTerm ||
        term.column !== currentTerm.column ||
        this.normalizeSql(term.expression) !== this.normalizeSql(currentTerm.expression) ||
        (term.collation || "BINARY").toUpperCase() !==
          (currentTerm.collation || "BINARY").toUpperCase() ||
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
      parts.push(fkDef);
    }

    for (const uc of table.uniqueConstraints || []) {
      const ucCols = this.quoteIdentifiers(uc.columns);
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
    tempName: string = `_${desired.name}_new`
  ): string[] {
    const statements: string[] = [];

    const tempTable = { ...desired, name: tempName };
    statements.push(this.generateCreateTable(tempTable));

    const differ = this;
    const commonColumns = desired.columns
      .filter(c => !c.generated && current.columns.some(cc => cc.name === c.name))
      .map(function (column) {
        return differ.quoteIdentifier(column.name);
      })
      .join(', ');

    if (commonColumns) {
      statements.push(
        `INSERT INTO ${this.quoteIdentifier(tempName)} (${commonColumns}) SELECT ${commonColumns} FROM ${this.quoteIdentifier(desired.name)};`
      );
    }

    if (
      (desired.autoincrementColumns || []).length > 0 &&
      (current.autoincrementColumns || []).length > 0
    ) {
      statements.push(...this.generateSequencePreservation(desired.name, tempName));
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

  private generateSequencePreservation(tableName: string, tempName: string): string[] {
    const tableValue = this.quoteStringLiteral(tableName);
    const tempValue = this.quoteStringLiteral(tempName);
    return [
      `UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT MAX(seq) FROM sqlite_sequence WHERE name = ${tableValue}), seq)) WHERE name = ${tempValue};`,
      `INSERT INTO sqlite_sequence(name, seq) SELECT ${tempValue}, seq FROM sqlite_sequence WHERE name = ${tableValue} AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ${tempValue});`,
    ];
  }

  private normalizeType(type: string): string {
    const upper = type.toUpperCase();
    if (upper === 'INT') return 'INTEGER';
    return upper;
  }

  private normalizeDefault(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    return value;
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
