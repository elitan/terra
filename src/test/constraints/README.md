# Constraint Tests

This directory contains comprehensive tests for PostgreSQL constraint features that need to be implemented in the schema management tool.

## Test Files

- **foreign-keys.test.ts** - Foreign key constraint operations
- **check-constraints.test.ts** - Check constraint validation  
- **unique-constraints.test.ts** - Unique constraint enforcement

## Purpose

These tests are designed for **test-driven development** with AI assistance:

1. **Human verification**: A human should review and verify these tests are correct
2. **AI implementation**: Once verified, AI can implement features to make tests pass
3. **Comprehensive coverage**: Tests cover basic operations, edge cases, and error scenarios

## Test Categories

### Foreign Keys
- Basic foreign key creation and enforcement
- Composite foreign keys  
- ON DELETE/UPDATE actions (CASCADE, RESTRICT, SET NULL)
- Circular dependencies
- Self-referential relationships

### Check Constraints
- Simple value validation
- Complex multi-column checks
- Function-based constraints
- Date/time validations
- Cross-column logic

### Unique Constraints  
- Single and composite unique constraints
- NULL value handling
- Column-level vs table-level constraints
- Deferrable constraints
- Distinction from unique indexes

## Implementation Requirements

These tests expect the following to be implemented:

1. **Schema Types**: Extended type definitions for constraints
2. **Parser Support**: CST parsing of constraint syntax
3. **Differ Logic**: Constraint comparison and change detection
4. **SQL Generation**: Proper DDL for constraint operations
5. **Dependency Resolution**: Correct ordering of constraint operations

## Usage

Run tests to verify current implementation:
```bash
bun test src/test/constraints/
```

Individual test files can be run separately during development:
```bash
bun test src/test/constraints/foreign-keys.test.ts
```