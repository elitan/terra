# Primary Key Support - Design Document

## Overview

This document outlines the design and implementation plan for comprehensive primary key support in PGTerra. Currently, PGTerra handles basic `SERIAL PRIMARY KEY` columns but lacks support for composite primary keys, primary key changes, and table-level primary key constraints.

## Current State Analysis

### ✅ What's Already Working

1. **SERIAL PRIMARY KEY Detection**

   - Parser correctly identifies `SERIAL PRIMARY KEY` columns
   - Database inspector queries primary key constraints via `information_schema`
   - SQL generation includes `PRIMARY KEY` in column definitions

2. **Basic Schema Representation**

   - `Column.primary?: boolean` field exists
   - `generateCreateTableStatement()` handles column-level primary keys

3. **Database Inspection**
   - Inspector queries `information_schema.table_constraints` to detect existing primary keys
   - Correctly maps primary key status to column objects

### 🔄 Current Limitations

1. **Composite Primary Keys** - No support for multi-column primary keys
2. **Table-level Constraints** - Only column-level `PRIMARY KEY` is supported
3. **Primary Key Changes** - Cannot add/remove/modify primary keys on existing tables
4. **Named Constraints** - No support for named primary key constraints
5. **Constraint Validation** - No validation that only one primary key exists per table

## Design Goals

### Core Objectives

1. **Complete Primary Key Support**

   - Single-column primary keys (enhance existing)
   - Multi-column composite primary keys
   - Table-level primary key constraints
   - Named primary key constraints

2. **Schema Evolution**

   - Add primary keys to existing tables
   - Remove primary keys from tables
   - Modify existing primary keys (change columns)
   - Handle primary key conflicts safely

3. **SQL Generation**

   - Generate proper `ALTER TABLE ADD CONSTRAINT` statements
   - Generate `ALTER TABLE DROP CONSTRAINT` statements
   - Handle constraint naming automatically or explicitly

4. **Data Integrity**
   - Validate primary key uniqueness before applying changes
   - Handle existing data conflicts
   - Provide clear error messages for constraint violations

## Technical Design

### 1. Redesigned Type Definitions

```typescript
// Simplified Column interface (removing primary field)
export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
}

// New PrimaryKeyConstraint interface
export interface PrimaryKeyConstraint {
  name?: string; // Optional constraint name
  columns: string[]; // Column names in the primary key
}

// Enhanced Table interface with unified primary key approach
export interface Table {
  name: string;
  columns: Column[];
  primaryKey?: PrimaryKeyConstraint; // Unified primary key representation
}
```

### 2. Schema Parser Enhancements

**Support Multiple Primary Key Syntax Forms:**

```sql
-- Column-level (existing support)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255)
);

-- Table-level single column
CREATE TABLE users (
  id SERIAL,
  email VARCHAR(255),
  PRIMARY KEY (id)
);

-- Table-level composite
CREATE TABLE user_roles (
  user_id INTEGER,
  role_id INTEGER,
  PRIMARY KEY (user_id, role_id)
);

-- Named constraint
CREATE TABLE sessions (
  user_id INTEGER,
  session_id VARCHAR(255),
  CONSTRAINT pk_sessions PRIMARY KEY (user_id, session_id)
);
```

**Parser Logic Changes:**

1. **Column-level parsing** - Parse `PRIMARY KEY` in column definitions and convert to table-level representation
2. **Table-level parsing** - Parse `PRIMARY KEY (...)` and `CONSTRAINT ... PRIMARY KEY (...)`
3. **Unified representation** - All primary key definitions converted to `Table.primaryKey` format
4. **Validation** - Ensure only one primary key definition exists per table

### 3. Database Inspector Enhancements

**Enhanced Primary Key Detection:**

```sql
-- Current query (works but limited)
SELECT column_name,
       (SELECT COUNT(*) FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = $1 AND kcu.column_name = columns.column_name
        AND tc.constraint_type = 'PRIMARY KEY') > 0 as is_primary
FROM information_schema.columns
WHERE table_name = $1;

-- Enhanced query for composite primary keys
SELECT
  tc.constraint_name,
  tc.table_name,
  kcu.column_name,
  kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
WHERE tc.table_name = $1
  AND tc.constraint_type = 'PRIMARY KEY'
ORDER BY kcu.ordinal_position;
```

