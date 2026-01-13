import type { Table, Column, PrimaryKeyConstraint, ForeignKeyConstraint, CheckConstraint, UniqueConstraint, View, Function, Procedure, Trigger, Sequence, EnumType } from "../types/schema";
import { SQLBuilder } from "./sql-builder";
import { expressionsEqual } from "./expression-comparator";

export function splitSchemaTable(qualifiedName: string): [string, string | undefined] {
  const parts = qualifiedName.split('.');
  const [schema, table] = parts;
  if (parts.length === 2 && schema && table) {
    return [table, schema];
  }
  return [qualifiedName, undefined];
}

export function getBareTableName(tableName: string): string {
  const parts = tableName.split('.');
  return parts[parts.length - 1] ?? tableName;
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
    character: "CHAR",
    bpchar: "CHAR",
    text: "TEXT",
    boolean: "BOOLEAN",
    bool: "BOOLEAN",
    "timestamp without time zone": "TIMESTAMP",
    "timestamp with time zone": "TIMESTAMPTZ",
    timestamptz: "TIMESTAMPTZ",
    "time without time zone": "TIME",
    "time with time zone": "TIMETZ",
    timetz: "TIMETZ",
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
    // Floating point types
    real: "FLOAT4",
    float4: "FLOAT4",
    "double precision": "FLOAT8",
    float8: "FLOAT8",
    // BIT types - varbit is alias for bit varying
    "bit varying": "BIT VARYING",
    varbit: "BIT VARYING",
    // SERIAL types normalize to their base integer types
    smallserial: "INT2",
    serial: "INT4",
    bigserial: "INT8",
    SMALLSERIAL: "INT2",
    SERIAL: "INT4",
    BIGSERIAL: "INT8",
  };

  // Handle array types by extracting base type, normalizing it, and adding single []
  // PostgreSQL normalizes all multi-dimensional arrays to single-dimension (e.g. integer[][] -> integer[])
  const arrayMatch = type.match(/^(.+?)(\[\])+$/);
  if (arrayMatch && arrayMatch[1]) {
    const baseType = arrayMatch[1];
    const normalizedBase = normalizeType(baseType);
    return normalizedBase + '[]';
  }

  // Handle VARCHAR with length
  if (type.startsWith("character varying")) {
    return type.replace("character varying", "VARCHAR");
  }

  // Handle CHAR with length (bpchar is PostgreSQL's internal name for CHAR)
  const lowerTypePrefix = type.toLowerCase();
  if (lowerTypePrefix.startsWith("character(") || lowerTypePrefix.startsWith("bpchar(")) {
    return type.replace(/^(character|bpchar)/i, "CHAR");
  }

  // Handle BIT VARYING with length (varbit is PostgreSQL's internal name)
  if (lowerTypePrefix.startsWith("bit varying(") || lowerTypePrefix.startsWith("varbit(")) {
    const match = type.match(/^(bit varying|varbit)\((\d+)\)$/i);
    if (match) {
      return `BIT VARYING(${match[2]})`;
    }
  }

  // Handle NUMERIC/DECIMAL with precision and scale
  if (type.toLowerCase().startsWith("numeric(") || type.toLowerCase().startsWith("decimal(")) {
    // Extract precision and scale: numeric(10,2) -> NUMERIC(10,2)
    const matchWithScale = type.match(/^(numeric|decimal)\((\d+),(\d+)\)$/i);
    if (matchWithScale) {
      return `NUMERIC(${matchWithScale[2]},${matchWithScale[3]})`;
    }
    // PostgreSQL normalizes NUMERIC(10) to NUMERIC(10,0)
    const matchPrecisionOnly = type.match(/^(numeric|decimal)\((\d+)\)$/i);
    if (matchPrecisionOnly) {
      return `NUMERIC(${matchPrecisionOnly[2]},0)`;
    }
  }

  // Normalize to lowercase first for case-insensitive matching
  const lowerType = type.toLowerCase();
  return typeMap[lowerType] || type.toUpperCase();
}

