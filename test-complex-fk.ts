#!/usr/bin/env bun

import { SchemaParser } from "./src/core/schema/parser";

const parser = new SchemaParser();

const schema = `
CREATE TABLE regions (
  country_code VARCHAR(2),
  region_code VARCHAR(3),
  name VARCHAR(100) NOT NULL,
  PRIMARY KEY (country_code, region_code)
);

CREATE TABLE cities (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  country_code VARCHAR(2) NOT NULL,
  region_code VARCHAR(3) NOT NULL,
  CONSTRAINT fk_region FOREIGN KEY (country_code, region_code) 
    REFERENCES regions(country_code, region_code) 
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  user_id INTEGER,
  CONSTRAINT fk_user FOREIGN KEY (user_id) 
    REFERENCES users(id) 
    ON DELETE SET NULL ON UPDATE RESTRICT
);
`;

try {
  const result = parser.parseSchema(schema);
  console.log("✅ Complex FK Parse successful!");
  console.log("📊 Tables found:", result.tables.length);
  
  for (const table of result.tables) {
    if (table.foreignKeys && table.foreignKeys.length > 0) {
      console.log(`\n🏗️  Table: ${table.name} - Foreign Keys:`);
      for (const fk of table.foreignKeys) {
        console.log(`  🔗 ${fk.name}:`);
        console.log(`    📍 Columns: [${fk.columns.join(", ")}]`);
        console.log(`    🎯 References: ${fk.referencedTable}(${fk.referencedColumns.join(", ")})`);
        if (fk.onDelete) console.log(`    🗑️  ON DELETE: ${fk.onDelete}`);
        if (fk.onUpdate) console.log(`    ✏️  ON UPDATE: ${fk.onUpdate}`);
      }
    }
  }
} catch (error) {
  console.error("❌ Parse failed:", error);
}