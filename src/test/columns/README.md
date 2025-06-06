# Column Tests Structure

This directory contains all tests related to column operations, organized by category for maintainability and clarity.

## File Organization

### Core Operations

- **`basic-operations.test.ts`** - Adding, removing, and renaming columns
- **`type-changes.test.ts`** - Data type conversions (compatible and incompatible)
- **`constraints.test.ts`** - NULL/NOT NULL, defaults, CHECK, UNIQUE constraints

### Advanced Operations

- **`primary-keys.test.ts`** - Primary key column operations
- **`foreign-keys.test.ts`** - Foreign key relationships and constraints
- **`multi-operations.test.ts`** - Complex scenarios with multiple simultaneous changes

### Safety & Edge Cases

- **`data-safety.test.ts`** - Data preservation, validation, error handling
- **`performance.test.ts`** - Large dataset operations, concurrency, locks
- **`postgres-features.test.ts`** - PostgreSQL-specific types and features
- **`edge-cases.test.ts`** - Naming conflicts, system limits, unusual scenarios

## Shared Utilities

- **`column-test-utils.ts`** - Common helpers for column testing
- **`test-data.ts`** - Test data generators and fixtures

## Testing Patterns

All column tests follow the same end-to-end pattern:

```typescript
test("should do something meaningful", async () => {
  // 1. Initial state: set up database
  await client.query(`CREATE TABLE test_table (...);`);

  // 2. Desired state: SQL with what we want
  const desiredSQL = `CREATE TABLE test_table (...);`;

  // 3. Parse desired state and apply diff
  const initialSchema = await inspector.getCurrentSchema(client);
  const desiredTables = parser.parseCreateTableStatements(desiredSQL);
  const migrationStatements = differ.generateMigrationPlan(
    desiredTables,
    initialSchema
  );

  const plan: MigrationPlan = {
    statements: migrationStatements,
    hasChanges: migrationStatements.length > 0,
  };
  await executor.executePlan(client, plan);

  // 4. Verify final state
  const finalColumns = await getTableColumns(client, "test_table");
  expect(finalColumns).toHaveLength(expectedCount);
  // ... additional assertions
});
```

## Current Status

Based on the [Column Testing PRD](../../prds/column-testing.md):

- ✅ **Phase 1** (Core Operations) - Currently implemented in basic-operations.test.ts
- ⏳ **Phase 2** (Constraints & Relationships) - Planned
- ⏳ **Phase 3** (Advanced Types & Features) - Planned
- ⏳ **Phase 4** (Edge Cases & Error Handling) - Planned

## Running Tests

```bash
# Run all column tests
bun test src/test/columns/

# Run specific category
bun test src/test/columns/basic-operations.test.ts
bun test src/test/columns/type-changes.test.ts

# Run with timeout for performance tests
bun test src/test/columns/performance.test.ts --timeout 60000
```

## Contributing

When adding new column tests:

1. **Choose the right file** based on the primary operation being tested
2. **Follow the established pattern** (4-step end-to-end test)
3. **Use descriptive test names** that explain the scenario
4. **Update the PRD** to mark tests as implemented (✅)
5. **Add shared utilities** to `column-test-utils.ts` if reusable
