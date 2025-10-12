# Testing Strategy for Terra

## Current State (As of 2025-10-12)

### Test Coverage Statistics
- **49 test files** (46 Terra-specific, 3 from dependencies)
- **822+ individual test cases** (764 before Phase 1 improvements)
- **Well-organized test structure** by feature area

### Test Organization

```
src/test/
├── columns/
│   ├── constraints/          # Foreign keys, check, unique constraints
│   ├── core-operations/      # Add, remove, modify columns
│   ├── edge-cases/           # Error scenarios, data integrity
│   ├── idempotency/          # Idempotency verification tests ✨ NEW
│   ├── combinations/         # Cross-feature testing ✨ NEW
│   ├── postgres-specific/    # PostgreSQL quirks ✨ NEW
│   ├── performance/          # Benchmarks, large datasets
│   └── type-conversions/     # Type change scenarios
├── constraints/              # Table-level constraints
├── indexes/                  # Index operations
├── views/                    # View management
├── types/                    # ENUM types
├── functions/                # Function support
├── extensions/               # Extension support (pgvector, etc.)
├── regressions/              # Bug regression prevention ✨ NEW
├── parser/                   # Parser unit tests
└── utils/                    # Test utilities

✨ NEW = Added in Phase 1 improvements
```

## Recent Improvements (Phase 1)

### What We Added

**58 new test cases** covering critical gaps:

1. **Type Alias Coverage** (`type-alias-idempotency.test.ts`)
   - INT vs INTEGER, int2 vs SMALLINT, int4 vs INTEGER, int8 vs BIGINT
   - Mixed case variations
   - Transitive equivalence chains

2. **Combination Testing** (`type-aliases-with-defaults.test.ts`)
   - Type aliases × defaults × type changes
   - Prevents spurious DROP/SET DEFAULT operations
   - Multi-column scenarios

3. **PostgreSQL Normalization** (`type-cast-normalization.test.ts`)
   - Type cast handling (::text, ::integer, ::character varying)
   - VARCHAR vs character varying equivalence
   - TIMESTAMP variants

4. **Regression Prevention** (`issue-default-type-bugs.test.ts`)
   - Documents and prevents specific bugs
   - One test per historical issue
   - Combined bug scenarios

### What We Discovered

The new tests revealed:
- ✅ Type alias normalization working correctly
- ✅ Default value normalization working correctly
- ⚠️ Negative integer defaults need special handling (documented as known limitation)

## Testing Philosophy

### Core Principles

1. **Declarative Focus**: Tests mirror Terra's declarative approach - define desired state, verify Terra reaches it
2. **Idempotency is Critical**: Every migration should be idempotent (apply twice = no changes second time)
3. **Data Integrity**: Always verify data preservation during migrations
4. **Real PostgreSQL**: Tests run against real PostgreSQL (not mocks) to catch DB-specific behavior

### Test Quality Guidelines

✅ **Good Test Characteristics:**
- Tests complete desired schema state (not imperative ALTER/DROP statements)
- Verifies idempotency after apply
- Tests data preservation
- Includes edge cases (empty strings, NULL, special characters)
- Has clear documentation of what it's testing

❌ **Anti-patterns to Avoid:**
- Using ALTER/DROP statements (Terra generates these)
- Skipping idempotency verification
- Testing only "happy path"
- Assuming PostgreSQL behavior without verification

## Known Gaps and Future Work

### Phase 2: Property-Based Testing (Planned)

**Goal**: Use `fast-check` for generative testing to catch edge cases humans miss

**Why fast-check?**
- Industry standard for TypeScript property-based testing
- Used by jest, jasmine, fp-ts, query-string, and other major projects
- Built-in shrinking (reduces failing cases to minimal examples)
- Works with Bun's test runner
- Active maintenance and TypeScript support

**Proposed Implementation:**

1. **Install Dependencies**
   ```bash
   bun add -D fast-check
   ```

2. **Create Property-Based Test Suite**
   ```
   src/test/properties/
   ├── schema-idempotency.property.test.ts
   ├── type-conversions.property.test.ts
   ├── data-preservation.property.test.ts
   └── arbitraries.ts (custom generators)
   ```

3. **Key Properties to Test**

   **Property 1: Idempotency**
   ```typescript
   // For any valid schema S:
   // apply(S) then apply(S) should produce zero changes
   ```

   **Property 2: Type Normalization**
   ```typescript
   // For any type alias pair (A, B) where A ≡ B:
   // Schema with type A should equal schema with type B
   ```

   **Property 3: Default Preservation**
   ```typescript
   // For any type change T1 → T2 with same default D:
   // Should not generate DROP DEFAULT or SET DEFAULT
   ```

   **Property 4: Data Preservation**
   ```typescript
   // For any schema migration M and dataset D:
   // COUNT(*) should remain unchanged
   // Primary keys should remain unchanged
   ```

