# Column Testing PRD

## Overview

Column operations are one of the most complex and risky parts of database schema migrations. This document outlines comprehensive testing scenarios to ensure our PostgreSQL schema migration tool handles all column operations safely and correctly.

## Testing Philosophy

**Focus on real-world scenarios** - Test operations that developers actually perform, not just theoretical edge cases.

**Test outcomes, not implementation** - Verify the database ends up in the correct state, regardless of the specific SQL generated.

**Safety first** - Prioritize tests that prevent data loss or corruption.

## Test Categories

### 1. Basic Column Operations

#### 1.1 Adding Columns

- ✅ Add simple columns (VARCHAR, INTEGER, TEXT)
- ✅ Add columns with default values
- ✅ Add NOT NULL columns with defaults
- ⏳ Add columns with complex defaults (functions, expressions)
- ⏳ Add columns to tables with existing data
- ⏳ Add multiple columns in one migration

#### 1.2 Removing Columns

- ✅ Remove simple columns
- ✅ Remove multiple columns
- ⏳ Remove columns that are referenced by foreign keys
- ⏳ Remove columns that are part of indexes
- ⏳ Remove columns that are part of unique constraints
- ⏳ Remove primary key columns

#### 1.3 Renaming Columns

- ⏳ Rename simple columns
- ⏳ Rename columns with constraints
- ⏳ Rename columns referenced by foreign keys
- ⏳ Rename columns that are part of indexes

### 2. Data Type Changes

#### 2.1 Compatible Type Changes (No USING clause needed)

- ✅ VARCHAR to TEXT
- ⏳ VARCHAR(50) to VARCHAR(100) (expanding size)
- ⏳ INTEGER to BIGINT
- ⏳ DECIMAL(10,2) to DECIMAL(12,4) (expanding precision/scale)

#### 2.2 Incompatible Type Changes (USING clause required)

- ✅ VARCHAR to DECIMAL/NUMERIC
- ✅ VARCHAR to INTEGER
- ⏳ TEXT to INTEGER (with validation)
- ⏳ VARCHAR to BOOLEAN
- ⏳ INTEGER to VARCHAR
- ⏳ DECIMAL to INTEGER (with rounding)
- ⏳ VARCHAR(100) to VARCHAR(50) (truncating)

#### 2.3 Complex Type Changes

- ⏳ VARCHAR to ENUM
- ⏳ TEXT to JSON/JSONB
- ⏳ VARCHAR to TIMESTAMP
- ⏳ Array type changes
- ⏳ Custom type changes

### 3. Constraint Changes

#### 3.1 NULL/NOT NULL Constraints

- ✅ NULL to NOT NULL
- ✅ NOT NULL to NULL
- ⏳ NOT NULL with data validation (ensure no nulls exist)
- ⏳ NOT NULL with default value backfill

#### 3.2 Default Value Changes

- ✅ Adding default values
- ✅ Removing default values
- ✅ Changing default values
- ⏳ Function-based defaults (NOW(), UUID_GENERATE_V4())
- ⏳ Expression-based defaults
- ⏳ Defaults that reference other columns

#### 3.3 Check Constraints

- ⏳ Adding CHECK constraints
- ⏳ Removing CHECK constraints
- ⏳ Modifying CHECK constraints
- ⏳ CHECK constraints with data validation

#### 3.4 Unique Constraints

- ⏳ Adding UNIQUE constraints
- ⏳ Removing UNIQUE constraints
- ⏳ Multi-column UNIQUE constraints
- ⏳ UNIQUE constraints with data validation

### 4. Primary Key Operations

- ⏳ Adding primary key to table without one
- ⏳ Removing primary key
- ⏳ Changing primary key column
- ⏳ Multi-column primary keys
- ⏳ Primary key with SERIAL/GENERATED columns

### 5. Foreign Key Operations

- ⏳ Adding foreign key constraints
- ⏳ Removing foreign key constraints
- ⏳ Changing foreign key references
- ⏳ Multi-column foreign keys
- ⏳ Foreign keys with ON DELETE/UPDATE actions
- ⏳ Self-referencing foreign keys

### 6. Complex Multi-Operation Scenarios

#### 6.1 Multiple Changes to Same Column

- ✅ Type + Nullable + Default (all at once)
- ⏳ Type + Rename + Constraints
- ⏳ Constraints + Default + Size changes

#### 6.2 Multiple Columns in Same Migration

