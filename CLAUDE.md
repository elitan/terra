# CLAUDE.md

Guidelines for Claude Code when working in this repository.

## Core Principle

Terra is a **declarative** PostgreSQL schema management tool. Users write `CREATE TABLE/INDEX/VIEW/TYPE` statements defining their desired schema. Terra generates and executes the `ALTER` and `DROP` statements needed to reach that state.

### Supported (Declarative)

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title VARCHAR(255) NOT NULL,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### Not Supported (Imperative)

```sql
-- Parser rejects these
ALTER TABLE users ADD COLUMN email VARCHAR(255);
DROP TABLE old_table;
```

The **parser** only accepts `CREATE` statements. The **differ** generates `ALTER`/`DROP` statements.

## Parser Architecture

Modular parser using `sql-parser-cst`:

- `src/core/schema/parser/schema-parser.ts` - Main orchestrator
- `src/core/schema/parser/tables/table-parser.ts` - Table definitions
- `src/core/schema/parser/tables/column-parser.ts` - Column definitions
- `src/core/schema/parser/tables/constraint-parser.ts` - Constraints
- `src/core/schema/parser/index-parser.ts` - Indexes
- `src/core/schema/parser/enum-parser.ts` - ENUM types
- `src/core/schema/parser/view-parser.ts` - Views
- `src/core/schema/parser/expressions/` - Expression handling

Parser rejects `ALTER`/`DROP` statements with clear error messages (see schema-parser.ts:123-139).

## Development

**Use Bun, not npm.** Commands: `bun test`, `bun run dev`, `bun run build`

### Testing

Integration tests require PostgreSQL:

```bash
docker compose up -d
export DATABASE_URL="postgres://test_user:test_password@localhost:5487/sql_terraform_test"
bun test
```

Test database: `localhost:5487`, db: `sql_terraform_test`, user: `test_user`, password: `test_password`

Common commands:
- `bun test` - Main test suite
- `bun test src/test/views/` - Specific tests
- `bun run test:watch` - Watch mode
- `bun run test:full` - Full suite with Docker setup

### Running Terra

- `bun run plan` - Preview changes
- `bun run apply` - Execute changes
- `bun run dev` - Development mode with watch

## Architecture

### Layer Separation

```
CLI Layer (src/cli/)
  ↓ Commander.js commands
Core Layer (src/core/)
  ├─ Parser (SQL → TypeScript objects)
  ├─ Inspector (Database → TypeScript objects)
  ├─ Differ (Compare → Migration plan)
  └─ Executor (Migration plan → Database)
```

### Core Components

- **SchemaService** (`src/core/schema/service.ts`) - Orchestrates all operations
- **Parser** (`src/core/schema/parser/`) - Parses declarative SQL using `sql-parser-cst`
- **Inspector** (`src/core/schema/inspector.ts`) - Reads current database state
- **Differ** (`src/core/schema/differ.ts`) - Generates `ALTER`/`DROP` statements
- **Executor** (`src/core/migration/executor.ts`) - Executes migrations safely
- **DependencyResolver** (`src/core/schema/dependency-resolver.ts`) - Orders operations

### Migration Flow

1. Parse desired schema (SQL → Table/Index/View objects)
2. Inspect current database (Database → Table/Index/View objects)
3. Diff schemas (Generate MigrationPlan with transactional/concurrent statements)
4. Execute plan (Run statements with rollback support)

### Type System

`src/types/schema.ts` defines: Table, Column, Index, View, EnumType, constraints (PrimaryKey, ForeignKey, Check, Unique)

### Dependencies

- `sql-parser-cst` - SQL parsing
- `pg` - PostgreSQL client
- `commander` - CLI
- `chalk` - Colors
- `diff` - Text diffing

## Test Organization

Tests in `src/test/` organized by feature:

- `columns/` - Column operations (add, remove, modify, type conversions)
- `constraints/` - Foreign keys, check constraints, unique constraints
- `indexes/` - Basic, partial, expression, concurrent indexes
- `views/` - Views and materialized views
- `types/` - ENUM types
- `parser/` - Parser unit tests

Tests use complete declarative schemas, not imperative statements.

## Claude Code Behavior

**IMPORTANT:**

1. **Never create markdown files** (`.md`) after completing tasks
2. **Never use emojis** in code, output, error messages, or logs - NEVER
3. **Be direct** - provide answers without unnecessary confirmation or validation