4. **Custom Arbitraries Needed**
   - `fc.columnDefinition()`: Generate valid column definitions
   - `fc.tableSchema()`: Generate complete table schemas
   - `fc.typeAlias()`: Generate equivalent type aliases
   - `fc.defaultValue()`: Generate default values matching column type

5. **Example Test Structure**
   ```typescript
   import fc from 'fast-check';

   test('schema apply is idempotent', async () => {
     await fc.assert(
       fc.asyncProperty(
         fc.tableSchema(), // Custom arbitrary
         async (schema) => {
           await service.apply(schema, ['public'], true);
           const plan = await service.plan(schema);
           expect(plan.hasChanges).toBe(false);
         }
       ),
       { numRuns: 100 } // Run 100 random schemas
     );
   });
   ```

### Phase 3: Smoke Test Suite

**Goal**: Fast tests for pre-commit hooks

```
src/test/smoke/
└── quick-sanity-checks.test.ts
```

Fast subset covering:
- Basic table creation
- Simple type changes
- Basic constraints
- Runs in <5 seconds

### Phase 4: Coverage Metrics

**Goal**: Quantify test coverage

1. Add coverage reporting (Bun supports it)
   ```bash
   bun test --coverage
   ```

2. Set coverage goals:
   - `differ.ts`: 95%+ (critical for correctness)
   - `parser/`: 90%+ (handles all SQL input)
   - `inspector.ts`: 85%+ (reads current state)
   - Overall: 85%+

3. Add coverage to CI pipeline

### Phase 5: Mutation Testing

**Goal**: Verify tests actually catch bugs

Use mutation testing to:
- Introduce deliberate bugs
- Verify tests fail appropriately
- Identify weak assertions

Potential tools:
- Stryker Mutator (supports TypeScript)
- Verify test quality, not just coverage %

## Test Data Generators

Current utilities in `src/test/columns/test-data-generators.ts`:
- `BoundaryValues`: INT32_MIN/MAX, etc.
- `StringEdgeCases`: Unicode, SQL injection patterns, long strings
- `UnicodeTestData`: Emoji, multi-byte characters
- `BooleanEdgeCases`: true/false variations
- `POSTGRES_LIMITS`: Database limits

**Recommendation**: Expand these for property-based testing

## Running Tests

```bash
# All tests (excluding performance)
bun test

# Watch mode
bun run test:watch

# Performance tests separately
bun run test:performance

# Full suite (with Docker setup)
bun run test:full

# Specific test files
bun test src/test/columns/idempotency/
bun test src/test/regressions/

# With coverage (future)
bun test --coverage
```

## CI/CD Integration

**Current**: Tests run manually before releases

**Recommended**:
1. Run smoke tests on every commit
2. Run full test suite on PRs
3. Run performance tests nightly
4. Block merges if tests fail

## Test Database Setup

Integration tests require PostgreSQL:

```bash
docker compose up -d
export DATABASE_URL="postgres://test_user:test_password@localhost:5487/sql_terraform_test"
```

Test database config:
- Host: `localhost:5487`
- Database: `sql_terraform_test`
- User: `test_user`
- Password: `test_password`

## Regression Test Policy

**When fixing a bug:**

1. Add a regression test in `src/test/regressions/`
2. Name it after the issue: `issue-<description>.test.ts`
3. Document the bug in comments:
   - What went wrong
   - Root cause
   - Fix location
4. Test should fail without fix, pass with fix
5. Include edge cases related to the bug

**Example**: `issue-default-type-bugs.test.ts` documents:
- Bug 1: Unnecessary DEFAULT operations
- Bug 2: Non-idempotent int vs INTEGER
- Combined scenarios
- Edge cases

## Summary

### Strengths ✅
- 822+ comprehensive test cases
- Well-organized by feature
- Real PostgreSQL testing
- Good edge case coverage (Unicode, boundaries, etc.)
- Performance testing suite

### Improvements Made ✨
- Added type alias coverage (13 tests)
- Added combination testing (16 tests)
- Added PostgreSQL normalization tests (20 tests)
- Added regression test suite (9 tests)
- Created new test directories

### Future Work 📋
- Property-based testing with fast-check (Phase 2)
- Smoke test suite (Phase 3)
- Coverage metrics (Phase 4)
- Mutation testing (Phase 5)
- CI/CD integration

### Impact
The Phase 1 improvements would have caught both recent bugs before production:
- INT vs INTEGER idempotency → now tested
- Default normalization → now tested
- Combined scenarios → now tested

**Recommendation**: Proceed with Phase 2 (property-based testing) to catch even more edge cases automatically.
