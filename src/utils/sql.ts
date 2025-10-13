import type { Table, Column, PrimaryKeyConstraint, ForeignKeyConstraint, CheckConstraint, UniqueConstraint, View, Function, Procedure, Trigger, Sequence } from "../types/schema";

export function normalizeType(type: string): string {
  // Normalize PostgreSQL types to match our parsed types
  const typeMap: Record<string, string> = {
    "character varying": "VARCHAR",
    text: "TEXT",
    boolean: "BOOLEAN",
    "timestamp without time zone": "TIMESTAMP",
    // PostgreSQL treats INT and INTEGER as the same type
    int: "INTEGER",
    int2: "SMALLINT",
    int4: "INTEGER",
    int8: "BIGINT",
    smallint: "SMALLINT",
    bigint: "BIGINT",
  };

  // Handle VARCHAR with length
  if (type.startsWith("character varying")) {
    return type.replace("character varying", "VARCHAR");
  }

  // Normalize to lowercase first for case-insensitive matching
  const lowerType = type.toLowerCase();
  return typeMap[lowerType] || type.toUpperCase();
}

export function normalizeDefault(value: string | null | undefined): string | undefined {
  // Treat null and undefined as "no default"
  if (value === null || value === undefined) {
    return undefined;
  }

  // Trim first to handle leading/trailing whitespace
  let normalized = value.trim();

  // Treat the string "NULL" as equivalent to undefined (no explicit default)
  // PostgreSQL stores DEFAULT NULL as null in column_default
  if (normalized.toUpperCase() === 'NULL') {
    return undefined;
  }

  // Strip PostgreSQL's type cast suffix (::typename or ::typename(params))
  // This regex handles multi-word types like "timestamp without time zone" and "character varying"
  // Examples: '100::integer', 'hello'::character varying', 'CURRENT_TIMESTAMP::timestamp without time zone'
  normalized = normalized.replace(/::[a-z_]+(\s+[a-z_]+)*(\([^)]*\))?$/i, '');

  return normalized.trim();
}

export function columnsAreDifferent(desired: Column, current: Column): boolean {
  const normalizedDesiredType = normalizeType(desired.type);
  const normalizedCurrentType = normalizeType(current.type);

  // Special handling for SERIAL columns
  // SERIAL in schema becomes integer with nextval() default in database
  if (desired.type === "SERIAL" && current.type === "integer") {
    // SERIAL columns are expected to become integer with nextval default
    if (current.default?.includes("nextval")) {
      // Check if nullability is consistent (SERIAL is NOT NULL by default)
      const nullabilityMatches = desired.nullable === current.nullable;
      return !nullabilityMatches;
    }
  }

  // If desired is INTEGER and current is INTEGER, but current has nextval default,
  // the current column is actually a SERIAL that we want to convert to plain INTEGER
  if (
    desired.type === "INTEGER" &&
    current.type === "integer" &&
    current.default?.includes("nextval")
  ) {
    return true; // Need to modify to remove the SERIAL behavior
  }

  // Check if types are different
  if (normalizedDesiredType !== normalizedCurrentType) {
    return true;
  }

  // Check if nullability is different
  if (desired.nullable !== current.nullable) {
    return true;
  }

  // Check if defaults are different
  // Normalize defaults to handle PostgreSQL's type cast annotations (::typename)
  const currentDefault = normalizeDefault(current.default);
  const desiredDefault = normalizeDefault(desired.default);

  // Only consider it different if one has a non-null/non-undefined default and the other doesn't
  if (currentDefault !== desiredDefault) {
    // Special case: SERIAL columns with nextval defaults are expected
    if (desired.type === "SERIAL" && current.default?.includes("nextval")) {
      return false;
    }
    return true;
  }

  return false;
}

