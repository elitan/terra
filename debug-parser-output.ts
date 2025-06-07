import { SchemaParser } from "./src/core/schema/parser";

console.log("🔍 Debugging CST Parser Output...");

const parser = new SchemaParser();

const testSQL = `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255)
);

CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price DECIMAL(10,2) DEFAULT 0.00
);
`;

console.log("Input SQL:");
console.log(testSQL);
console.log("\n" + "=".repeat(50) + "\n");

const tables = parser.parseCreateTableStatements(testSQL);

console.log("Parsed Tables:");
console.log(JSON.stringify(tables, null, 2));

console.log("\n" + "=".repeat(50) + "\n");

for (const table of tables) {
  console.log(`📋 Table: ${table.name}`);
  console.log(`📝 Columns (${table.columns.length}):`);
  for (const column of table.columns) {
    console.log(
      `  - ${column.name}: ${column.type} (nullable: ${column.nullable}, primary: ${column.primary})`
    );
  }
  console.log("");
}
