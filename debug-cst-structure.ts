// Debug script to explore CST structure
import { parse as parseCST } from "sql-parser-cst";

console.log("🔍 Debugging CST Structure...");

const testSQL = `
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  price DECIMAL(10,2) DEFAULT 0.00
);
`;

console.log("Input SQL:");
console.log(testSQL);
console.log("\n" + "=".repeat(50) + "\n");

try {
  const cst = parseCST(testSQL, {
    dialect: "postgresql",
    includeSpaces: true,
    includeNewlines: true,
    includeComments: true,
    includeRange: true,
  });

  console.log("Full CST Structure:");
  console.log(JSON.stringify(cst, null, 2));

  console.log("\n" + "=".repeat(50) + "\n");

  if (cst.statements && cst.statements.length > 0) {
    const firstStatement = cst.statements[0];
    console.log("First Statement Structure:");
    console.log(JSON.stringify(firstStatement, null, 2));
  }
} catch (error) {
  console.error("Error parsing:", error);
}
