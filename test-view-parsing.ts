#!/usr/bin/env bun

// Simple test to verify VIEW parsing works
import { SchemaParser } from "./src/core/schema/parser";

const parser = new SchemaParser();

const testSQL = `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  active BOOLEAN DEFAULT true
);

CREATE VIEW active_users AS 
SELECT id, email, name 
FROM users 
WHERE active = true;

CREATE MATERIALIZED VIEW user_stats AS
SELECT 
  COUNT(*) as total_users,
  COUNT(CASE WHEN active THEN 1 END) as active_users
FROM users;
`;

console.log("🧪 Testing VIEW parsing...");

try {
  const result = parser.parseSchema(testSQL);
  
  console.log("\n✅ Parsed successfully!");
  console.log(`📊 Found ${result.tables.length} tables`);
  console.log(`👁️  Found ${result.views.length} views`);
  console.log(`🏷️  Found ${result.enums.length} enums`);
  
  if (result.views.length > 0) {
    console.log("\n📋 Views found:");
    result.views.forEach(view => {
      console.log(`  - ${view.name} (${view.materialized ? 'materialized' : 'regular'})`);
      console.log(`    Definition: ${view.definition.substring(0, 50)}...`);
    });
  }
} catch (error) {
  console.error("❌ Parsing failed:", error);
  process.exit(1);
}

console.log("\n🎉 VIEW parsing test completed successfully!");