export function generateCreateTableStatement(table: Table): string {
  const columnDefs = table.columns.map((col) => {
    let def = `${col.name} ${col.type}`;
    if (!col.nullable) def += " NOT NULL";
    if (col.default) def += ` DEFAULT ${col.default}`;
    return def;
  });

  // Add primary key constraint if it exists
  if (table.primaryKey) {
    const primaryKeyClause = generatePrimaryKeyClause(table.primaryKey);
    columnDefs.push(primaryKeyClause);
  }

  // Add check constraints if they exist
  if (table.checkConstraints) {
    for (const checkConstraint of table.checkConstraints) {
      const checkClause = generateCheckConstraintClause(checkConstraint);
      columnDefs.push(checkClause);
    }
  }

  // Add unique constraints if they exist
  if (table.uniqueConstraints) {
    for (const uniqueConstraint of table.uniqueConstraints) {
      const uniqueClause = generateUniqueConstraintClause(uniqueConstraint);
      columnDefs.push(uniqueClause);
    }
  }

  return `CREATE TABLE ${table.name} (\n  ${columnDefs.join(",\n  ")}\n);`;
}

export function generatePrimaryKeyClause(
  primaryKey: PrimaryKeyConstraint
): string {
  const columns = primaryKey.columns.join(", ");

  if (primaryKey.name) {
    return `CONSTRAINT ${primaryKey.name} PRIMARY KEY (${columns})`;
  } else {
    return `PRIMARY KEY (${columns})`;
  }
}

export function generateAddPrimaryKeySQL(
  tableName: string,
  primaryKey: PrimaryKeyConstraint
): string {
  const constraintName = primaryKey.name || `pk_${tableName}`;
  const columns = primaryKey.columns.join(", ");
  return `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} PRIMARY KEY (${columns});`;
}

export function generateDropPrimaryKeySQL(
  tableName: string,
  constraintName: string
): string {
  return `ALTER TABLE ${tableName} DROP CONSTRAINT ${constraintName};`;
}

// Foreign Key SQL generation
export function generateAddForeignKeySQL(
  tableName: string,
  foreignKey: ForeignKeyConstraint
): string {
  const constraintName = foreignKey.name || `fk_${tableName}_${foreignKey.referencedTable}`;
  const columns = foreignKey.columns.join(", ");
  const referencedColumns = foreignKey.referencedColumns.join(", ");
  
  let sql = `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${columns}) REFERENCES ${foreignKey.referencedTable}(${referencedColumns})`;
  
  if (foreignKey.onDelete) {
    sql += ` ON DELETE ${foreignKey.onDelete}`;
  }
  
  if (foreignKey.onUpdate) {
    sql += ` ON UPDATE ${foreignKey.onUpdate}`;
  }
  
  return sql + ";";
}

export function generateDropForeignKeySQL(
  tableName: string,
  constraintName: string
): string {
  return `ALTER TABLE ${tableName} DROP CONSTRAINT ${constraintName};`;
}

export function generateForeignKeyClause(foreignKey: ForeignKeyConstraint): string {
  const columns = foreignKey.columns.join(", ");
  const referencedColumns = foreignKey.referencedColumns.join(", ");
  
  let clause = "";
  if (foreignKey.name) {
    clause += `CONSTRAINT ${foreignKey.name} `;
  }
  
  clause += `FOREIGN KEY (${columns}) REFERENCES ${foreignKey.referencedTable}(${referencedColumns})`;
  
  if (foreignKey.onDelete) {
    clause += ` ON DELETE ${foreignKey.onDelete}`;
  }
  
  if (foreignKey.onUpdate) {
    clause += ` ON UPDATE ${foreignKey.onUpdate}`;
  }
  
  return clause;
}

// Check Constraint SQL generation
export function generateAddCheckConstraintSQL(
  tableName: string,
  checkConstraint: CheckConstraint
): string {
  const constraintName = checkConstraint.name || `check_${tableName}_${Date.now()}`;
  return `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} CHECK (${checkConstraint.expression});`;
}

