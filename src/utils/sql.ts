import type { Table, Column, PrimaryKeyConstraint, ForeignKeyConstraint, CheckConstraint, UniqueConstraint, View, Function, Procedure, Trigger, Sequence, EnumType } from "../types/schema";
import { SQLBuilder } from "./sql-builder";

export function splitSchemaTable(qualifiedName: string): [string, string | undefined] {
  const parts = qualifiedName.split('.');
  if (parts.length === 2) {
    return [parts[1], parts[0]];
  }
  return [qualifiedName, undefined];
}

export function getBareTableName(tableName: string): string {
  const parts = tableName.split('.');
  return parts[parts.length - 1];
}

/**
 * Get qualified table name with schema prefix if present
 */
export function getQualifiedTableName(table: Table | string, schema?: string): string {
  if (typeof table === 'string') {
    return schema ? `${schema}.${table}` : table;
  }
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

export function normalizeType(type: string): string {
  // Normalize PostgreSQL types to match our parsed types
  const typeMap: Record<string, string> = {
    "character varying": "VARCHAR",
    text: "TEXT",
    boolean: "BOOLEAN",
    bool: "BOOLEAN",
    "timestamp without time zone": "TIMESTAMP",
    "timestamp with time zone": "TIMESTAMPTZ",
    timestamptz: "TIMESTAMPTZ",
    // PostgreSQL integer type aliases
    int: "INT4",
    int2: "INT2",
    int4: "INT4",
    int8: "INT8",
    smallint: "INT2",
    integer: "INT4",
    bigint: "INT8",
    // Normalize to internal names to distinguish between sizes
    "INT2": "INT2",
    "INT4": "INT4",
    "INT8": "INT8",
    "SMALLINT": "INT2",
    "INTEGER": "INT4",
    "BIGINT": "INT8",
    // PostgreSQL treats DECIMAL and NUMERIC as the same type
    decimal: "NUMERIC",
  };

  // Handle VARCHAR with length
  if (type.startsWith("character varying")) {
    return type.replace("character varying", "VARCHAR");
  }

  // Handle NUMERIC/DECIMAL with precision and scale
  if (type.toLowerCase().startsWith("numeric(") || type.toLowerCase().startsWith("decimal(")) {
    // Extract precision and scale: numeric(10,2) -> NUMERIC(10,2)
    const match = type.match(/^(numeric|decimal)\((\d+),(\d+)\)$/i);
    if (match) {
      return `NUMERIC(${match[2]},${match[3]})`;
    }
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

  // Check if generated column info is different
  if (desired.generated || current.generated) {
    // If one has generated and the other doesn't, they're different
    if (!desired.generated || !current.generated) {
      return true;
    }

    // Compare generated properties
    if (
      desired.generated.always !== current.generated.always ||
      desired.generated.stored !== current.generated.stored ||
      desired.generated.expression !== current.generated.expression
    ) {
      return true;
    }
  }

  return false;
}

export function generateCreateTableStatement(table: Table): string {
  const columnDefs = table.columns.map((col) => {
    const builder = new SQLBuilder();
    builder.ident(col.name).p(col.type);

    if (col.generated) {
      builder.p(`GENERATED ${col.generated.always ? 'ALWAYS' : 'BY DEFAULT'} AS (${col.generated.expression}) ${col.generated.stored ? 'STORED' : 'VIRTUAL'}`);
    } else {
      if (!col.nullable) builder.p("NOT NULL");
      if (col.default) builder.p(`DEFAULT ${col.default}`);
    }

    return builder.build();
  });

  // Add primary key constraint if it exists
  if (table.primaryKey) {
    const primaryKeyClause = generatePrimaryKeyClause(table.primaryKey, table.name);
    columnDefs.push(primaryKeyClause);
  }

  // Add check constraints if they exist
  if (table.checkConstraints) {
    for (const checkConstraint of table.checkConstraints) {
      const checkClause = generateCheckConstraintClause(checkConstraint, table.name);
      columnDefs.push(checkClause);
    }
  }

  // Add unique constraints if they exist
  if (table.uniqueConstraints) {
    for (const uniqueConstraint of table.uniqueConstraints) {
      const uniqueClause = generateUniqueConstraintClause(uniqueConstraint, table.name);
      columnDefs.push(uniqueClause);
    }
  }

  const builder = new SQLBuilder()
    .p("CREATE TABLE")
    .table(table.name, table.schema)
    .p("(\n  " + columnDefs.join(",\n  ") + "\n)");
  return builder.build() + ";";
}

export function generatePrimaryKeyClause(
  primaryKey: PrimaryKeyConstraint,
  tableName?: string
): string {
  const columns = primaryKey.columns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");
  const bareTable = tableName ? getBareTableName(tableName) : undefined;
  const constraintName = primaryKey.name
    ? primaryKey.name
    : (bareTable ? `${bareTable}_pkey` : undefined);

  if (constraintName) {
    const builder = new SQLBuilder()
      .p("CONSTRAINT")
      .ident(constraintName)
      .p(`PRIMARY KEY (${columns})`);
    return builder.build();
  } else {
    return `PRIMARY KEY (${columns})`;
  }
}

export function generateAddPrimaryKeySQL(
  tableName: string,
  primaryKey: PrimaryKeyConstraint
): string {
  const bareTable = getBareTableName(tableName);
  const constraintName = primaryKey.name || `${bareTable}_pkey`;
  const columns = primaryKey.columns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");

  return new SQLBuilder()
    .p("ALTER TABLE")
    .table(tableName)
    .p("ADD CONSTRAINT")
    .ident(constraintName)
    .p(`PRIMARY KEY (${columns});`)
    .build();
}

export function generateDropPrimaryKeySQL(
  tableName: string,
  constraintName: string
): string {
  return new SQLBuilder()
    .p("ALTER TABLE")
    .table(tableName)
    .p("DROP CONSTRAINT")
    .ident(constraintName)
    .p(";")
    .build();
}

// Foreign Key SQL generation
export function generateAddForeignKeySQL(
  tableName: string,
  foreignKey: ForeignKeyConstraint
): string {
  const constraintName = foreignKey.name || `fk_${tableName}_${foreignKey.referencedTable}`;
  const columns = foreignKey.columns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");
  const referencedColumns = foreignKey.referencedColumns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");

  const builder = new SQLBuilder()
    .p("ALTER TABLE")
    .table(tableName)
    .p("ADD CONSTRAINT")
    .ident(constraintName)
    .p(`FOREIGN KEY (${columns}) REFERENCES`)
    .table(...splitSchemaTable(foreignKey.referencedTable))
    .p(`(${referencedColumns})`);

  if (foreignKey.onDelete) {
    builder.p(`ON DELETE ${foreignKey.onDelete}`);
  }

  if (foreignKey.onUpdate) {
    builder.p(`ON UPDATE ${foreignKey.onUpdate}`);
  }

  return builder.p(";").build();
}

export function generateDropForeignKeySQL(
  tableName: string,
  constraintName: string
): string {
  return new SQLBuilder()
    .p("ALTER TABLE")
    .table(tableName)
    .p("DROP CONSTRAINT")
    .ident(constraintName)
    .p(";")
    .build();
}


// Check Constraint SQL generation
export function generateAddCheckConstraintSQL(
  tableName: string,
  checkConstraint: CheckConstraint
): string {
  const bareTable = getBareTableName(tableName);
  const constraintName = checkConstraint.name || `${bareTable}_check`;
  return new SQLBuilder()
    .p("ALTER TABLE")
    .table(tableName)
    .p("ADD CONSTRAINT")
    .ident(constraintName)
    .p(`CHECK (${checkConstraint.expression});`)
    .build();
}

export function generateDropCheckConstraintSQL(
  tableName: string,
  constraintName: string
): string {
  return new SQLBuilder()
    .p("ALTER TABLE")
    .table(tableName)
    .p("DROP CONSTRAINT")
    .ident(constraintName)
    .p(";")
    .build();
}

export function generateCheckConstraintClause(
  checkConstraint: CheckConstraint,
  tableName?: string
): string {
  const builder = new SQLBuilder();

  if (checkConstraint.name) {
    builder.p("CONSTRAINT").ident(checkConstraint.name);
  }

  builder.p(`CHECK (${checkConstraint.expression})`);

  return builder.build();
}

// Unique Constraint SQL generation
export function generateAddUniqueConstraintSQL(
  tableName: string,
  uniqueConstraint: UniqueConstraint
): string {
  const bareTable = getBareTableName(tableName);
  const constraintName = uniqueConstraint.name || `${bareTable}_${uniqueConstraint.columns.join('_')}_unique`;
  const columns = uniqueConstraint.columns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");
  return new SQLBuilder()
    .p("ALTER TABLE")
    .table(tableName)
    .p("ADD CONSTRAINT")
    .ident(constraintName)
    .p(`UNIQUE (${columns});`)
    .build();
}

export function generateDropUniqueConstraintSQL(
  tableName: string,
  constraintName: string
): string {
  return new SQLBuilder()
    .p("ALTER TABLE")
    .table(tableName)
    .p("DROP CONSTRAINT")
    .ident(constraintName)
    .p(";")
    .build();
}

export function generateUniqueConstraintClause(
  uniqueConstraint: UniqueConstraint,
  tableName?: string
): string {
  const columns = uniqueConstraint.columns.map(col => `"${col.replace(/"/g, '""')}"`).join(", ");
  const bareTable = tableName ? getBareTableName(tableName) : undefined;
  const constraintName = uniqueConstraint.name
    ? uniqueConstraint.name
    : (bareTable ? `${bareTable}_${uniqueConstraint.columns.join('_')}_unique` : undefined);

  const builder = new SQLBuilder();

  if (constraintName) {
    builder.p("CONSTRAINT").ident(constraintName);
  }

  builder.p(`UNIQUE (${columns})`);

  return builder.build();
}

// VIEW SQL generation functions
export function generateCreateViewSQL(view: View): string {
  const builder = new SQLBuilder();

  if (view.materialized) {
    builder.p("CREATE MATERIALIZED VIEW");
  } else {
    builder.p("CREATE VIEW");
  }

  builder.ident(view.name).p(`AS ${view.definition}`);

  // Add WITH CHECK OPTION if specified (not for materialized views)
  if (view.checkOption && !view.materialized) {
    builder.p(`WITH ${view.checkOption} CHECK OPTION`);
  }

  return builder.p(";").build();
}

export function generateDropViewSQL(viewName: string, materialized?: boolean): string {
  const builder = new SQLBuilder();

  if (materialized) {
    builder.p("DROP MATERIALIZED VIEW IF EXISTS");
  } else {
    builder.p("DROP VIEW IF EXISTS");
  }

  return builder.ident(viewName).p(";").build();
}

export function generateCreateOrReplaceViewSQL(view: View): string {
  if (view.materialized) {
    // CREATE OR REPLACE doesn't work with materialized views
    // We need to drop and recreate
    return generateDropViewSQL(view.name, true) + "\n" + generateCreateViewSQL(view);
  }

  const builder = new SQLBuilder()
    .p("CREATE OR REPLACE VIEW")
    .ident(view.name)
    .p(`AS ${view.definition}`);

  // Add WITH CHECK OPTION if specified
  if (view.checkOption) {
    builder.p(`WITH ${view.checkOption} CHECK OPTION`);
  }

  return builder.p(";").build();
}

export function generateRefreshMaterializedViewSQL(viewName: string, concurrently: boolean = false): string {
  const builder = new SQLBuilder();

  if (concurrently) {
    builder.p("REFRESH MATERIALIZED VIEW CONCURRENTLY");
  } else {
    builder.p("REFRESH MATERIALIZED VIEW");
  }

  return builder.ident(viewName).p(";").build();
}

// FUNCTION SQL generation functions
export function generateCreateFunctionSQL(func: Function): string {
  const builder = new SQLBuilder();

  builder.p('CREATE FUNCTION').ident(func.name);
  builder.rewriteLastChar('(');

  // Add parameters
  if (func.parameters.length > 0) {
    const params = func.parameters.map(p => {
      const parts: string[] = [];
      if (p.mode) parts.push(p.mode);
      if (p.name) parts.push(`"${p.name.replace(/"/g, '""')}"`);
      parts.push(p.type);
      if (p.default) parts.push(`DEFAULT ${p.default}`);
      return parts.join(' ');
    });
    builder.p(params.join(', '));
  }

  builder.p(')');
  builder.p(`RETURNS ${func.returnType}`);
  builder.p(`AS $$ ${func.body} $$`);
  builder.p(`LANGUAGE ${func.language}`);

  if (func.volatility) {
    builder.p(func.volatility);
  }

  if (func.parallel) {
    builder.p(`PARALLEL ${func.parallel}`);
  }

  if (func.securityDefiner) {
    builder.p('SECURITY DEFINER');
  }

  if (func.strict) {
    builder.p('STRICT');
  }

  if (func.cost !== undefined) {
    builder.p(`COST ${func.cost}`);
  }

  if (func.rows !== undefined) {
    builder.p(`ROWS ${func.rows}`);
  }

  return builder.build() + ';';
}

export function generateDropFunctionSQL(func: Function): string {
  const paramTypes = func.parameters.map(p => p.type).join(", ");
  // Use CASCADE to automatically drop dependent triggers
  const builder = new SQLBuilder();
  builder.p('DROP FUNCTION IF EXISTS').ident(func.name);
  builder.rewriteLastChar('(');
  builder.p(`${paramTypes}) CASCADE;`);
  return builder.build();
}

// PROCEDURE SQL generation functions
export function generateCreateProcedureSQL(proc: Procedure): string {
  const builder = new SQLBuilder();

  builder.p('CREATE PROCEDURE').ident(proc.name);
  builder.rewriteLastChar('(');

  // Add parameters
  if (proc.parameters.length > 0) {
    const params = proc.parameters.map(p => {
      const parts: string[] = [];
      if (p.mode) parts.push(p.mode);
      if (p.name) parts.push(`"${p.name.replace(/"/g, '""')}"`);
      parts.push(p.type);
      if (p.default) parts.push(`DEFAULT ${p.default}`);
      return parts.join(' ');
    });
    builder.p(params.join(', '));
  }

  builder.p(')');
  builder.p(`LANGUAGE ${proc.language}`);
  builder.p(`AS $$ ${proc.body} $$`);

  if (proc.securityDefiner) {
    builder.p('SECURITY DEFINER');
  }

  return builder.build() + ';';
}

export function generateDropProcedureSQL(proc: Procedure): string {
  const paramTypes = proc.parameters.map(p => p.type).join(", ");
  const builder = new SQLBuilder();
  builder.p('DROP PROCEDURE IF EXISTS').ident(proc.name);
  builder.rewriteLastChar('(');
  builder.p(`${paramTypes});`);
  return builder.build();
}

// TRIGGER SQL generation functions
export function generateCreateTriggerSQL(trigger: Trigger): string {
  const builder = new SQLBuilder();

  builder.p('CREATE TRIGGER').ident(trigger.name);
  builder.p(trigger.timing);
  builder.p(trigger.events.join(" OR "));
  builder.p('ON').ident(trigger.tableName);

  if (trigger.forEach) {
    builder.p(`FOR EACH ${trigger.forEach}`);
  }

  if (trigger.when) {
    builder.p(`WHEN (${trigger.when})`);
  }

  builder.p('EXECUTE FUNCTION').ident(trigger.functionName);
  builder.rewriteLastChar('(');
  if (trigger.functionArgs && trigger.functionArgs.length > 0) {
    builder.p(trigger.functionArgs.join(", "));
  }
  builder.p(')');

  return builder.build() + ';';
}

export function generateDropTriggerSQL(trigger: Trigger): string {
  const builder = new SQLBuilder();
  builder.p('DROP TRIGGER IF EXISTS').ident(trigger.name);
  builder.p('ON').ident(trigger.tableName);
  return builder.p(';').build();
}

// SEQUENCE SQL generation functions
export function generateCreateSequenceSQL(seq: Sequence): string {
  const builder = new SQLBuilder();

  builder.p('CREATE SEQUENCE').ident(seq.name);

  if (seq.dataType) {
    builder.p(`AS ${seq.dataType}`);
  }

  if (seq.increment !== undefined) {
    builder.p(`INCREMENT ${seq.increment}`);
  }

  if (seq.minValue !== undefined) {
    builder.p(`MINVALUE ${seq.minValue}`);
  }

  if (seq.maxValue !== undefined) {
    builder.p(`MAXVALUE ${seq.maxValue}`);
  }

  if (seq.start !== undefined) {
    builder.p(`START ${seq.start}`);
  }

  if (seq.cache !== undefined) {
    builder.p(`CACHE ${seq.cache}`);
  }

  if (seq.cycle !== undefined) {
    builder.p(seq.cycle ? 'CYCLE' : 'NO CYCLE');
  }

  if (seq.ownedBy) {
    builder.p(`OWNED BY ${seq.ownedBy}`);
  }

  return builder.build() + ';';
}

export function generateDropSequenceSQL(sequenceName: string): string {
  const builder = new SQLBuilder();
  builder.p('DROP SEQUENCE IF EXISTS').ident(sequenceName);
  return builder.p(';').build();
}

// ENUM TYPE SQL generation functions
export function generateCreateTypeSQL(enumType: EnumType): string {
  const builder = new SQLBuilder();

  builder.p('CREATE TYPE');
  if (enumType.schema) {
    builder.ident(enumType.schema);
    builder.rewriteLastChar('.');
  }
  builder.ident(enumType.name);

  const values = enumType.values.map(value => `'${value}'`).join(', ');
  builder.p(`AS ENUM (${values});`);

  return builder.build();
}

export function generateDropTypeSQL(typeName: string, schema?: string): string {
  const builder = new SQLBuilder();

  builder.p('DROP TYPE');
  if (schema) {
    builder.ident(schema);
    builder.rewriteLastChar('.');
  }
  builder.ident(typeName);

  return builder.p(';').build();
}
