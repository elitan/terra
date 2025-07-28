#!/usr/bin/env bun

import { parse as parseCST } from "sql-parser-cst";

const testSQL = `
CREATE VIEW active_users AS 
SELECT id, email, name 
FROM users 
WHERE active = true;
`;

console.log("🔍 Debugging AST structure...");

try {
  const cst = parseCST(testSQL, {
    dialect: "postgresql",
    includeSpaces: true,
    includeNewlines: true,
    includeComments: true,
    includeRange: true,
  });

  console.log("📋 Statements found:");
  if (cst.statements) {
    cst.statements.forEach((stmt, i) => {
      console.log(`  ${i}: ${stmt.type}`);
      console.log(`      Keys: ${Object.keys(stmt).join(', ')}`);
      if (stmt.type === 'create_view_stmt') {
        console.log(`      View details:`, JSON.stringify(stmt, null, 2));
      }
    });
  }

  console.log("\n🔍 Full AST:");
  console.log(JSON.stringify(cst, null, 2));
} catch (error) {
  console.error("❌ Parsing failed:", error);
}