export function generateDropCheckConstraintSQL(
  tableName: string,
  constraintName: string
): string {
  return `ALTER TABLE ${tableName} DROP CONSTRAINT ${constraintName};`;
}

export function generateCheckConstraintClause(checkConstraint: CheckConstraint): string {
  let clause = "";
  if (checkConstraint.name) {
    clause += `CONSTRAINT ${checkConstraint.name} `;
  }
  
  clause += `CHECK (${checkConstraint.expression})`;
  
  return clause;
}

// Unique Constraint SQL generation
export function generateAddUniqueConstraintSQL(
  tableName: string,
  uniqueConstraint: UniqueConstraint
): string {
  const constraintName = uniqueConstraint.name || `unique_${tableName}_${uniqueConstraint.columns.join('_')}`;
  const columns = uniqueConstraint.columns.join(", ");
  return `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} UNIQUE (${columns});`;
}

export function generateDropUniqueConstraintSQL(
  tableName: string,
  constraintName: string
): string {
  return `ALTER TABLE ${tableName} DROP CONSTRAINT ${constraintName};`;
}

export function generateUniqueConstraintClause(uniqueConstraint: UniqueConstraint): string {
  const columns = uniqueConstraint.columns.join(", ");
  
  let clause = "";
  if (uniqueConstraint.name) {
    clause += `CONSTRAINT ${uniqueConstraint.name} `;
  }
  
  clause += `UNIQUE (${columns})`;
  
  return clause;
}

// VIEW SQL generation functions
export function generateCreateViewSQL(view: View): string {
  let sql = "CREATE ";
  
  if (view.materialized) {
    sql += "MATERIALIZED ";
  }
  
  sql += `VIEW ${view.name} AS ${view.definition}`;
  
  // Add WITH CHECK OPTION if specified (not for materialized views)
  if (view.checkOption && !view.materialized) {
    sql += ` WITH ${view.checkOption} CHECK OPTION`;
  }
  
  return sql + ";";
}

export function generateDropViewSQL(viewName: string, materialized?: boolean): string {
  let sql = "DROP ";
  
  if (materialized) {
    sql += "MATERIALIZED ";
  }
  
  sql += `VIEW IF EXISTS ${viewName}`;
  
  return sql + ";";
}

export function generateCreateOrReplaceViewSQL(view: View): string {
  if (view.materialized) {
    // CREATE OR REPLACE doesn't work with materialized views
    // We need to drop and recreate
    return generateDropViewSQL(view.name, true) + "\n" + generateCreateViewSQL(view);
  }
  
  let sql = "CREATE OR REPLACE VIEW ";
  sql += `${view.name} AS ${view.definition}`;
  
  // Add WITH CHECK OPTION if specified
  if (view.checkOption) {
    sql += ` WITH ${view.checkOption} CHECK OPTION`;
  }
  
  return sql + ";";
}

export function generateRefreshMaterializedViewSQL(viewName: string, concurrently: boolean = false): string {
  let sql = "REFRESH MATERIALIZED VIEW ";

  if (concurrently) {
    sql += "CONCURRENTLY ";
  }

  sql += viewName;

  return sql + ";";
}

// FUNCTION SQL generation functions
export function generateCreateFunctionSQL(func: Function): string {
  let sql = `CREATE FUNCTION ${func.name}(`;

  // Add parameters
  if (func.parameters.length > 0) {
    const params = func.parameters.map(p => {
      let param = "";
      if (p.mode) param += `${p.mode} `;
      if (p.name) param += `${p.name} `;
      param += p.type;
      if (p.default) param += ` DEFAULT ${p.default}`;
      return param;
    });
    sql += params.join(", ");
  }

  sql += `) RETURNS ${func.returnType}`;
  sql += ` AS $$ ${func.body} $$`;
  sql += ` LANGUAGE ${func.language}`;

  if (func.volatility) {
    sql += ` ${func.volatility}`;
  }

  if (func.parallel) {
    sql += ` PARALLEL ${func.parallel}`;
  }

  if (func.securityDefiner) {
    sql += " SECURITY DEFINER";
  }

  if (func.strict) {
    sql += " STRICT";
  }

  if (func.cost !== undefined) {
    sql += ` COST ${func.cost}`;
  }

  if (func.rows !== undefined) {
    sql += ` ROWS ${func.rows}`;
  }

  return sql + ";";
}

