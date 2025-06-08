# PostgreSQL Index Support - Implementation Plan

## Progress Summary

### ✅ **Completed Phases**

- **Phase 1**: Core Infrastructure & Type System ✅ COMPLETED

  - ✅ Type definitions (Index interface, Table.indexes field)
  - ✅ Schema parser (CREATE INDEX statement parsing for all index types, UNIQUE, CONCURRENT)
  - ✅ Database inspector (index detection from PostgreSQL system catalogs)
  - ✅ Schema differ (index comparison and migration SQL generation)

- **Phase 2.1**: Partial Index Support ✅ COMPLETED

  - ✅ WHERE clause parsing from CREATE INDEX statements
  - ✅ Database extraction of partial index conditions using `pg_get_expr()`
  - ✅ Schema comparison including WHERE clauses
  - ✅ Complete workflow for partial indexes

- **Phase 2.2**: Expression Index Support ✅ COMPLETED

  - ✅ Parser enhancement for expression indexes (`CREATE INDEX ON table (LOWER(column))`)
  - ✅ Expression parsing for function calls, operators, and computed columns
  - ✅ Database inspector enhancement to extract expression definitions from system catalogs
  - ✅ Expression index comparison logic in schema differ
  - ✅ Migration SQL generation for expression indexes
  - ✅ Support for unique expression indexes and partial expression indexes

- **Phase 2.3**: Advanced Index Options ✅ COMPLETED

  - ✅ Storage parameters support (`WITH (fillfactor=90)`)
  - ✅ Tablespace specifications (`TABLESPACE tablespace_name`)
  - ✅ Parser enhancement to handle storage parameters and tablespace clauses
  - ✅ Database inspector enhancement to extract storage options and tablespace info
  - ✅ Complete integration with existing index types (partial, expression, unique)

- **Phase 3**: Concurrent Operations ✅ COMPLETED

  - ✅ Migration Plan and Executor Enhancements
  - ✅ `DROP INDEX CONCURRENTLY` Support

### 📊 **Current Status**

- **71 passing index tests** with comprehensive coverage
- **171 total passing tests** across all functionality (excluding performance tests)
- **Database configuration unified** - all tests use consistent setup
- **Phase 2 Advanced Index Features**: ✅ COMPLETED (Partial + Expression + Advanced Options)
- **Phase 3 Concurrent Operations**: ✅ COMPLETED (Transactional/Concurrent separation, DROP INDEX CONCURRENTLY)
- **Phase 4.1 Test Organization & Database Fixes**: ✅ COMPLETED (Comprehensive test structure, unified DB config)
- **Next Priority**: Integration & Documentation (Phase 5) or remaining Phase 4 tasks

### 🔄 **Ready for Next Phase**

The comprehensive index foundation including concurrent operations is complete and ready for:

1. **Comprehensive Testing** - Expand test coverage for edge cases and operational scenarios
2. **Integration & Documentation** - Complete workflow testing and documentation updates
3. **Performance Optimization** - Fine-tune concurrent operations and large-scale index management

---

## Overview

This plan breaks down the PostgreSQL index support implementation into actionable tasks, organized by phases. Tasks should be completed from top to bottom within each phase to ensure proper dependencies and integration.

---

## Phase 1: Core Infrastructure & Type System ✅ COMPLETED

### 1.1 Update Type Definitions ✅ COMPLETED

- [x] **Task 1.1.1**: Add `Index` interface to `src/types/schema.ts` with all required fields:

  - `name: string`
  - `tableName: string`
  - `columns: string[]`
  - `type?: 'btree' | 'hash' | 'gist' | 'spgist' | 'gin' | 'brin'`
  - `unique?: boolean`
  - `concurrent?: boolean`
  - `where?: string` (for partial indexes)
  - `expression?: string` (for expression indexes)
  - `storageParameters?: Record<string, string>`
  - `tablespace?: string`

- [x] **Task 1.1.2**: Add `indexes?: Index[]` field to existing `Table` interface

- [x] **Task 1.1.3**: Update all imports and references to use the new type definitions

### 1.2 Schema Parser Enhancement - Basic Index Support ✅ COMPLETED

- [x] **Task 1.2.1**: Extend `SchemaParser` class in `src/core/schema/parser.ts` to detect `CREATE INDEX` statements

- [x] **Task 1.2.2**: Implement `parseCreateIndexStatements()` method to parse SQL and extract index definitions

- [x] **Task 1.2.3**: Add support for basic B-tree indexes with single and multiple columns

- [x] **Task 1.2.4**: Add support for all index types (Hash, GiST, SP-GiST, GIN, BRIN) via `USING` clause parsing