**Inspector Logic Changes:**

1. **Composite detection** - Query for all primary key columns and their order
2. **Constraint naming** - Extract actual constraint names from database
3. **Unified representation** - Build `Table.primaryKey` object from query results
4. **Clean schema mapping** - Remove individual column primary key flags

### 4. Schema Differ Enhancements

**Primary Key Change Detection:**

```typescript
interface PrimaryKeyChange {
  type: "add" | "drop" | "modify";
  tableName: string;
  currentPK?: PrimaryKeyConstraint;
  desiredPK?: PrimaryKeyConstraint;
}
```

**Change Detection Logic:**

1. **No PK → PK**: Generate `ALTER TABLE ADD CONSTRAINT`
2. **PK → No PK**: Generate `ALTER TABLE DROP CONSTRAINT`
3. **PK → Different PK**: Generate `DROP CONSTRAINT` + `ADD CONSTRAINT`
4. **Same PK**: No changes needed

**SQL Generation Examples:**

```sql
-- Add primary key
ALTER TABLE users ADD CONSTRAINT pk_users PRIMARY KEY (id);

-- Drop primary key
ALTER TABLE users DROP CONSTRAINT pk_users;

-- Change primary key (composite example)
ALTER TABLE user_sessions DROP CONSTRAINT pk_user_sessions;
ALTER TABLE user_sessions ADD CONSTRAINT pk_user_sessions PRIMARY KEY (user_id, session_id);
```

### 5. Migration Execution Strategy

**Operation Ordering:**

1. **Data validation** - Check for NULL values and duplicates before adding PK
2. **Constraint dropping** - Drop conflicting constraints first
3. **Data preparation** - Handle any data conflicts
4. **Constraint addition** - Add new primary key constraints
5. **Cleanup** - Remove temporary objects if needed

**Error Handling:**

1. **Duplicate data detection** - Identify and report duplicate rows before PK creation
2. **NULL value detection** - Identify NULL values in primary key columns
3. **Constraint conflicts** - Handle existing unique constraints that conflict
4. **Rollback strategy** - Provide clear rollback instructions on failure

## Implementation Plan

### Phase 1: Core Infrastructure (Week 1)

1. **Type Definitions**

   - Add `PrimaryKeyConstraint` interface
   - Enhance `Table` interface with `primaryKey` field
   - Update utility functions for type handling

2. **Parser Enhancements**

   - Add table-level primary key parsing logic
   - Add constraint name extraction
   - Add validation for multiple primary key definitions

3. **Inspector Enhancements**
   - Implement composite primary key detection query
   - Update inspector to build `PrimaryKeyConstraint` objects
   - Remove column-level primary key flags from schema representation

### Phase 2: Differ Logic (Week 2)

1. **Change Detection**

   - Implement primary key comparison logic
   - Add primary key change type detection
   - Generate appropriate SQL statements

2. **SQL Generation**

   - Add `ALTER TABLE ADD CONSTRAINT PRIMARY KEY` generation
   - Add `ALTER TABLE DROP CONSTRAINT` generation
   - Handle constraint naming (auto-generated vs explicit)

3. **Operation Ordering**
   - Integrate primary key changes into existing migration planning
   - Handle dependencies between primary key changes and other operations

### Phase 3: Data Validation & Safety (Week 3)

1. **Pre-migration Validation**

   - Check for duplicate data before adding primary keys
   - Check for NULL values in primary key columns
   - Provide clear error messages and suggestions

2. **Conflict Resolution**

   - Handle existing unique constraints
   - Provide options for data cleanup
   - Support for manual conflict resolution

3. **Testing & Edge Cases**
   - Comprehensive test suite for all primary key scenarios
   - Edge case handling (empty tables, large tables, concurrent access)
   - Performance testing for large datasets

## Test Coverage Plan

### Unit Tests

1. **Parser Tests**

   - Column-level primary key parsing
   - Table-level primary key parsing (single and composite)
   - Named constraint parsing
   - Error handling for invalid syntax

2. **Inspector Tests**

   - Single column primary key detection
   - Composite primary key detection
   - Named constraint detection
   - Edge cases (no primary key, multiple constraints)

3. **Differ Tests**
   - Primary key addition scenarios
   - Primary key removal scenarios
   - Primary key modification scenarios
   - Complex migration scenarios with multiple changes

