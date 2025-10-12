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

## 🟡 HIGH-Impact Improvements

### 3. Unnecessary Abstraction: MigrationPlanner

**Problem:** `MigrationPlanner` is 15 lines that just wraps `SchemaDiffer`. This adds no value.

**Location:** `src/core/migration/planner.ts:1-15`

**Current Code:**
```typescript
export class MigrationPlanner {
  private differ: SchemaDiffer;

  constructor() {
    this.differ = new SchemaDiffer();
  }

  generatePlan(desiredSchema: Table[], currentSchema: Table[]): MigrationPlan {
    return this.differ.generateMigrationPlan(desiredSchema, currentSchema);
  }
}
```

**Fix:** Remove `MigrationPlanner` entirely. Have `SchemaService` use `SchemaDiffer` directly.

**Impact:**
- Reduces cognitive overhead
- One less file to maintain
- Clearer architecture
- No functional loss

**Priority:** P1 - Code quality win

---

### 4. Hardcoded Version in CLI

**Problem:** Version is hardcoded as "0.1.0" in CLI instead of reading from package.json (which says 0.1.2).

**Location:** `src/cli/index.ts:11`

**Current Code:**
```typescript
program
  .name("terra")
  .description("Declarative schema management for Postgres")
  .version("0.1.0");
```

**Fix:**
```typescript
import packageJson from '../package.json' assert { type: 'json' };
// ...
.version(packageJson.version);
```

**Priority:** P1 - Professionalism

---

### 5. Parser is Monolithic (1846 lines)

**Problem:** The parser.ts file is huge with complex methods like `serializeExpressionFromCST` (250+ lines). Hard to maintain and test.

**Location:** `src/core/schema/parser.ts` (entire file)

**Issues:**
- Single 1846-line file
- Mixed concerns (tables, indexes, constraints, views, enums, expressions)
- Difficult to test individual components
- Hard to debug specific parsing issues

**Suggested Structure:**
```
src/core/schema/parser/
├── index.ts                    # Main orchestrator
├── table-parser.ts             # Table parsing
├── constraint-parser.ts        # All constraints
├── expression-serializer.ts    # Expression logic
├── index-parser.ts             # Index parsing
├── view-parser.ts              # View parsing
└── enum-parser.ts              # ENUM type parsing
```

**Impact:** Better testability, easier to debug, clearer separation of concerns.

**Priority:** P1 - Maintainability

---

## 🟢 MEDIUM-Impact (But Still Valuable)

### 6. Inconsistent Type Returns

**Problem:** Some methods return `Table[]`, others return `{ tables, views, enums }`. The `parseSchemaInput` has weird heuristics to detect SQL vs filename.

**Locations:**
- `src/core/schema/service.ts:117-137` - Heuristic detection
- `src/core/schema/parser.ts:17-50` - Mixed return types

**Current Heuristic (Bad):**
```typescript
if (
  input.includes('CREATE') ||
  input.includes(';') ||
  input.includes('\n') ||
  input.length > 500
) {
  return this.parser.parseSchema(input);
} else {
  // parseSchemaFile returns Table[], so wrap it in the expected format
  const tables = this.parser.parseSchemaFile(input);
  return { tables, enums: [], views: [] };
}
```

**Issues:**
- What if someone has a file called "CREATE_SCHEMA.sql"?
- What if schema is exactly 500 chars?
- Implicit behavior is confusing

**Fix:**
- Always return `Schema` type consistently
- Add explicit methods: `parseSchemaFile()` vs `parseSchemaString()`
- Remove guessing logic
- Let caller decide what they're passing

**Priority:** P2 - API clarity

---

### 7. Error Messages Lack Context

**Problem:** Errors are generic. When parsing fails or migration fails, users don't know *why* or *how to fix it*.

**Example:** `src/core/schema/parser.ts:113-118`
```typescript
} catch (error) {
  Logger.error(
    `✗ CST parser failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  throw error;
}
```

**Issues:**
- No line/column information
- No SQL snippet showing where error occurred
- No suggested fixes
- Just re-throws raw CST error

**Fix:** Create structured error types:
```typescript
class TerraError extends Error {
  code: string;
  userMessage: string;
  suggestedFix?: string;
}

class ParserError extends TerraError {
  line?: number;
  column?: number;
  sqlSnippet?: string;
}

