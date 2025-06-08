# PostgreSQL Index Support

## Overview

Implement comprehensive PostgreSQL index support for PGTerra, enabling users to declaratively manage all types of indexes in their `schema.sql` files. This feature will extend PGTerra's current table and column management capabilities to include full index lifecycle management.

## Problem Statement

Currently, PGTerra supports tables, columns, and primary key constraints, but lacks support for indexes - a critical component of database schema management. Users need to be able to:

- Define indexes declaratively in their schema files
- Have PGTerra automatically detect and manage index changes
- Support all PostgreSQL index types and advanced features
- Maintain the same declarative, state-based approach that PGTerra uses for tables

## Requirements

### All Ways PostgreSQL Creates Indexes

PostgreSQL creates indexes through multiple mechanisms:

1. **Explicit CREATE INDEX statements** - Standalone index creation
2. **Implicit constraint indexes** - Automatically created by PRIMARY KEY and UNIQUE constraints
3. **ALTER TABLE ADD CONSTRAINT** - Adding constraints that create indexes

### Core Index Types Support

- **B-tree indexes** (default type)
- **Hash indexes**
- **GiST indexes** (Generalized Search Tree)
- **SP-GiST indexes** (Space-Partitioned GiST)
- **GIN indexes** (Generalized Inverted Index)
- **BRIN indexes** (Block Range Index)

### Advanced Index Features

- **Multi-column indexes** - Indexes spanning multiple columns
- **Unique indexes** - Enforcing uniqueness constraints
- **Partial indexes** - Indexes with WHERE clauses for conditional indexing
- **Expression indexes** - Indexes on computed expressions
- **Concurrent operations** - Non-blocking index creation and rebuilding
- **REINDEX operations** - Index rebuilding support

### Index Management Scope

**What PGTerra Will Manage:**

- Explicit `CREATE INDEX` statements in schema files
- All index types and advanced features for explicit indexes

**What PGTerra Already Manages (No Changes Needed):**

- PRIMARY KEY constraints and their implicit indexes
- UNIQUE constraints and their implicit indexes (when we add UNIQUE constraint support)

**What PostgreSQL Manages Automatically:**

- Index names for constraint-based indexes
- Index lifecycle tied to constraint lifecycle

### Schema File Integration

Users should be able to define indexes using standard PostgreSQL syntax in their `schema.sql` files:

#### Explicit Index Creation (New - What This Issue Implements)

```sql
-- Basic index
CREATE INDEX idx_users_email ON users (email);

-- Multi-column index
CREATE INDEX idx_users_name_email ON users (last_name, first_name);

-- Unique index
CREATE UNIQUE INDEX idx_users_username ON users (username);

-- GIN index for JSON data
CREATE INDEX idx_users_metadata ON users USING GIN (metadata);

-- Partial index
CREATE INDEX idx_active_users_email ON users (email) WHERE active = true;

-- Expression index
CREATE INDEX idx_users_lower_email ON users (LOWER(email));

-- Concurrent index creation
CREATE INDEX CONCURRENTLY idx_users_created_at ON users (created_at);
```

#### Implicit Index Creation (Already Supported - No Changes Needed)

```sql
-- Primary key constraint creates implicit index automatically
CREATE TABLE users (
  id SERIAL PRIMARY KEY,  -- Creates implicit B-tree index
  email VARCHAR(255)
);

-- Table-level primary key constraint
CREATE TABLE user_roles (
  user_id INTEGER,
  role_id INTEGER,
  PRIMARY KEY (user_id, role_id)  -- Creates implicit composite index
);

-- Named primary key constraint
CREATE TABLE sessions (
  session_id VARCHAR(255),
  user_id INTEGER,
  CONSTRAINT pk_sessions PRIMARY KEY (session_id)  -- Creates implicit index
);
```

#### Future Support (Not Part of This Issue)

```sql
-- Unique constraints (future feature - will create implicit indexes)
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(50) UNIQUE,  -- Will create implicit unique index
  name VARCHAR(255)
);
```

## Implementation Approach

### Phase 1: Core Index Support ✅ COMPLETED

1. **Type System Extension** ✅ COMPLETED

   - Add `Index` interface to `src/types/schema.ts`
   - Extend database schema representation to include indexes
   - Update existing types to accommodate index relationships

