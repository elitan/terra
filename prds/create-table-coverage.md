# CREATE TABLE Statement Coverage PRD

## Overview

This document outlines comprehensive test coverage requirements for CREATE TABLE statement parsing in PG Terra. The goal is to ensure our parser can handle all realistic PostgreSQL CREATE TABLE scenarios that users might encounter.

## Current Test Coverage Analysis

### ✅ Currently Tested Scenarios

**Basic Table Creation:**

- Simple table with basic column types (SERIAL, VARCHAR, INTEGER, BOOLEAN, TIMESTAMP)
- Multiple tables in same schema file
- Primary key columns (SERIAL PRIMARY KEY)
- NOT NULL constraints
- DEFAULT values (literals and functions like NOW())

**Column Types Tested:**

- SERIAL
- VARCHAR(n)
- INTEGER
- BOOLEAN
- TIMESTAMP

**Constraints Tested:**

- PRIMARY KEY
- NOT NULL
- DEFAULT values

### ❌ Missing Test Scenarios

## 1. Data Types Coverage

### Numeric Types

- [ ] **BIGINT** - Large integers
- [ ] **SMALLINT** - Small integers
- [ ] **DECIMAL(p,s)** - Fixed precision decimals
- [ ] **NUMERIC(p,s)** - Alias for DECIMAL
- [ ] **REAL** - Single precision floating point
- [ ] **DOUBLE PRECISION** - Double precision floating point
- [ ] **BIGSERIAL** - Auto-incrementing big integers
- [ ] **SMALLSERIAL** - Auto-incrementing small integers

### String Types

- [ ] **TEXT** - Variable unlimited length
- [ ] **CHAR(n)** - Fixed length strings
- [ ] **CHARACTER(n)** - Alias for CHAR
- [ ] **CHARACTER VARYING(n)** - Full form of VARCHAR

### Date/Time Types

- [ ] **DATE** - Date only
- [ ] **TIME** - Time only
- [ ] **TIME WITH TIME ZONE** - Time with timezone
- [ ] **TIMESTAMP WITH TIME ZONE** - Timestamp with timezone
- [ ] **INTERVAL** - Time intervals

### Other Common Types

- [ ] **UUID** - Universally unique identifiers
- [ ] **JSON** - JSON data
- [ ] **JSONB** - Binary JSON
- [ ] **BYTEA** - Binary data
- [ ] **INET** - IP addresses
- [ ] **CIDR** - Network addresses

## 2. Constraint Types

### Primary Key Variations

- [ ] **Composite primary keys** - PRIMARY KEY (col1, col2)
- [ ] **Named primary keys** - CONSTRAINT pk_name PRIMARY KEY (col)
- [ ] **Primary key without SERIAL** - INTEGER PRIMARY KEY

### Foreign Key Constraints

- [ ] **Basic foreign key** - REFERENCES other_table(column)
- [ ] **Named foreign key** - CONSTRAINT fk_name FOREIGN KEY ...
- [ ] **Foreign key with actions** - ON DELETE CASCADE, ON UPDATE RESTRICT
- [ ] **Composite foreign keys** - Multiple column references

### Unique Constraints

- [ ] **Column-level UNIQUE** - column_name TYPE UNIQUE
- [ ] **Table-level UNIQUE** - UNIQUE (column_name)
- [ ] **Composite unique** - UNIQUE (col1, col2)
- [ ] **Named unique constraint** - CONSTRAINT uk_name UNIQUE (col)

### Check Constraints

- [ ] **Simple check** - CHECK (column > 0)
- [ ] **Complex check** - CHECK (column IN ('A', 'B', 'C'))
- [ ] **Named check** - CONSTRAINT ck_name CHECK (...)

### Null Constraints

- [ ] **Explicit NULL** - column_name TYPE NULL (rarely used)
- [ ] **Mixed null/not null** in same table

## 3. Default Value Variations

### Literal Defaults

- [ ] **String literals** - DEFAULT 'text value'
- [ ] **Numeric literals** - DEFAULT 42, DEFAULT 3.14
- [ ] **Boolean literals** - DEFAULT TRUE, DEFAULT FALSE
- [ ] **NULL default** - DEFAULT NULL

### Function Defaults

- [ ] **Current timestamp** - DEFAULT CURRENT_TIMESTAMP
- [ ] **Current date** - DEFAULT CURRENT_DATE
- [ ] **Current time** - DEFAULT CURRENT_TIME
- [ ] **UUID generation** - DEFAULT gen_random_uuid()
- [ ] **Custom functions** - DEFAULT my_function()

### Expression Defaults