### Integration Tests

1. **End-to-End Scenarios**

   - Create table with composite primary key
   - Add primary key to existing table
   - Change primary key columns
   - Remove primary key entirely

2. **Data Integrity Tests**

   - Primary key with existing data
   - Duplicate data handling
   - NULL value handling
   - Large dataset performance

3. **Error Scenarios**
   - Constraint violation handling
   - Rollback scenarios
   - Concurrent modification handling

## Migration Examples

### Example 1: Add Primary Key to Existing Table

**Before (schema.sql):**

```sql
CREATE TABLE logs (
  id INTEGER,
  message TEXT,
  created_at TIMESTAMP
);
```

**After (schema.sql):**

```sql
CREATE TABLE logs (
  id INTEGER,
  message TEXT,
  created_at TIMESTAMP,
  PRIMARY KEY (id)
);
```

**Generated Migration:**

```sql
ALTER TABLE logs ADD CONSTRAINT pk_logs PRIMARY KEY (id);
```

### Example 2: Change to Composite Primary Key

**Before:**

```sql
CREATE TABLE user_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  session_token VARCHAR(255)
);
```

**After:**

```sql
CREATE TABLE user_sessions (
  id SERIAL,
  user_id INTEGER,
  session_token VARCHAR(255),
  PRIMARY KEY (user_id, session_token)
);
```

**Generated Migration:**

```sql
ALTER TABLE user_sessions DROP CONSTRAINT user_sessions_pkey;
ALTER TABLE user_sessions ADD CONSTRAINT pk_user_sessions PRIMARY KEY (user_id, session_token);
```

### Example 3: Remove Primary Key

**Before:**

```sql
CREATE TABLE temp_data (
  id SERIAL PRIMARY KEY,
  value TEXT
);
```

**After:**

```sql
CREATE TABLE temp_data (
  id SERIAL,
  value TEXT
);
```

**Generated Migration:**

```sql
ALTER TABLE temp_data DROP CONSTRAINT temp_data_pkey;
```

## Error Handling & User Experience

### Common Error Scenarios

1. **Duplicate Data Error**

   ```
   ✗ Cannot add primary key to table 'users': duplicate values found in column 'email'

   Conflicting rows:
   - Row 1: email = 'john@example.com' (id: 1, 5)
   - Row 2: email = 'jane@example.com' (id: 3, 7)

   Suggestions:
   - Remove duplicate rows manually
   - Use a different column for primary key
   - Add UNIQUE constraint instead of PRIMARY KEY
   ```

2. **NULL Values Error**

   ```
   ✗ Cannot add primary key to table 'users': NULL values found in primary key columns

   NULL values found:
   - Column 'user_id': 3 rows with NULL values
   - Column 'session_id': 1 row with NULL value

   Suggestion: Update NULL values before adding primary key constraint
   ```

3. **Constraint Conflict Error**

   ```
   ✗ Cannot modify primary key: existing constraint 'users_email_unique' conflicts

   Resolution: Drop conflicting constraints first or choose different columns
   ```

### User Guidance

1. **Preview Mode Enhancements**

   - Show potential data conflicts in `plan` command
   - Display validation results before migration
   - Provide actionable suggestions for resolving conflicts

2. **Interactive Resolution**
   - Option to automatically handle common conflicts
   - Guided conflict resolution workflow
   - Safe rollback options

## Success Metrics

### Functional Success

1. **Feature Completeness** - All primary key scenarios supported
2. **Data Safety** - Zero data loss during primary key migrations
3. **Error Handling** - Clear, actionable error messages
4. **Performance** - Primary key operations complete within acceptable time limits

### Developer Experience

1. **API Consistency** - Primary key handling follows existing PGTerra patterns
2. **Documentation** - Comprehensive examples and troubleshooting guides
3. **Test Coverage** - >95% test coverage for primary key functionality
4. **Error Recovery** - Clear rollback procedures for failed migrations

## Conclusion

This design provides a comprehensive approach to primary key support in PGTerra, addressing current limitations with a clean, unified approach. The phased implementation approach ensures steady progress with thorough testing at each stage.

The focus on data safety, clear error handling, and user experience ensures that primary key migrations are both powerful and safe for production use.
