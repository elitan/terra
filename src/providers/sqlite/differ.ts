import type { Table, Column, Index, ForeignKeyConstraint, CheckConstraint } from "../../types/schema";
import type { MigrationPlan } from "../../types/migration";

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
}

export class SQLiteDiffer {
  generateMigrationPlan(desired: Table[], current: Table[]): MigrationPlan {
    const statements: string[] = [];
    const currentMap = new Map(current.map(t => [t.name, t]));
    const desiredMap = new Map(desired.map(t => [t.name, t]));

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
          statements.push(...this.generateTableRecreation(table, currentTable));
        } else {
          for (const change of changes.columnChanges) {
            if (change.type === 'add') {
              statements.push(this.generateAddColumn(table.name, change.column));
            }
          }
          for (const index of changes.indexesToDrop) {
            statements.push(`DROP INDEX IF EXISTS "${index.name}";`);
          }
          for (const index of changes.indexesToAdd) {
            statements.push(this.generateCreateIndex(index));
          }
        }
      }
    }

    for (const table of current) {
      if (!desiredMap.has(table.name)) {
        statements.push(`DROP TABLE IF EXISTS "${table.name}";`);
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
    };

    const currentColMap = new Map(current.columns.map(c => [c.name, c]));
    const desiredColMap = new Map(desired.columns.map(c => [c.name, c]));

    for (const col of desired.columns) {
      const currentCol = currentColMap.get(col.name);
      if (!currentCol) {
        changes.columnChanges.push({ type: 'add', column: col });
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
      if (dSorted[i].columns.join(',') !== cSorted[i].columns.join(',')) return true;
      if (dSorted[i].referencedTable !== cSorted[i].referencedTable) return true;
      if (dSorted[i].referencedColumns.join(',') !== cSorted[i].referencedColumns.join(',')) return true;
      if (dSorted[i].onDelete !== cSorted[i].onDelete) return true;
      if (dSorted[i].onUpdate !== cSorted[i].onUpdate) return true;
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

  private indexesDiffer(desired: Index, current: Index): boolean {
    if (desired.columns.join(',') !== current.columns.join(',')) return true;
    if (desired.unique !== current.unique) return true;
    if (desired.where !== current.where) return true;
    return false;
  }

  private generateCreateTable(table: Table): string {
    const parts: string[] = [];

    for (const col of table.columns) {
      let colDef = `"${col.name}" ${col.type}`;
      if (!col.nullable) {
        colDef += ' NOT NULL';
      }
      if (col.default !== undefined) {
        colDef += ` DEFAULT ${col.default}`;
      }
      parts.push(colDef);
    }

    if (table.primaryKey && table.primaryKey.columns.length > 0) {
      const pkCols = table.primaryKey.columns.map(c => `"${c}"`).join(', ');
      parts.push(`PRIMARY KEY (${pkCols})`);
    }

    for (const fk of table.foreignKeys || []) {
      const fkCols = fk.columns.map(c => `"${c}"`).join(', ');
      const refCols = fk.referencedColumns.map(c => `"${c}"`).join(', ');
      let fkDef = `FOREIGN KEY (${fkCols}) REFERENCES "${fk.referencedTable}" (${refCols})`;
      if (fk.onDelete && fk.onDelete !== 'NO ACTION') {
        fkDef += ` ON DELETE ${fk.onDelete}`;
      }
      if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') {
        fkDef += ` ON UPDATE ${fk.onUpdate}`;
      }
      parts.push(fkDef);
    }

    for (const uc of table.uniqueConstraints || []) {
      const ucCols = uc.columns.map(c => `"${c}"`).join(', ');
      parts.push(`UNIQUE (${ucCols})`);
    }

    for (const cc of table.checkConstraints || []) {
      parts.push(`CHECK (${cc.expression})`);
    }

    return `CREATE TABLE "${table.name}" (\n${parts.map(p => '  ' + p).join(',\n')}\n);`;
  }

  private generateCreateIndex(index: Index): string {
    const unique = index.unique ? 'UNIQUE ' : '';
    const cols = index.columns.map(c => `"${c}"`).join(', ');
    let sql = `CREATE ${unique}INDEX "${index.name}" ON "${index.tableName}" (${cols})`;
    if (index.where) {
      sql += ` WHERE ${index.where}`;
    }
    return sql + ';';
  }

  private generateAddColumn(tableName: string, column: Column): string {
    let colDef = `"${column.name}" ${column.type}`;
    if (!column.nullable) {
      colDef += ' NOT NULL';
    }
    if (column.default !== undefined) {
      colDef += ` DEFAULT ${column.default}`;
    }
    return `ALTER TABLE "${tableName}" ADD COLUMN ${colDef};`;
  }

  private generateTableRecreation(desired: Table, current: Table): string[] {
    const statements: string[] = [];
    const tempName = `_${desired.name}_new`;

    const tempTable = { ...desired, name: tempName };
    statements.push(this.generateCreateTable(tempTable));

    const commonColumns = desired.columns
      .filter(c => current.columns.some(cc => cc.name === c.name))
      .map(c => `"${c.name}"`)
      .join(', ');

    if (commonColumns) {
      statements.push(
        `INSERT INTO "${tempName}" (${commonColumns}) SELECT ${commonColumns} FROM "${desired.name}";`
      );
    }

    statements.push(`DROP TABLE "${desired.name}";`);
    statements.push(`ALTER TABLE "${tempName}" RENAME TO "${desired.name}";`);

    for (const index of desired.indexes || []) {
      if (!index.constraint) {
        statements.push(this.generateCreateIndex(index));
      }
    }

    return statements;
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
}