export function normalizeDefault(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  let normalized = value.trim();

  if (normalized.toUpperCase() === 'NULL') {
    return undefined;
  }

  // Strip PostgreSQL's type cast suffix (::typename or ::typename(params) or ::typename[])
  normalized = normalized.replace(/::[a-z_]+(\s+[a-z_]+)*(\([^)]*\))?(\[\])?$/i, '');

  // Handle CAST(expr AS type) syntax
  const castMatch = normalized.match(/^CAST\((.+)\s+AS\s+[a-z_]+(\[\])?\)$/i);
  if (castMatch) {
    normalized = castMatch[1]!.trim();
  }

  normalized = normalized.trim();

  // Strip quotes from numeric literals
  const quotedNumeric = normalized.match(/^'(-?\d+(?:\.\d+)?)'$/);
  if (quotedNumeric) {
    normalized = quotedNumeric[1]!;
  }

  // Strip outer parentheses if the entire expression is wrapped
  // PostgreSQL wraps expression defaults like `1 + 1` as `(1 + 1)`
  while (/^\([^()]*\)$/.test(normalized) || isBalancedOuterParens(normalized)) {
    const inner = normalized.slice(1, -1).trim();
    if (inner === normalized.slice(1, -1).trim()) {
      normalized = inner;
    } else {
      break;
    }
  }

  // Strip pg_catalog. schema prefix from function calls
  normalized = normalized.replace(/\bpg_catalog\./gi, '');

  // Normalize EXTRACT function: EXTRACT(year FROM ...) -> EXTRACT('year' FROM ...)
  // Parser outputs with quotes, DB outputs without quotes
  normalized = normalized.replace(
    /\bEXTRACT\s*\(\s*'?(\w+)'?\s+FROM\s+/gi,
    (_, field) => `EXTRACT('${field.toLowerCase()}' FROM `
  );

  // Strip type casts from function arguments (but NOT regclass used in nextval)
  // COALESCE(NULL::text, 'value'::text) -> COALESCE(NULL, 'value')
  // length('default'::text) -> length('default')
  // But keep: nextval('users_id_seq'::regclass) unchanged
  const upperNorm = normalized.toUpperCase();
  if (!upperNorm.startsWith('NEXTVAL')) {
    // Strip type casts that appear inside function calls (before closing paren or comma)
    normalized = normalized.replace(/::[a-z_]+(\s+[a-z_]+)*(\[[^\]]*\])?(?=\s*[,)])/gi, '');
  }

  // Normalize NOW() to CURRENT_TIMESTAMP (they are equivalent)
  normalized = normalized.replace(/\bnow\(\)/gi, 'CURRENT_TIMESTAMP');

  // Normalize whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

function isBalancedOuterParens(str: string): boolean {
  if (!str.startsWith('(') || !str.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < str.length - 1; i++) {
    if (str[i] === '(') depth++;
    if (str[i] === ')') depth--;
    if (depth === 0) return false;
  }
  return depth === 1;
}

export function normalizeExpression(expr: string): string {
  let normalized = expr
    .replace(/\s+/g, ' ')
    .trim()
    // Strip type casts including multi-word types like "character varying"
    .replace(/::"?[a-z_]+"?(?:\s+[a-z_]+)*(?:\([^)]*\))?(?:\[\])?/gi, '')
    .replace(/\bpg_catalog\./gi, '')
    .replace(/\((-?\d+(?:\.\d+)?)\)/g, '$1')
    .replace(/(?<![a-z0-9_])\(([a-z_][a-z0-9_]*)\)/gi, '$1');

  normalized = normalizeAnyArrayToIn(normalized);
  normalized = normalizeBetween(normalized);
  normalized = normalizeLikeOperator(normalized);

  let prevNormalized: string;
  do {
    prevNormalized = normalized;
    normalized = normalized
      .replace(/\(([a-z_][a-z0-9_]*\s*[<>=!]+\s*-?\d+(?:\.\d+)?)\)/gi, '$1')
      .replace(/\(([a-z_][a-z0-9_]*\s+(?:IS\s+(?:NOT\s+)?NULL|IN\s+\([^)]*\)))\)/gi, '$1')
      .replace(/\(([a-z_][a-z0-9_]*\s+IS\s+NOT\s+NULL\s+AND\s+[^)]+)\)/gi, '$1')
      .replace(/\(([a-z_][a-z0-9_]*\s*\*\s*\([^)]+\))\)/gi, '$1');
  } while (normalized !== prevNormalized);

  while (/^\(.*\)$/.test(normalized)) {
    const inner = normalized.slice(1, -1);
    let depth = 0;
    let balanced = true;
    for (const char of inner) {
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (depth < 0) { balanced = false; break; }
    }
    if (balanced && depth === 0) {
      normalized = inner.trim();
    } else {
      break;
    }
  }
  return normalized.replace(/\s+/g, ' ').trim();
}

