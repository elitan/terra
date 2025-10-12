# Phase 2: Property-Based Testing Implementation Plan

## Overview

Property-based testing generates hundreds of random test cases automatically, catching edge cases human testers miss. Instead of writing specific examples, we define **properties** that should always hold true.

## Benefits for Terra

1. **Catches Type System Edge Cases**: Automatically tests all PostgreSQL type combinations
2. **Verifies Idempotency**: Tests 100+ random schemas to ensure `apply` is always idempotent
3. **Finds Normalization Bugs**: Tests all type alias combinations automatically
4. **Data Preservation**: Verifies migrations never lose data across random schema changes
5. **Reduces Manual Test Writing**: One property test = hundreds of example-based tests

## Implementation Steps

### Step 1: Install fast-check

```bash
bun add -D fast-check
```

### Step 2: Create Arbitraries (Custom Generators)

**File**: `src/test/properties/arbitraries.ts`

```typescript
import fc from 'fast-check';

// PostgreSQL type generators
export const pgType = fc.oneof(
  fc.constant('TEXT'),
  fc.constant('VARCHAR(100)'),
  fc.constant('VARCHAR(255)'),
  fc.constant('INTEGER'),
  fc.constant('int'),
  fc.constant('BIGINT'),
  fc.constant('int8'),
  fc.constant('SMALLINT'),
  fc.constant('int2'),
  fc.constant('BOOLEAN'),
  fc.constant('TIMESTAMP'),
  fc.constant('DATE')
);

// Type alias pairs (should be equivalent)
export const typeAliasPair = fc.oneof(
  fc.constant(['INTEGER', 'int']),
  fc.constant(['INTEGER', 'int4']),
  fc.constant(['SMALLINT', 'int2']),
  fc.constant(['BIGINT', 'int8']),
  fc.constant(['VARCHAR(100)', 'VARCHAR(100)']) // Same type
);

// Default value generators (type-aware)
export const defaultValue = (type: string) => {
  if (type.includes('INT') || type.includes('int')) {
    return fc.oneof(
      fc.constant(null),
      fc.integer({ min: 0, max: 1000 }).map(n => `${n}`)
    );
  }
  if (type.includes('VARCHAR') || type === 'TEXT') {
    return fc.oneof(
      fc.constant(null),
      fc.string({ minLength: 1, maxLength: 50 })
        .filter(s => !s.includes("'")) // No quotes
        .map(s => `'${s}'`)
    );
  }
  if (type === 'BOOLEAN') {
    return fc.oneof(
      fc.constant(null),
      fc.constant('true'),
      fc.constant('false')
    );
  }
  return fc.constant(null);
};

// Column definition generator
export const columnDefinition = fc.record({
  name: fc.constantFrom('col1', 'col2', 'col3', 'age', 'name', 'status'),
  type: pgType,
  nullable: fc.boolean()
}).chain(col =>
  defaultValue(col.type).map(def => ({
    ...col,
    default: col.nullable ? def : null
  }))
);

// Table schema generator
export const tableSchema = fc.record({
  tableName: fc.constantFrom('users', 'products', 'orders'),
  columns: fc.array(columnDefinition, { minLength: 1, maxLength: 5 })
}).map(({ tableName, columns }) => {
  const uniqueColumns = Array.from(
    new Map(columns.map(c => [c.name, c])).values()
  );

  return `
    CREATE TABLE ${tableName} (
      id SERIAL PRIMARY KEY,
      ${uniqueColumns.map(col => {
        let def = `${col.name} ${col.type}`;
        if (!col.nullable) def += ' NOT NULL';
        if (col.default) def += ` DEFAULT ${col.default}`;
        return def;
      }).join(',\n      ')}
    );
  `;
});
```

### Step 3: Create Property Tests

**File**: `src/test/properties/schema-idempotency.property.test.ts`

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { SchemaService } from "../../core/schema/service";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestDatabaseService } from "../utils";
import { tableSchema, typeAliasPair } from "./arbitraries";