- [x] **Task 1.2.5**: Add support for `UNIQUE` index parsing

- [x] **Task 1.2.6**: Integrate index parsing into main `parseSchemaFile()` method

- [x] **Task 1.2.7**: Add comprehensive error handling for malformed index syntax

### 1.3 Database Inspector Enhancement - Index Detection ✅ COMPLETED

- [x] **Task 1.3.1**: Extend `DatabaseInspector` class in `src/core/schema/inspector.ts` to query existing indexes

- [x] **Task 1.3.2**: Implement `getTableIndexes()` method to query PostgreSQL system catalogs:

  - Query `pg_indexes`, `pg_class`, `pg_index` tables
  - Extract index name, table name, columns, type, uniqueness
  - Filter out primary key and unique constraint indexes

- [x] **Task 1.3.3**: Integrate index detection into `getCurrentSchema()` method

- [x] **Task 1.3.4**: Add proper handling for multi-column indexes and column ordering

### 1.4 Schema Differ Enhancement - Index Comparison ✅ COMPLETED

- [x] **Task 1.4.1**: Extend `SchemaDiffer` class in `src/core/schema/differ.ts` to compare index definitions

- [x] **Task 1.4.2**: Implement `compareIndexes()` method to identify:

  - New indexes to create
  - Existing indexes to drop
  - Modified indexes (treated as drop + create)

- [x] **Task 1.4.3**: Implement `generateIndexMigrationStatements()` method to create SQL statements:

  - `CREATE INDEX` statements for new indexes
  - `DROP INDEX` statements for removed indexes

- [x] **Task 1.4.4**: Integrate index migration statements into main `generateMigrationPlan()` method

- [x] **Task 1.4.5**: Ensure proper ordering of index operations relative to table operations

---

## Phase 2: Advanced Index Features 🔄 IN PROGRESS

### 2.1 Partial Index Support ✅ COMPLETED

- [x] **Task 2.1.1**: Extend parser to handle `WHERE` clauses in `CREATE INDEX` statements

- [x] **Task 2.1.2**: Add WHERE clause parsing logic using sql-parser-cst

- [x] **Task 2.1.3**: Update database inspector to extract partial index conditions using `pg_get_expr(ix.indpred, ix.indrelid)`

- [x] **Task 2.1.4**: Implement partial index comparison logic in schema differ

- [x] **Task 2.1.5**: Generate proper `CREATE INDEX ... WHERE` statements in migration

### 2.2 Expression Index Support

- [x] **Task 2.2.1**: Extend parser to handle expression-based indexes `CREATE INDEX ON table ((expression))`

- [x] **Task 2.2.2**: Add expression parsing for function calls, operators, and computed columns

- [x] **Task 2.2.3**: Update database inspector to extract expression definitions from system catalogs

- [x] **Task 2.2.4**: Implement expression index comparison logic (complex string/AST matching)

- [x] **Task 2.2.5**: Generate proper expression index statements in migration

### 2.3 Advanced Index Options ✅ COMPLETED

- [x] **Task 2.3.1**: Add support for storage parameters (`WITH (fillfactor=90)`)

- [x] **Task 2.3.2**: Add support for tablespace specifications (`TABLESPACE tablespace_name`)

- [x] **Task 2.3.3**: Extend parser to handle these optional clauses

- [x] **Task 2.3.4**: Update database inspector to extract storage parameters and tablespace info

- [x] **Task 2.3.5**: Include advanced options in index comparison and migration generation

---

## Phase 3: Concurrent Operations ✅ COMPLETED

The core of this phase is to correctly execute `... CONCURRENTLY` operations, which cannot be run inside a transaction. This aligns with the declarative model by respecting the user's intent for non-blocking operations, without adding unnecessary abstractions.

### 3.1 Migration Plan and Executor Enhancements

- [x] **Task 3.1.1: Update Migration Plan Structure:**

  - Modify the `MigrationPlan` type to distinguish between standard (transactional) statements and concurrent (non-transactional) statements.
  - Example: `plan = { transactional: string[], concurrent: string[] }`

- [x] **Task 3.1.2: Enhance Schema Differ to Separate Statements:**

  - The `SchemaDiffer` will identify `... CONCURRENTLY` statements (both `CREATE` and `DROP`).
  - It will populate the new `MigrationPlan` structure, placing concurrent operations in their own list.

- [x] **Task 3.1.3: Update Migration Executor Logic:**
  - The `MigrationExecutor` will first run all `transactional` statements inside a single transaction.
  - If the transaction succeeds, it will then execute each statement from `concurrent` statements individually (outside of a transaction).