function normalizeAnyArrayToIn(expr: string): string {
  // Match: col = ANY (ARRAY[...]) - basic pattern
  // Also matches: col = ANY ((ARRAY[...])) - with extra parens around ARRAY
  // Try the pattern with inner parens first (more specific), then without
  let result = expr;

  // Pattern with inner parens: ANY ((ARRAY[...]))
  const patternWithInnerParens = /(\w+)\s*=\s*ANY\s*\(\s*\(ARRAY\s*\[(.*?)\]\)\s*\)/gi;
  result = result.replace(patternWithInnerParens, (_, col, values) => {
    const cleanedValues = values
      .split(',')
      .map((v: string) => v.trim())
      .join(', ');
    return `${col} IN (${cleanedValues})`;
  });

  // Pattern without inner parens: ANY (ARRAY[...])
  const patternWithoutInnerParens = /(\w+)\s*=\s*ANY\s*\(\s*ARRAY\s*\[(.*?)\]\s*\)/gi;
  result = result.replace(patternWithoutInnerParens, (_, col, values) => {
    const cleanedValues = values
      .split(',')
      .map((v: string) => v.trim())
      .join(', ');
    return `${col} IN (${cleanedValues})`;
  });

  return result;
}

function normalizeBetween(expr: string): string {
  // Match both: (col >= X) AND (col <= Y)  and  col >= X AND col <= Y
  const betweenPattern = /\(?\s*(\w+)\s*>=\s*(\d+)\s*\)?\s*AND\s*\(?\s*\1\s*<=\s*(\d+)\s*\)?/gi;
  return expr.replace(betweenPattern, '$1 BETWEEN $2 AND $3');
}

function normalizeLikeOperator(expr: string): string {
  // PostgreSQL transforms LIKE to ~~ and NOT LIKE to !~~
  // col ~~ 'pattern' -> col LIKE 'pattern'
  // col !~~ 'pattern' -> col NOT LIKE 'pattern'
  let normalized = expr.replace(/(\w+)\s*~~\s*('[^']*')/gi, '$1 LIKE $2');
  normalized = normalized.replace(/(\w+)\s*!~~\s*('[^']*')/gi, '$1 NOT LIKE $2');
  return normalized;
}

export function columnsAreDifferent(desired: Column, current: Column): boolean {
  const normalizedDesiredType = normalizeType(desired.type);
  const normalizedCurrentType = normalizeType(current.type);

  // Map SERIAL types to their base PostgreSQL types
  const serialTypeMap: Record<string, string> = {
    SERIAL: "integer",
    SMALLSERIAL: "smallint",
    BIGSERIAL: "bigint",
  };

  // Map base types to their SERIAL equivalents for reverse lookup
  const baseToSerialMap: Record<string, string> = {
    INTEGER: "SERIAL",
    SMALLINT: "SMALLSERIAL",
    BIGINT: "BIGSERIAL",
  };

  // Special handling for SERIAL-like columns (SERIAL, SMALLSERIAL, BIGSERIAL)
  // These become integer/smallint/bigint with nextval() default in database
  const desiredUpperType = desired.type.toUpperCase();
  const isDesiredSerial = ["SERIAL", "SMALLSERIAL", "BIGSERIAL"].includes(desiredUpperType);
  if (isDesiredSerial && normalizedDesiredType === normalizedCurrentType) {
    if (current.default?.includes("nextval")) {
      // Serial columns are implicitly NOT NULL, so desired.nullable being undefined means NOT NULL
      const desiredIsNotNull = desired.nullable === false || desired.nullable === undefined;
      const currentIsNotNull = current.nullable === false;
      return desiredIsNotNull !== currentIsNotNull;
    }
  }

  // If desired is a base integer type and current has nextval default,
  // the current column is actually a SERIAL type that we want to convert to plain integer
  const isDesiredBaseInt = ["INT2", "INT4", "INT8", "SMALLINT", "INTEGER", "BIGINT"].includes(desiredUpperType);
  if (isDesiredBaseInt && current.default?.includes("nextval")) {
    if (normalizedDesiredType === normalizedCurrentType) {
      return true; // Need to modify to remove the SERIAL behavior (drop default)
    }
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
    // Special case: SERIAL-like columns with nextval defaults are expected
    const serialTypes = ["SERIAL", "SMALLSERIAL", "BIGSERIAL"];
    if (serialTypes.includes(desired.type.toUpperCase()) && current.default?.includes("nextval")) {
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
      !expressionsEqual(desired.generated.expression, current.generated.expression)
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
