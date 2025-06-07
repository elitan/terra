# Pure JavaScript PostgreSQL Parser Alternatives

This guide helps you test and implement JavaScript native alternatives to `libpg-query` to solve the Bun compatibility issue.

## 🎯 Problem Summary

- `libpg-query` requires native compilation and doesn't work with Bun
- You need pure JavaScript solutions for PostgreSQL SQL parsing
- Must support CREATE TABLE statements with SERIAL, constraints, etc.

## 🚀 Recommended Solutions

### 1. pgsql-parser (⭐ RECOMMENDED)

**Pros:**

- Real PostgreSQL parser (uses actual PostgreSQL source)
- Symmetric parsing and deparsing
- Most accurate PostgreSQL compatibility
- Active development

**Install:**

```bash
bun add pgsql-parser
```

**Test Usage:**

```typescript
import { parse, deparse } from "pgsql-parser";

// Test CREATE TABLE with SERIAL
const sql = `CREATE TABLE dualtest (
  id SERIAL PRIMARY KEY,
  price VARCHAR(20),
  quantity INTEGER
);`;

try {
  const ast = parse(sql);
  console.log("✅ Parsed successfully");
  console.log("AST:", JSON.stringify(ast, null, 2));

  // Test deparse back to SQL
  const regenerated = deparse(ast);
  console.log("🔄 Regenerated SQL:", regenerated);
} catch (error) {
  console.log("❌ Failed:", error.message);
}
```

### 2. sql-parser-cst

**Pros:**

- Pure JavaScript
- Concrete Syntax Tree (preserves formatting)
- PostgreSQL experimental support
- Good for formatting tools

**Install:**

```bash
bun add sql-parser-cst
```

**Test Usage:**

```typescript
import { parse, show } from "sql-parser-cst";

const sql = `CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255));`;

try {
  const cst = parse(sql, {
    dialect: "postgresql",
    includeSpaces: true,
    includeNewlines: true,
    includeComments: true,
  });

  console.log("✅ Parsed successfully");
  console.log("CST type:", cst.type);

  // Convert back to SQL
  const regenerated = show(cst);
  console.log("🔄 Regenerated SQL:", regenerated);
} catch (error) {
  console.log("❌ Failed:", error.message);
}
```

### 3. node-sql-parser (Current)

You're already using this. It may need configuration tweaks for better PostgreSQL support.

## 🧪 Testing Script

Create `test-parsers.ts`:

```typescript
// Test cases based on your existing requirements
const testCases = [
  {
    name: "Simple SERIAL table",
    sql: `CREATE TABLE dualtest (
      id SERIAL PRIMARY KEY,
      price VARCHAR(20),
      quantity INTEGER
    );`,
  },
  {
    name: "Complex constraints",
    sql: `CREATE TABLE users (
      id BIGINT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );`,
  },
  {
    name: "Foreign keys",
    sql: `CREATE TABLE orders (
      id SERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id),
      total DECIMAL(10,2) NOT NULL
    );`,
  },
];

async function testPgsqlParser() {
  console.log("Testing pgsql-parser...");

  try {
    const { parse, deparse } = await import("pgsql-parser");

    for (const test of testCases) {
      try {
        const ast = parse(test.sql);
        const regenerated = deparse(ast);
        console.log(`✅ ${test.name}: SUCCESS`);
      } catch (error) {
        console.log(`❌ ${test.name}: ${error.message}`);
      }
    }
  } catch (error) {
    console.log("❌ pgsql-parser not installed");
  }
}

async function testSqlParserCst() {
  console.log("Testing sql-parser-cst...");

  try {
    const { parse, show } = await import("sql-parser-cst");

    for (const test of testCases) {
      try {
        const cst = parse(test.sql, { dialect: "postgresql" });
        const regenerated = show(cst);
        console.log(`✅ ${test.name}: SUCCESS`);
      } catch (error) {
        console.log(`❌ ${test.name}: ${error.message}`);
      }
    }
  } catch (error) {
    console.log("❌ sql-parser-cst not installed");
  }
}

// Run tests
testPgsqlParser();
testSqlParserCst();
```

## 🔧 Implementation Strategy

### Phase 1: Quick Test

1. Install both packages: `bun add pgsql-parser sql-parser-cst`
2. Run the test script above
3. Compare success rates with your test cases

### Phase 2: Integration

Replace your current parser usage:

**Before (with libpg-query):**

```typescript
import { parse } from "pgsql-parser"; // was failing
```

**After (with pgsql-parser):**

```typescript
import { parse, deparse } from 'pgsql-parser';

// In your SchemaParser class
parseCreateTableStatements(sql: string): Table[] {
  try {
    const ast = parse(sql);
    // Process AST to extract table definitions
    return this.extractTablesFromAst(ast);
  } catch (error) {
    Logger.error(`Failed to parse SQL: ${error.message}`);
    return [];
  }
}
```

### Phase 3: Fallback Strategy

Implement multiple parser support:

```typescript
export class SchemaParser {
  private parsers = ["pgsql-parser", "sql-parser-cst", "node-sql-parser"];

  parseCreateTableStatements(sql: string): Table[] {
    for (const parserName of this.parsers) {
      try {
        return this.parseWithParser(sql, parserName);
      } catch (error) {
        Logger.warning(`${parserName} failed, trying next parser`);
      }
    }

    Logger.error("All parsers failed");
    return [];
  }
}
```

## 📊 Expected Results

Based on the research:

1. **pgsql-parser**: Should handle 90%+ of your cases (uses real PostgreSQL parser)
2. **sql-parser-cst**: Should handle 70-80% (experimental PostgreSQL support)
3. **node-sql-parser**: Current performance (unknown, needs testing)

## 🎯 Next Steps

1. **Install packages:**

   ```bash
   bun add pgsql-parser sql-parser-cst
   ```

2. **Run tests:**

   ```bash
   bun run test-parsers.ts
   ```

3. **Choose the winner** based on your test results

4. **Update your SchemaParser** to use the best performing option

5. **Add error handling** for edge cases

## 🔍 Additional Options

If none work well enough:

- **Hybrid approach**: Use different parsers for different statement types
- **Schema introspection**: Query database metadata instead of parsing SQL
- **AST transformation**: Convert between parser formats
- **Wait for Bun compatibility**: Track libpg-query Bun support

## 📚 Resources

- [pgsql-parser GitHub](https://github.com/launchql/pgsql-parser)
- [sql-parser-cst GitHub](https://github.com/nene/sql-parser-cst)
- [node-sql-parser GitHub](https://github.com/taozhi8833998/node-sql-parser)
- [SQL Parsers Comparison](https://hackernoon.com/14-open-source-sql-parsers)