class MigrationError extends TerraError {
  statement?: string;
  databaseError?: string;
}
```

**Priority:** P2 - User experience

---

### 8. No Dependency Resolver Verification

**Problem:** You have `dependency-resolver.ts` imported but unclear if it's being used consistently. Table creation order matters for foreign keys.

**Questions:**
- Does it handle circular foreign keys?
- Does it order CREATE TABLE statements correctly?
- Does it detect impossible circular dependencies and error early?
- Is it actually being called in the differ?

**Location:** `src/core/schema/dependency-resolver.ts` exists but usage unclear

**Fix:**
- Verify the dependency resolver is actually used
- Add tests for circular dependency detection
- Ensure CREATE TABLE statements are ordered by dependencies
- Document when/how it's used

**Priority:** P2 - Correctness

---

### 9. Test Setup is Heavy

**Problem:** All tests require a live PostgreSQL database. No unit tests for parser logic.

**Current Setup:**
- Requires Docker Compose
- Requires `DATABASE_URL` env var
- All tests are integration tests
- Parser logic (pure functions) still needs DB

**Impact:**
- Slow test runs
- Can't test locally without Docker
- Hard to debug specific parsing logic
- CI/CD requires database setup

**Fix:**
- Add pure unit tests for parser (mock CST objects)
- Add unit tests for differ logic (pure comparison)
- Add unit tests for SQL generation utilities
- Keep integration tests but make them separate (`test:integration`)

**Suggested Structure:**
```bash
bun test:unit          # Fast, no DB required
bun test:integration   # Requires DB
bun test              # Both
```

**Priority:** P2 - Developer experience

---

## 📊 Summary Priority Matrix

### CRITICAL (Do First)
| Issue | Priority | Effort | Impact | Status |
|-------|----------|--------|--------|--------|
| Support DATABASE_URL | P0 | 15 min | Standard compliance | ✅ DONE |
| Add destructive confirmations | P0 | 30 min | Safety | ✅ DONE |

### HIGH (Do Next)
| Issue | Priority | Effort | Impact | Status |
|-------|----------|--------|--------|--------|
| Remove MigrationPlanner | P1 | 15 min | Code quality | ✅ DONE |
| Fix CLI version | P1 | 5 min | Professionalism | ✅ DONE |
| Split parser into modules | P1 | 2-3 hours | Maintainability | |

### MEDIUM (Do If Time)
| Issue | Priority | Effort | Impact |
|-------|----------|--------|--------|
| Consistent type system | P2 | 1 hour | API clarity |
| Better error messages | P2 | 2 hours | User experience |
| Add unit tests | P2 | 2-3 hours | Developer velocity |
| Verify dependency resolver | P2 | 1 hour | Correctness |

---

## 🎯 Recommendation for MVP

For a **pragmatic early MVP**, focus on these **quick wins**:

### Phase 1: Quick Fixes (45 min total)
1. ✅ **DATABASE_URL support** (15 min) - Huge UX win
2. ✅ **Interactive confirmations** (30 min) - Prevents disasters
3. ✅ **Remove MigrationPlanner** (15 min) - Cleaner architecture
4. ✅ **Fix CLI version** (5 min) - Professionalism

### Why This Order?
- Gives immediate wins with minimal effort
- Improves safety and usability
- Total investment: ~45 minutes for significant quality improvement

---

## 💡 Additional Observations

### What's Actually Good

1. **Declarative philosophy is sound** - The core concept is excellent
2. **Parser is comprehensive** - Handles many PostgreSQL features
3. **Test coverage exists** - Good sign for early codebase
4. **Clean type system** - TypeScript types are well-defined
5. **Dependency resolution exists** - Shows thoughtful architecture

### Architectural Strengths

- Clear separation between parsing, diffing, and execution
- Good use of TypeScript types for schema representation
- Comprehensive constraint support (PK, FK, CHECK, UNIQUE)
- Production-ready features like concurrent indexes

### Code Quality Notes

- Generally clean, readable code
- Good naming conventions
- Appropriate use of classes vs functions
- Logger abstraction is good

---

## 📝 Next Steps

1. Review these findings
2. Prioritize based on your goals
3. Create GitHub issues for P0/P1 items
4. Consider which fixes to implement immediately
5. Plan architecture for migration state tracking

---

**Note:** This analysis focuses on pragmatic improvements for an early MVP. As the project matures, additional concerns like performance optimization, edge case handling, and advanced features can be addressed.