### 3.2 `DROP INDEX CONCURRENTLY` Support

- [x] **Task 3.2.1: Add Configuration for Concurrent Drops:**

  - Add a new option to `MigrationOptions`, e.g., `useConcurrentDrops: boolean` (defaulting to `true` for safety).

- [x] **Task 3.2.2: Update `generateIndexDropStatements`:**
  - The `SchemaDiffer` will use the `useConcurrentDrops` option to generate `DROP INDEX CONCURRENTLY ...` statements when dropping indexes.

---

## Phase 4: Testing Integration & Coverage

### Current State Analysis

- ✅ **Comprehensive tests reorganized**: Well-organized structure with 6 focused test files (71 tests total)
- ✅ **58 passing tests** covering parser, database inspector, schema differ, and advanced features
- ✅ **Included in main test suite**: All index tests now run with standard test commands
- ❌ **13 failing tests**: Minor implementation details and edge cases to fix
- ✅ **Integration tests**: End-to-end workflow tests implemented and mostly working

### 4.1 Test Reorganization & Structure ✅ COMPLETED

- [x] **Task 4.1.1**: Reorganize tests into logical structure under `src/test/indexes/` ✅ COMPLETED

  ```
  src/test/indexes/
  ├── basic-indexes.test.ts      # Core functionality (13 tests)
  ├── expression-indexes.test.ts # Expression index tests (31 tests)
  ├── partial-indexes.test.ts    # Partial index tests (7 tests)
  ├── concurrent-indexes.test.ts # Concurrent operations (9 tests)
  ├── storage-options.test.ts    # Storage parameters & tablespace (16 tests)
  └── integration.test.ts        # End-to-end workflow tests (6 tests)
  ```

- [x] **Task 4.1.2**: Move and split existing tests into focused files ✅ COMPLETED

  - ✅ Moved `src/test/indexes.test.ts` → `src/test/indexes/basic-indexes.test.ts`
  - ✅ Created `partial-indexes.test.ts` with focused partial index tests
  - ✅ Created `concurrent-indexes.test.ts` with concurrent operation tests
  - ✅ Created `storage-options.test.ts` with storage/tablespace tests
  - ✅ Created `integration.test.ts` with end-to-end workflow tests

- [x] **Task 4.1.3**: Update package.json test scripts ✅ COMPLETED

  - ✅ Added `src/test/indexes/` to all test commands (`test`, `test:watch`, `test:unit`, `test:full`)
  - ✅ Verified test discovery works correctly (71 tests discovered across 6 files)
  - ✅ All index tests are now included in main test suite

- [x] **Task 4.1.4**: Fix failing tests and ensure all pass ✅ COMPLETED
  - ✅ Fixed SQL generation expectations (concurrent vs non-concurrent)
  - ✅ Fixed parser edge cases (empty storage parameters, quote handling)
  - ✅ Fixed performance test query plan format differences
  - ✅ Fixed TypeScript errors with undefined index access

### 4.1.5 Final Test Status Summary ✅ COMPLETED

**✅ 71 PASSING TESTS** - All index functionality working perfectly!
**❌ 0 FAILING TESTS** - All issues resolved

**Test Coverage Breakdown:**

- **13 tests**: Basic index functionality (parser, inspector, differ)
- **31 tests**: Expression index support (functions, operators, computed columns)
- **7 tests**: Partial index support (WHERE clauses, conditions)
- **9 tests**: Concurrent operations (CONCURRENTLY, non-blocking)
- **16 tests**: Storage options (parameters, tablespace)
- **6 tests**: Integration tests (end-to-end workflows)

### 4.2 Gap Analysis & Missing Coverage

- [ ] **Task 4.2.1**: Storage parameters edge cases

  - Test invalid storage parameter values and error handling
  - Test storage parameter inheritance and defaults
  - Test complex parameter combinations

- [ ] **Task 4.2.2**: Tablespace handling edge cases

  - Test non-existent tablespace scenarios
  - Test tablespace permissions and access issues
  - Test tablespace changes in migrations

- [ ] **Task 4.2.3**: Complex concurrent operation scenarios

  - Test concurrent index creation during heavy database load
  - Test timeout and cancellation handling
  - Test concurrent operation conflicts and resolution

- [ ] **Task 4.2.4**: Performance with large schemas
  - Test index operations on schemas with 50+ tables and 200+ indexes
  - Test migration plan generation performance with complex index changes
  - Test database inspection performance with many indexes

### 4.3 True Integration Tests