describe("Property-Based: Schema Idempotency", () => {
  let client: Client;
  let service: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    const databaseService = createTestDatabaseService();
    service = new SchemaService(databaseService);
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  test("property: apply(schema) is always idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableSchema,
        async (schema) => {
          try {
            // First apply
            await service.apply(schema, ['public'], true);

            // Second apply - should show no changes
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
            expect(plan.transactional.length).toBe(0);
          } catch (error) {
            // Log schema that caused failure for debugging
            console.error('Failed schema:', schema);
            throw error;
          }
        }
      ),
      {
        numRuns: 50, // Run 50 random schemas
        verbose: true // Show progress
      }
    );
  });

  test("property: equivalent type aliases produce identical schemas", async () => {
    await fc.assert(
      fc.asyncProperty(
        typeAliasPair,
        fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
        async ([type1, type2], defaultValue) => {
          // Schema with first type alias
          const schema1 = `
            CREATE TABLE test (
              id SERIAL PRIMARY KEY,
              value ${type1}${defaultValue !== null ? ` DEFAULT ${defaultValue}` : ''}
            );
          `;

          // Schema with second type alias
          const schema2 = `
            CREATE TABLE test (
              id SERIAL PRIMARY KEY,
              value ${type2}${defaultValue !== null ? ` DEFAULT ${defaultValue}` : ''}
            );
          `;

          // Apply first schema
          await service.apply(schema1, ['public'], true);

          // Plan second schema - should show no changes
          const plan = await service.plan(schema2);

          expect(plan.hasChanges).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("property: type changes with same default don't drop/set default", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes("'")),
        async (defaultValue) => {
          // Start with TEXT
          const schema1 = `
            CREATE TABLE test (
              id SERIAL PRIMARY KEY,
              value TEXT DEFAULT '${defaultValue}'
            );
          `;

          // Change to VARCHAR but keep default
          const schema2 = `
            CREATE TABLE test (
              id SERIAL PRIMARY KEY,
              value VARCHAR(255) DEFAULT '${defaultValue}'
            );
          `;

          await service.apply(schema1, ['public'], true);
          const plan = await service.plan(schema2);

          // Should have type change but NOT default operations
          const defaultOps = plan.transactional.filter(
            s => s.includes('DROP DEFAULT') || s.includes('SET DEFAULT')
          );

          expect(defaultOps.length).toBe(0);
        }
      ),
      { numRuns: 50 }
    );
  });

  test("property: data count preserved after schema changes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 5, maxLength: 20 }),
        async (testData) => {
          // Initial schema
          const schema1 = `
            CREATE TABLE test (
              id SERIAL PRIMARY KEY,
              value TEXT
            );
          `;

          await service.apply(schema1, ['public'], true);

          // Insert test data
          for (const value of testData) {
            await client.query(
              "INSERT INTO test (value) VALUES ($1)",
              [value]
            );
          }

          // Get initial count
          const beforeCount = await client.query("SELECT COUNT(*) FROM test");

          // Change type
          const schema2 = `
            CREATE TABLE test (
              id SERIAL PRIMARY KEY,
              value VARCHAR(255)
            );
          `;

          await service.apply(schema2, ['public'], true);

          // Verify count unchanged
          const afterCount = await client.query("SELECT COUNT(*) FROM test");

          expect(afterCount.rows[0].count).toBe(beforeCount.rows[0].count);
          expect(afterCount.rows[0].count).toBe(testData.length.toString());
        }
      ),
      { numRuns: 20 } // Fewer runs due to data insertion overhead
    );
  });
});
```

### Step 4: Additional Property Test Files

**Recommended Files**:

1. **`type-normalization.property.test.ts`**
   - Property: All type alias pairs are equivalent
   - Property: Type normalization is transitive (if A≡B and B≡C then A≡C)
   - Property: Case-insensitive type matching

2. **`default-normalization.property.test.ts`**
   - Property: Default values with type casts are normalized
   - Property: String defaults preserve whitespace
   - Property: Numeric defaults preserve value

3. **`constraint-combinations.property.test.ts`**
   - Property: Adding/removing constraints is idempotent
   - Property: Constraint dependency order is correct

### Step 5: Integration with Test Suite

Update `package.json`:

```json
{
  "scripts": {
    "test:properties": "bun test src/test/properties/",
    "test:all": "bun test src/test && bun test:properties"
  }
}
```

## Expected Outcomes

### Before Property Testing
- Manual edge case identification
- Limited type combination coverage
- Some edge cases missed (like the int/INTEGER bug)

### After Property Testing
- Automatic edge case discovery
- 100+ random schemas tested
- High confidence in idempotency
- Catches bugs before they reach production

## Cost-Benefit Analysis

**Time Investment**:
- Initial setup: 4-6 hours
- Writing arbitraries: 2-3 hours
- Writing property tests: 3-4 hours
- **Total: ~10-13 hours**

**Return**:
- Catches bugs that would take hours to debug
- Prevents production issues (infinite savings)
- Reduces manual test writing (saves hours per feature)
- **ROI: High** (pays for itself after first bug caught)

## Maintenance

**When to update**:
- Adding new PostgreSQL types → Update `pgType` arbitrary
- New constraints → Add constraint arbitrary
- New features → Add corresponding property tests

**Effort**: ~30 minutes per new feature

## Running Property Tests

```bash
# Run all property tests
bun test:properties

# Run with more iterations (finds rarer bugs)
# Edit numRuns in test files to 200-500

# Run specific property test
bun test src/test/properties/schema-idempotency.property.test.ts
```

## Debugging Failed Properties

When a property test fails, fast-check automatically **shrinks** the failing case:

```
Property failed after 47 runs with arguments:
  Original: [very complex schema]
  Shrunk to: CREATE TABLE users (id SERIAL PRIMARY KEY, age int DEFAULT 25);

This makes debugging much easier!
```

## Success Metrics

After implementing Phase 2:

1. **Coverage Increase**: Property tests cover 100+ schemas automatically
2. **Bug Detection**: Finds bugs traditional tests miss
3. **Confidence**: High confidence in edge case handling
4. **Regression Prevention**: Properties prevent entire classes of bugs

## Recommendation

**Implement Phase 2** - property-based testing will provide:
- Automatic edge case coverage
- High ROI for minimal investment
- Protection against future bugs
- Reduced manual test maintenance

The recent bugs (int/INTEGER, default normalization) would have been caught by the properties in Step 3.

## Next Steps

1. Install fast-check: `bun add -D fast-check`
2. Create `src/test/properties/` directory
3. Implement arbitraries from Step 2
4. Start with `schema-idempotency.property.test.ts`
5. Gradually add more property tests
6. Run in CI alongside existing tests
