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

### 📊 **Current Status**

- **32 passing tests** with comprehensive coverage (19 for advanced index features)
- **0 failing tests** - all existing PGTerra functionality preserved
- **Phase 2 Advanced Index Features**: ✅ COMPLETED (Partial + Expression + Advanced Options)
- **Next Priority**: Operational Features (Phase 3) or Comprehensive Testing (Phase 4)

### 🔄 **Ready for Next Phase**

The comprehensive index foundation is complete and ready for operational features:

1. **Operational Features** - Concurrent operations, REINDEX support
2. **Comprehensive Testing** - Expand test coverage for edge cases and operational scenarios
3. **Integration & Documentation** - Complete workflow testing and documentation updates

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

## Phase 3: Operational Features & Concurrency

### 3.1 Concurrent Index Operations

- [ ] **Task 3.1.1**: Add support for `CREATE INDEX CONCURRENTLY` parsing

- [ ] **Task 3.1.2**: Implement special handling for concurrent operations in migration executor

- [ ] **Task 3.1.3**: Add connection management for long-running concurrent operations

- [ ] **Task 3.1.4**: Implement proper error handling for concurrent operation failures

- [ ] **Task 3.1.5**: Add timeout and progress monitoring for concurrent index creation

### 3.2 REINDEX Support

- [ ] **Task 3.2.1**: Implement logic to detect when indexes need rebuilding vs recreation

- [ ] **Task 3.2.2**: Add `REINDEX` statement generation for maintenance scenarios

- [ ] **Task 3.2.3**: Handle concurrent reindexing scenarios (`REINDEX CONCURRENTLY`)

- [ ] **Task 3.2.4**: Integrate REINDEX decisions into migration planning

---

## Phase 4: Comprehensive Testing

### 4.1 Unit Tests - Parser

- [ ] **Task 4.1.1**: Create `src/test/indexes/parser/` directory structure

- [ ] **Task 4.1.2**: Test basic index parsing for all index types (B-tree, Hash, GiST, SP-GiST, GIN, BRIN)

- [ ] **Task 4.1.3**: Test multi-column index parsing

- [ ] **Task 4.1.4**: Test unique index parsing

- [ ] **Task 4.1.5**: Test partial index parsing with various WHERE conditions

- [ ] **Task 4.1.6**: Test expression index parsing with different complexity levels

- [ ] **Task 4.1.7**: Test concurrent index syntax parsing

- [ ] **Task 4.1.8**: Test storage parameters and tablespace parsing

- [ ] **Task 4.1.9**: Test error handling for malformed index definitions

### 4.2 Unit Tests - Database Inspector

- [ ] **Task 4.2.1**: Create `src/test/indexes/inspector/` directory

- [ ] **Task 4.2.2**: Test accurate extraction of basic indexes from database

- [ ] **Task 4.2.3**: Test extraction of all index types and their properties

- [ ] **Task 4.2.4**: Test correct identification of unique, partial, and expression indexes

- [ ] **Task 4.2.5**: Test filtering of primary key and constraint indexes

- [ ] **Task 4.2.6**: Test system catalog query reliability and edge cases

### 4.3 Unit Tests - Schema Differ

- [ ] **Task 4.3.1**: Create `src/test/indexes/differ/` directory

- [ ] **Task 4.3.2**: Test index addition scenarios

- [ ] **Task 4.3.3**: Test index removal scenarios

- [ ] **Task 4.3.4**: Test index modification scenarios (DROP + CREATE)

- [ ] **Task 4.3.5**: Test complex migration scenarios with multiple index changes

- [ ] **Task 4.3.6**: Test proper ordering of index operations relative to table operations

### 4.4 Integration Tests

- [ ] **Task 4.4.1**: Create `src/test/indexes/integration/` directory

- [ ] **Task 4.4.2**: Test complete workflow: schema file → plan → apply for basic indexes

- [ ] **Task 4.4.3**: Test end-to-end scenarios with PostgreSQL database integration

- [ ] **Task 4.4.4**: Test verification of actual index creation and functionality

- [ ] **Task 4.4.5**: Test index usage verification (ensure indexes are actually usable by queries)

### 4.5 Edge Case & Performance Tests

- [ ] **Task 4.5.1**: Create `src/test/indexes/edge-cases/` directory

- [ ] **Task 4.5.2**: Test indexes on large datasets (performance implications)

- [ ] **Task 4.5.3**: Test complex expressions in expression indexes

- [ ] **Task 4.5.4**: Test Unicode and special characters in index names

- [ ] **Task 4.5.5**: Test indexes on various PostgreSQL data types

- [ ] **Task 4.5.6**: Test concurrent operation handling and timing

- [ ] **Task 4.5.7**: Test boundary conditions and error scenarios

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