- [ ] **Task 4.3.1**: Full workflow tests (schema file → plan → apply → verify)

  - Create test scenarios that start with a `schema.sql` file containing indexes
  - Test complete PGTerra workflow: parse → inspect → diff → plan → execute
  - Verify that created indexes actually improve query performance

- [ ] **Task 4.3.2**: Cross-database version compatibility

  - Test index functionality across PostgreSQL versions (13, 14, 15, 16+)
  - Identify and handle version-specific index features
  - Test migration compatibility between versions

- [ ] **Task 4.3.3**: Regression tests for existing PGTerra functionality
  - Ensure index support doesn't break existing table/column operations
  - Test mixed migrations with tables, columns, and indexes
  - Verify backward compatibility with existing PGTerra workflows

### 4.4 Edge Cases & Robustness

- [ ] **Task 4.4.1**: Unicode and special character handling

  - Test index names with Unicode characters, spaces, and special symbols
  - Test column names with international characters in indexes
  - Test expression indexes with Unicode string functions

- [ ] **Task 4.4.2**: Large dataset performance validation

  - Test index creation on tables with 1M+ rows
  - Measure and validate CONCURRENT vs non-concurrent performance differences
  - Test index effectiveness with realistic data distributions

- [ ] **Task 4.4.3**: Error handling and recovery scenarios

  - Test behavior when disk space runs out during index creation
  - Test handling of interrupted index operations
  - Test rollback scenarios and cleanup procedures

- [ ] **Task 4.4.4**: Complex expression and partial index validation
  - Test deeply nested function expressions in indexes
  - Test partial indexes with complex WHERE conditions
  - Test combination of expression + partial + unique indexes

---

## Phase 5: Integration & Documentation

### 5.1 Service Integration

- [ ] **Task 5.1.1**: Update `SchemaService` in `src/core/schema/service.ts` to integrate index management

- [ ] **Task 5.1.2**: Ensure proper error handling and user feedback for index operations

- [ ] **Task 5.1.3**: Add index-specific logging and progress reporting

### 5.2 CLI Integration

- [ ] **Task 5.2.1**: Update CLI plan command to display index changes clearly

- [ ] **Task 5.2.2**: Update CLI apply command to show progress for index operations

- [ ] **Task 5.2.3**: Add informative output for long-running concurrent operations

- [ ] **Task 5.2.4**: Implement proper error messages that help users fix index definition issues

### 5.3 Documentation Updates

- [ ] **Task 5.3.1**: Update README.md to move "Indexes" from "In Progress" to "Implemented Features"

- [ ] **Task 5.3.2**: Add comprehensive index examples to documentation

- [ ] **Task 5.3.3**: Update CLI help text and usage examples

- [ ] **Task 5.3.4**: Create migration guides for users adding indexes to existing schemas

- [ ] **Task 5.3.5**: Document performance considerations and best practices

### 5.4 Final Validation

- [ ] **Task 5.4.1**: Run full test suite and ensure all tests pass

- [ ] **Task 5.4.2**: Test against multiple PostgreSQL versions (latest 1-2 major versions)

- [ ] **Task 5.4.3**: Perform integration testing with existing PGTerra features

- [ ] **Task 5.4.4**: Validate that no regressions are introduced to existing functionality

- [ ] **Task 5.4.5**: Performance testing with large schemas containing many indexes

---

## Implementation Notes

### Dependencies Between Phases

- **Phase 1** must be completed before Phase 2 (core infrastructure required)
- **Phase 2** can be implemented incrementally (partial, expression, advanced options)
- **Phase 3** requires Phase 1 completion but can run parallel to Phase 2
- **Phase 4** testing should begin as soon as Phase 1 components are ready
- **Phase 5** requires all previous phases to be substantially complete

### Risk Mitigation

- Start testing early and often during Phase 1
- Use feature flags or configuration to enable/disable advanced features during development
- Maintain backward compatibility with existing schema files throughout development
- Document breaking changes clearly if any are introduced

### Success Criteria

- [ ] All PostgreSQL index types are supported in schema parsing
- [ ] Database inspector accurately extracts existing index information
- [ ] Schema differ correctly identifies index changes and generates appropriate SQL
- [ ] Comprehensive test coverage for all index scenarios and edge cases
- [ ] Integration with existing PGTerra workflow is seamless
- [ ] User feedback during index operations is clear and informative
- [ ] Documentation is complete and helpful

---

**Total Estimated Tasks: 90+**
**Recommended Timeline: Complete one phase before moving to the next**
**Focus: Phase 1 is the foundation - ensure it's solid before advancing**
