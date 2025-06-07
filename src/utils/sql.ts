import type { Table, Column, PrimaryKeyConstraint } from "../types/schema";

export function normalizeType(type: string): string {
  // Normalize PostgreSQL types to match our parsed types
  const typeMap: Record<string, string> = {
    integer: "SERIAL", // SERIAL becomes integer in PostgreSQL
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

  // For SERIAL columns, we expect them to become integer with a default
  if (
    desired.type === "SERIAL" &&
    current.type === "integer" &&
    current.default?.includes("nextval")
  ) {
    return false; // This is expected for SERIAL columns
  }

  return (
    normalizedDesiredType !== normalizedCurrentType ||
    desired.nullable !== current.nullable ||
    (desired.default !== current.default &&
      !(desired.type === "SERIAL" && current.default?.includes("nextval")))
  );
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
