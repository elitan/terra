import type { Table, Column, PrimaryKeyConstraint } from "../types/schema";

export function normalizeType(type: string): string {
  // Normalize PostgreSQL types to match our parsed types
  const typeMap: Record<string, string> = {
    "character varying": "VARCHAR",
    text: "TEXT",
    boolean: "BOOLEAN",
    "timestamp without time zone": "TIMESTAMP",
  };

  // Handle VARCHAR with length
  if (type.startsWith("character varying")) {
    return type.replace("character varying", "VARCHAR");
  }

  return typeMap[type] || type.toUpperCase();
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
  // Handle null vs undefined defaults - treat null and undefined as equivalent "no default"
  const currentDefault = current.default === null ? undefined : current.default;
  const desiredDefault = desired.default === null ? undefined : desired.default;

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
