# Terra Codebase Analysis - First Principles Review

**Date:** 2025-10-12
**Reviewer:** Claude (Sonnet 4.5)
**Context:** Early MVP/first version - focus on simple, working, pragmatic improvements

---

## 🔴 CRITICAL Issues

### 1. DATABASE_URL Not Supported

**Problem:** Your README shows `DATABASE_URL` but the code only supports individual env vars (`DB_HOST`, `DB_PORT`, etc.). This is the standard Postgres connection pattern used by Heroku, Railway, Vercel, and most modern platforms.

**Location:** `src/core/database/config.ts:3-11`

**Current Code:**
```typescript
export function loadConfig(): DatabaseConfig {
  return {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "postgres",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
  };
}
```

**Fix:**
```typescript
export function loadConfig(): DatabaseConfig {
  // Support DATABASE_URL (standard) or individual vars
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    return parseDatabaseUrl(databaseUrl);
  }
  // Fallback to individual vars...
}
```

**Priority:** P0 - Breaks documented functionality

---

### 2. No Interactive Confirmations for Destructive Operations

**Problem:** `DROP TABLE CASCADE` and column drops execute without user confirmation. For an early MVP used by real users, this is dangerous.

**Location:** `src/core/schema/differ.ts:122` - table drops
**Location:** `src/core/schema/differ.ts:180-185` - column drops

**Impact:** Users can accidentally destroy production data with no warning.

**Fix:** Add interactive prompts for:
- Table drops
- Column drops (potential data loss)
- Type changes that require USING clause
- Foreign key constraint changes

**Priority:** P0 - Production safety

---


## 🟢 MEDIUM-Impact Issues

### 1. Critical Bug: ENUMs and VIEWs Ignored When Using Files

**Problem:** `parseSchemaFile()` returns only `Table[]`, discarding ENUMs and VIEWs. This means **the CLI silently ignores ENUMs and VIEWs** in schema files. Tests work because they pass SQL strings directly.

**Locations:**
- `src/core/schema/parser/schema-parser.ts:21-29` - Only returns tables
- `src/core/schema/service.ts:134-135` - Wraps with empty arrays

**Current Code (Bug):**
```typescript
// parser/schema-parser.ts
parseSchemaFile(filePath: string): Table[] {
  const content = readFileSync(filePath, "utf-8");
  const { tables } = this.parseSchema(content);  // ← Discards enums and views!
  return tables;
}

// service.ts
const tables = this.parser.parseSchemaFile(input);
return { tables, enums: [], views: [] };  // ← Explicitly sets to empty!
```

**Impact:**
- Users with ENUMs in schema files: silently ignored by CLI
- Users with VIEWs in schema files: silently ignored by CLI
- No error message, just doesn't work
- Fragile heuristic needed to work around this

**Fix:**
```typescript
parseSchemaFile(filePath: string): { tables: Table[]; enums: EnumType[]; views: View[] } {
  const content = readFileSync(filePath, "utf-8");
  return this.parseSchema(content);  // Return everything
}
```

**Benefits:**
- Fixes critical bug where ENUMs/VIEWs don't work from files
- Consistent return types across all parser methods
- Can remove heuristic wrapping logic in service.ts
- Simplifies code

**Priority:** P0 - Critical bug affecting CLI users

---

### 2. Error Messages Lack Context

**Problem:** Parser and migration errors are generic, making it hard for users to debug issues.

**Location:** `src/core/schema/parser/schema-parser.ts:142-147`

**Current Code:**
```typescript
} catch (error) {
  Logger.error(
    `✗ CST parser failed: ${error instanceof Error ? error.message : String(error)}`
  );
  throw error;
}
```

**Issues:**
- No line/column information from CST parser
- No SQL snippet showing where error occurred
- No suggested fixes
- Generic error messages

**Fix:** Extract structured error information from CST parser:
```typescript
class ParserError extends Error {
  constructor(
    message: string,
    public line?: number,
    public column?: number,
    public sqlSnippet?: string,
    public suggestedFix?: string
  ) {
    super(message);
  }
}
```

**Benefits:**
- Users can quickly locate errors in their schema files
- Suggested fixes guide users to solutions
- Better developer experience

**Priority:** P2 - User experience

---

### 3. Dependency Resolver Usage Unclear

**Problem:** `dependency-resolver.ts` exists but it's unclear when/how it's used and if it handles all cases.

**Location:** `src/core/schema/dependency-resolver.ts`

**Questions to verify:**
- Is it actually being called for CREATE TABLE ordering?
- Does it handle circular foreign keys correctly?
- Does it detect impossible circular dependencies and error early?
- Are there tests covering edge cases?

**Fix:**
- Audit differ.ts to verify dependency resolver is used for table creation
- Add tests for circular dependency scenarios
- Document the dependency resolution strategy
- Ensure CREATE statements are properly ordered

**Priority:** P2 - Correctness

---

## 📊 Summary Priority Matrix

### CRITICAL (Completed)
| Issue | Priority | Effort | Impact | Status |
|-------|----------|--------|--------|--------|
| Support DATABASE_URL | P0 | 15 min | Standard compliance | ✅ DONE |
| Add destructive confirmations | P0 | 30 min | Safety | ✅ DONE |
| Remove MigrationPlanner | P1 | 15 min | Code quality | ✅ DONE |
| Fix CLI version | P1 | 5 min | Professionalism | ✅ DONE |
| Split parser into modules | P1 | 2-3 hours | Maintainability | ✅ DONE |

### REMAINING (Priority Order)
| Issue | Priority | Effort | Impact | Status |
|-------|----------|--------|--------|--------|
| #1: Fix parseSchemaFile return type | P0 | 15 min | Bug fix - ENUMs/VIEWs work from files | ✅ DONE |
| #2: Better error messages | P2 | 2 hours | User experience | ✅ DONE |
| #3: Verify dependency resolver | P2 | 1 hour | Correctness | |

---

## 🎯 Next Actions

### Issue #1: Critical Bug Fix (15 minutes)
The `parseSchemaFile()` return type bug is a quick fix with high impact:
- ENUMs and VIEWs currently don't work when using the CLI with schema files
- Change return type from `Table[]` to `{ tables, enums, views }`
- Remove heuristic wrapping logic in service.ts
- Consistent API across all parser methods