2. **Schema Parser Enhancement** ✅ COMPLETED

   - Extend `src/core/schema/parser.ts` to parse `CREATE INDEX` statements
   - Support all index types (B-tree, Hash, GiST, SP-GiST, GIN, BRIN)
   - Handle basic multi-column and unique indexes

3. **Database Inspector Extension** ✅ COMPLETED

   - Extend `src/core/schema/inspector.ts` to query existing indexes
   - Query PostgreSQL system catalogs (`pg_indexes`, `pg_class`, etc.)
   - Extract index definitions, types, and column mappings

4. **Schema Differ Enhancement** ✅ COMPLETED
   - Extend `src/core/schema/differ.ts` to compare index definitions
   - Generate `CREATE INDEX` and `DROP INDEX` statements
   - Handle index modifications as DROP + CREATE operations

### Phase 2: Advanced Features ✅ COMPLETED

1. **Partial Index Support** ✅ COMPLETED

   - Parse and handle WHERE clauses in index definitions
   - Support complex conditional logic
   - Proper comparison of partial index conditions

2. **Expression Index Support** ✅ COMPLETED

   - Parse complex expressions in index definitions
   - Handle function calls, operators, and computed columns
   - Proper comparison logic for expression matching
   - Support for unique expression indexes and partial expression indexes

3. **Advanced Index Options** ✅ COMPLETED
   - Storage parameters (fillfactor, deduplicate_items, etc.)
   - Tablespace specifications
   - Index-specific configuration options
   - Complete integration with all index types

### Phase 3: Operational Features ✅ COMPLETED

1. **Concurrent Operations** ✅ COMPLETED

   - Support `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY`
   - Separate concurrent operations from the main transaction for safe execution
   - Add configuration options for concurrent creates and drops

2. **REINDEX Support**
   - Detect when indexes need rebuilding vs recreation
   - Support `REINDEX` operations for maintenance
   - Handle concurrent reindexing scenarios

## Index Management Strategy

### Naming Convention

- **Require explicit index names** - No automatic name generation
- Users must specify index names in their schema files
- This ensures predictability and portability across environments

### Change Detection

- **DROP + CREATE approach** - When index definitions change, drop the old index and create a new one
- This is simpler and more reliable than attempting to alter indexes
- PostgreSQL's `ALTER INDEX` support is limited anyway

### Constraint Index Handling

- **Don't manage implicit indexes** - Let PostgreSQL automatically handle indexes created for PRIMARY KEY and UNIQUE constraints
- Only manage explicitly defined `CREATE INDEX` statements
- Avoid conflicts with constraint-based indexes

## Technical Specifications

### Data Structures

```typescript
interface Index {
  name: string;
  tableName: string;
  columns: string[];
  type?: "btree" | "hash" | "gist" | "spgist" | "gin" | "brin";
  unique?: boolean;
  concurrent?: boolean;
  where?: string; // For partial indexes
  expression?: string; // For expression indexes
  storageParameters?: Record<string, string>;
  tablespace?: string;
}

interface Table {
  name: string;
  columns: Column[];
  primaryKey?: PrimaryKeyConstraint;
  indexes?: Index[]; // New field
}
```

### Parser Integration

- Extend the existing SQL parser to handle `CREATE INDEX` statements
- Integrate with the current `sql-parser-cst` implementation
- Support all PostgreSQL index syntax variations

### Database Query Strategy

Query existing indexes using PostgreSQL system catalogs:

```sql
SELECT
  i.indexname as name,
  i.tablename,
  i.indexdef,
  ix.indisunique as is_unique,
  ix.indisprimary as is_primary,
  pg_get_expr(ix.indpred, ix.indrelid) as where_clause
FROM pg_indexes i
JOIN pg_class c ON c.relname = i.indexname
JOIN pg_index ix ON ix.indexrelid = c.oid
WHERE i.schemaname = 'public'
AND NOT ix.indisprimary; -- Exclude primary key indexes
```

## Testing Strategy

### Integration with Existing Test Infrastructure

- Leverage existing Bun test runner setup
- Use existing Docker Compose database setup for tests
- Follow established testing patterns from current test suites

### Test Coverage Areas