export function generateDropFunctionSQL(func: Function): string {
  const paramTypes = func.parameters.map(p => p.type).join(", ");
  return `DROP FUNCTION IF EXISTS ${func.name}(${paramTypes});`;
}

// PROCEDURE SQL generation functions
export function generateCreateProcedureSQL(proc: Procedure): string {
  let sql = `CREATE PROCEDURE ${proc.name}(`;

  // Add parameters
  if (proc.parameters.length > 0) {
    const params = proc.parameters.map(p => {
      let param = "";
      if (p.mode) param += `${p.mode} `;
      if (p.name) param += `${p.name} `;
      param += p.type;
      if (p.default) param += ` DEFAULT ${p.default}`;
      return param;
    });
    sql += params.join(", ");
  }

  sql += `) LANGUAGE ${proc.language}`;
  sql += ` AS $$ ${proc.body} $$`;

  if (proc.securityDefiner) {
    sql += " SECURITY DEFINER";
  }

  return sql + ";";
}

export function generateDropProcedureSQL(proc: Procedure): string {
  const paramTypes = proc.parameters.map(p => p.type).join(", ");
  return `DROP PROCEDURE IF EXISTS ${proc.name}(${paramTypes});`;
}

// TRIGGER SQL generation functions
export function generateCreateTriggerSQL(trigger: Trigger): string {
  let sql = `CREATE TRIGGER ${trigger.name}`;
  sql += ` ${trigger.timing}`;
  sql += ` ${trigger.events.join(" OR ")}`;
  sql += ` ON ${trigger.tableName}`;

  if (trigger.forEach) {
    sql += ` FOR EACH ${trigger.forEach}`;
  }

  if (trigger.when) {
    sql += ` WHEN (${trigger.when})`;
  }

  sql += ` EXECUTE FUNCTION ${trigger.functionName}(`;
  if (trigger.functionArgs && trigger.functionArgs.length > 0) {
    sql += trigger.functionArgs.join(", ");
  }
  sql += ")";

  return sql + ";";
}

export function generateDropTriggerSQL(trigger: Trigger): string {
  return `DROP TRIGGER IF EXISTS ${trigger.name} ON ${trigger.tableName};`;
}

// SEQUENCE SQL generation functions
export function generateCreateSequenceSQL(seq: Sequence): string {
  let sql = `CREATE SEQUENCE ${seq.name}`;

  if (seq.dataType) {
    sql += ` AS ${seq.dataType}`;
  }

  if (seq.increment !== undefined) {
    sql += ` INCREMENT ${seq.increment}`;
  }

  if (seq.minValue !== undefined) {
    sql += ` MINVALUE ${seq.minValue}`;
  }

  if (seq.maxValue !== undefined) {
    sql += ` MAXVALUE ${seq.maxValue}`;
  }

  if (seq.start !== undefined) {
    sql += ` START ${seq.start}`;
  }

  if (seq.cache !== undefined) {
    sql += ` CACHE ${seq.cache}`;
  }

  if (seq.cycle !== undefined) {
    sql += seq.cycle ? " CYCLE" : " NO CYCLE";
  }

  if (seq.ownedBy) {
    sql += ` OWNED BY ${seq.ownedBy}`;
  }

  return sql + ";";
}

export function generateDropSequenceSQL(sequenceName: string): string {
  return `DROP SEQUENCE IF EXISTS ${sequenceName};`;
}