- [ ] **Mathematical expressions** - DEFAULT (price \* 1.1)
- [ ] **String expressions** - DEFAULT UPPER(some_value)

## 4. Column Definition Edge Cases

### Case Sensitivity

- [ ] **Mixed case table names** - Create Table Users
- [ ] **Mixed case column names** - userId, firstName
- [ ] **Quoted identifiers** - "table name", "column name"

### Whitespace Handling

- [ ] **Extra whitespace** - CREATE TABLE users
- [ ] **Tabs and newlines** - Various formatting styles
- [ ] **Inline comments** - column_name TYPE -- comment

### Special Characters

- [ ] **Underscores in names** - table_name, column_name
- [ ] **Numbers in names** - table1, column2
- [ ] **Reserved word handling** - "order", "user", "group"

## 5. Complex Table Definitions

### Multi-line Formatting

- [ ] **Different indentation styles**
- [ ] **Trailing commas** - column_name TYPE,
- [ ] **Comments between columns** - /_ comment _/

### Large Tables

- [ ] **Many columns** (20+ columns)
- [ ] **Long column names**
- [ ] **Complex constraint combinations**

### Table Options

- [ ] **IF NOT EXISTS** - CREATE TABLE IF NOT EXISTS
- [ ] **TEMPORARY tables** - CREATE TEMPORARY TABLE
- [ ] **UNLOGGED tables** - CREATE UNLOGGED TABLE

## 6. Error Handling Scenarios

### Malformed SQL

- [ ] **Missing parentheses** - CREATE TABLE users id SERIAL;
- [ ] **Missing column type** - CREATE TABLE users (id);
- [ ] **Invalid syntax** - CREATE TABLE (users);
- [ ] **Unclosed statements** - CREATE TABLE users ( id SERIAL

### Edge Cases

- [ ] **Empty tables** - CREATE TABLE users ();
- [ ] **Duplicate column names** - id SERIAL, id INTEGER
- [ ] **Invalid type names** - column_name INVALID_TYPE

## 7. Parser Robustness

### Real-world SQL Variations

- [ ] **SQL comments** - -- and /\* \*/ style comments
- [ ] **Mixed statement separators** - ; with extra whitespace
- [ ] **Different line endings** - Windows (CRLF) vs Unix (LF)

### Schema Files

- [ ] **Multiple CREATE statements** in complex order
- [ ] **Non-CREATE statements** mixed in (should be ignored)
- [ ] **Schema with views, indexes** (should be ignored for now)

## 8. Integration Scenarios

### Database Compatibility

- [ ] **PostgreSQL-specific types** - SERIAL, BIGSERIAL
- [ ] **Standard SQL types** - INTEGER, VARCHAR
- [ ] **Type aliases** - INT for INTEGER, BOOL for BOOLEAN

### Migration Scenarios

- [ ] **Adding tables with dependencies** - Foreign key order matters
- [ ] **Complex column additions** - Multiple constraints
- [ ] **Table recreation** - Drop and recreate scenarios

## Test Implementation Strategy

### Priority Levels

**P0 (Critical - Must Have):**

- All basic data types (numeric, string, date/time)
- Primary key variations
- Foreign key constraints
- Default value types
- Case sensitivity handling

**P1 (Important - Should Have):**

- Unique constraints
- Check constraints
- Complex formatting scenarios
- Error handling for malformed SQL

**P2 (Nice to Have - Could Have):**

- Advanced PostgreSQL types (JSON, UUID, etc.)
- Table options (TEMPORARY, IF NOT EXISTS)
- Very complex multi-constraint scenarios

### Test Organization

```
src/test/parser/
├── basic-types.test.ts          # P0: Basic data types
├── constraints.test.ts          # P0: Primary/Foreign keys
├── defaults.test.ts            # P0: Default values
├── formatting.test.ts          # P1: Whitespace, case sensitivity
├── advanced-types.test.ts      # P2: JSON, UUID, etc.
├── edge-cases.test.ts          # P1: Error scenarios
└── integration.test.ts         # P0: Complex real-world scenarios
```

## Success Criteria

1. **Parser can handle all P0 scenarios** without errors
2. **Error handling gracefully manages** malformed SQL
3. **Generated DDL matches** PostgreSQL expectations
4. **Integration tests pass** with real database
5. **Performance acceptable** for large schema files (100+ tables)

## Future Considerations

- **MySQL compatibility** - Different type mappings
- **SQLite support** - Simplified type system
- **Advanced PostgreSQL features** - Partitioning, inheritance
- **Schema validation** - Catch logical errors before apply