1. **Parser Tests**

   - All index types (B-tree, Hash, GiST, SP-GiST, GIN, BRIN)
   - Multi-column indexes
   - Unique indexes
   - Partial indexes with various WHERE conditions
   - Expression indexes with different complexity levels
   - Concurrent index creation syntax
   - Error handling for malformed index definitions

2. **Database Inspector Tests**

   - Accurate extraction of existing indexes
   - Proper handling of all index types
   - Correct identification of index properties (unique, partial, expression)
   - System catalog query reliability

3. **Schema Differ Tests**

   - Index addition scenarios
   - Index removal scenarios
   - Index modification scenarios (treated as DROP + CREATE)
   - Complex migration scenarios with multiple index changes
   - Proper ordering of index operations

4. **End-to-End Tests**

   - Complete workflow: schema file → plan → apply
   - Real PostgreSQL database integration
   - Verification of actual index creation and functionality
   - Index usage verification (ensure indexes are actually usable)

5. **Edge Case Tests**
   - Large datasets (performance implications)
   - Complex expressions in expression indexes
   - Unicode and special characters in index names
   - Indexes on various PostgreSQL data types
   - Concurrent operation handling

### PostgreSQL Version Compatibility

- Focus on latest 1-2 major PostgreSQL versions
- Test against commonly used PostgreSQL versions in production
- Document any version-specific limitations or features

## Migration Scenarios

### Typical Use Cases

1. **Adding new indexes** to improve query performance
2. **Removing unused indexes** to reduce maintenance overhead
3. **Modifying index definitions** (columns, type, conditions)
4. **Converting regular indexes to unique indexes**
5. **Adding partial indexes** for selective indexing
6. **Switching index types** for better performance characteristics

### Safety Considerations

- Index operations generally don't affect data integrity
- `DROP INDEX` operations are safe but may impact query performance
- `CREATE INDEX CONCURRENTLY` minimizes locking but requires special handling
- Proper error handling for failed index operations

## Acceptance Criteria

### Core Functionality ✅ COMPLETED

- [x] Parse all PostgreSQL index types from schema files
- [x] Detect and report differences between desired and current indexes
- [x] Generate correct `CREATE INDEX` and `DROP INDEX` statements
- [x] Execute index changes safely without data loss
- [x] Support multi-column, unique, partial, and expression indexes

### Advanced Features ✅ COMPLETED

- [x] Support concurrent index operations
- [x] Support all PostgreSQL index storage parameters
- [x] Handle tablespace specifications

### Quality Assurance ✅ PARTIALLY COMPLETED

- [x] Comprehensive test coverage for core index types and scenarios (32 tests passing)
- [x] Integration with existing PGTerra testing infrastructure
- [x] Proper error handling and user feedback
- [ ] Documentation updates reflecting new index capabilities

### User Experience

- [ ] Clear preview of index changes in `plan` command
- [ ] Informative output during index operations in `apply` command
- [ ] Proper handling of long-running concurrent operations
- [ ] Error messages that help users fix index definition issues

## Definition of Done

- [x] All PostgreSQL index types are supported in schema parsing
- [x] Database inspector accurately extracts existing index information
- [x] Schema differ correctly identifies index changes and generates appropriate SQL
- [x] Comprehensive test suite covers core index scenarios (32 tests passing)
- [x] Advanced index features implemented (partial, expression, storage parameters, tablespaces)
- [x] Concurrent operations are handled correctly and safely
- [ ] Documentation is updated to reflect new index management capabilities
- [x] Integration with existing PGTerra workflow is seamless
- [x] User feedback during index operations is clear and informative

**Status**: All index functionality is now implemented. Final testing and documentation updates remain.

## Related Files

### Files to Modify

- `src/types/schema.ts` - Add Index interface and extend Table interface
- `src/core/schema/parser.ts` - Add CREATE INDEX parsing logic
- `src/core/schema/inspector.ts` - Add index detection from database
- `src/core/schema/differ.ts` - Add index comparison and migration logic
- `src/core/schema/service.ts` - Integrate index management into main workflow

### New Test Files to Create

- `src/test/indexes/` - New directory for index-specific tests
- Basic index operation tests
- Advanced feature tests (partial, expression, concurrent)
- Cross-index-type compatibility tests
- Performance and edge case tests

### Documentation Updates

- Update README.md to reflect index support in implemented features
- Add index examples to documentation
- Update CLI help text and usage examples
