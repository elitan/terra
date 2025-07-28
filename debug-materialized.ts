#!/usr/bin/env bun

import { parse as parseCST } from "sql-parser-cst";

const testSQL = `
CREATE MATERIALIZED VIEW user_stats AS
SELECT 
  COUNT(*) as total_users,
  COUNT(CASE WHEN active THEN 1 END) as active_users
FROM users;
`;

console.log("🔍 Debugging MATERIALIZED VIEW AST...");

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
      
      if (stmt.kinds) {
        console.log(`      Kinds:`, stmt.kinds);
      }
    });
  }
} catch (error) {
  console.error("❌ Parsing failed:", error);
}