- ⏳ Add some columns, remove others, modify others
- ⏳ Reordering columns
- ⏳ Column dependencies (foreign keys between new columns)

#### 6.3 Cross-Table Dependencies

- ⏳ Foreign key changes across multiple tables
- ⏳ Removing referenced columns
- ⏳ Type changes that affect foreign key compatibility

### 7. Data Safety & Validation Tests

#### 7.1 Data Preservation

- ⏳ Ensure data is not lost during type conversions
- ⏳ Validate data integrity after migrations
- ⏳ Test with large datasets
- ⏳ Test with edge case data (nulls, special characters, etc.)

#### 7.2 Error Handling

- ⏳ Invalid type conversions (non-numeric string to INTEGER)
- ⏳ Constraint violations (duplicate values for UNIQUE)
- ⏳ Foreign key violations
- ⏳ Check constraint violations

#### 7.3 Rollback Scenarios

- ⏳ Rollback after successful migration
- ⏳ Rollback after failed migration
- ⏳ Partial rollback of multi-step operations

### 8. Performance & Scale Tests

- ⏳ Large table migrations (millions of rows)
- ⏳ Wide table migrations (hundreds of columns)
- ⏳ Concurrent access during migrations
- ⏳ Lock duration and blocking
- ⏳ Memory usage during type conversions

### 9. PostgreSQL-Specific Features

#### 9.1 Advanced Data Types

- ⏳ ENUM types
- ⏳ Array types
- ⏳ JSON/JSONB
- ⏳ Range types
- ⏳ Geometric types
- ⏳ Network address types

#### 9.2 Generated/Computed Columns

- ⏳ GENERATED ALWAYS AS columns
- ⏳ SERIAL and IDENTITY columns
- ⏳ Sequences and defaults

#### 9.3 Partitioned Tables

- ⏳ Column changes on partitioned tables
- ⏳ Partition key column changes
- ⏳ Adding/removing partition columns

### 10. Edge Cases & Error Conditions

#### 10.1 Naming Conflicts

- ⏳ Reserved keyword column names
- ⏳ Case sensitivity issues
- ⏳ Special characters in column names

#### 10.2 System Limitations

- ⏳ Maximum column name length
- ⏳ Maximum number of columns per table
- ⏳ Data type size limitations

#### 10.3 Transaction & Concurrency

- ⏳ DDL in transactions
- ⏳ Concurrent DDL operations
- ⏳ Lock conflicts and deadlocks

## Test Implementation Strategy

### Phase 1: Core Operations (Current)

Focus on the most common column operations that developers use daily:

- ✅ Add/remove columns
- ✅ Basic type changes
- ✅ Nullable/NOT NULL changes
- ✅ Default value changes
- ✅ Multi-operation scenarios

### Phase 2: Constraints & Relationships

- Check constraints
- Unique constraints
- Foreign keys
- Primary keys

### Phase 3: Advanced Types & Features

- PostgreSQL-specific data types
- Generated columns
- Performance testing

### Phase 4: Edge Cases & Error Handling

- Error conditions
- Rollback scenarios
- Concurrency testing

## Test Data Strategies

### Synthetic Data

- Generated test data for performance testing
- Edge case data (nulls, extremes, special characters)
- Large datasets for scale testing

### Real-world Scenarios

- Common application patterns
- Migration scenarios from actual projects
- Data patterns that commonly cause issues

## Success Criteria

For each test category:

1. **Functional**: The database ends up in the correct state
2. **Data Safety**: No data is lost or corrupted
3. **Performance**: Migrations complete in reasonable time
4. **Error Handling**: Clear error messages for invalid operations
5. **Rollback**: Ability to undo changes when possible

## Priority Matrix

| Category           | Frequency | Risk   | Priority |
| ------------------ | --------- | ------ | -------- |
| Add/Remove Columns | High      | Low    | High     |
| Type Changes       | Medium    | High   | High     |
| Nullable Changes   | High      | Medium | High     |
| Default Changes    | High      | Low    | Medium   |
| Constraints        | Medium    | High   | Medium   |
| Foreign Keys       | Medium    | High   | Medium   |
| Advanced Types     | Low       | Medium | Low      |
| Performance        | Low       | High   | Medium   |

## Notes

- **Legend**: ✅ Implemented, ⏳ Planned, ❌ Not planned
- This is a living document that should be updated as we implement features
- Focus on high-frequency, high-risk operations first
- Each test should follow the end-to-end pattern established in the current test suite
