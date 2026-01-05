# dbterra

Declarative schema management for PostgreSQL and SQLite.

## Install

```bash
npm install -g dbterra
```

## Quick Start

### PostgreSQL

```sql
-- schema.sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE
);
```

```bash
export DATABASE_URL="postgres://user:password@localhost:5432/mydb"
dbterra plan   # preview changes
dbterra apply  # apply changes
```

### SQLite

```sql
-- schema.sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);
```

```bash
export DATABASE_URL="sqlite:///path/to/database.db"
dbterra plan
dbterra apply
```

## How It Works

1. Write your desired schema as CREATE statements
2. Run `dbterra plan` to see what changes are needed
3. Run `dbterra apply` to execute the changes

dbterra compares your schema file against the current database state and generates the necessary ALTER/DROP/CREATE statements.

## Configuration

### PostgreSQL

```bash
export DATABASE_URL="postgres://user:password@localhost:5432/mydb"
```

Or individual variables:

```bash
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=mydb
export DB_USER=postgres
export DB_PASSWORD=password
```

### SQLite

```bash
export DATABASE_URL="sqlite:///path/to/database.db"
# or
export DATABASE_URL="/path/to/database.db"
# or in-memory
export DATABASE_URL=":memory:"
```

## Feature Support

| Feature | PostgreSQL | SQLite |
|---------|------------|--------|
| Tables & Columns | Yes | Yes |
| Primary Keys | Yes | Yes |
| Foreign Keys | Yes | Yes |
| Indexes | Yes | Yes |
| Unique Constraints | Yes | Yes |
| Check Constraints | Yes | Yes |
| Views | Yes | Yes |
| ENUM Types | Yes | No |
| Sequences | Yes | No |
| Functions | Yes | No |
| Procedures | Yes | No |
| Triggers | Yes | No |
| Materialized Views | Yes | No |
| Schemas | Yes | No |
| Extensions | Yes | No |

SQLite uses table recreation for schema changes that ALTER TABLE doesn't support (column type changes, constraint modifications, etc.).

## Commands

```bash
dbterra plan                    # Preview changes
dbterra plan -f custom.sql      # Use custom schema file
dbterra apply                   # Apply changes
dbterra apply -f custom.sql     # Apply from custom file
```

## Examples

### Constraints

```sql
-- Primary keys
id SERIAL PRIMARY KEY           -- PostgreSQL
id INTEGER PRIMARY KEY          -- SQLite

-- Foreign keys
CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE

-- Check constraints
CONSTRAINT check_positive CHECK (quantity > 0)

-- Unique constraints
CONSTRAINT unique_email UNIQUE (email)
```

### Indexes

```sql
CREATE INDEX idx_email ON users (email);
CREATE INDEX idx_active ON users (email) WHERE active = true;  -- partial index
CREATE UNIQUE INDEX idx_unique_email ON users (email);
```

### PostgreSQL-only Features

```sql
-- ENUM types
CREATE TYPE status AS ENUM ('pending', 'active', 'inactive');

-- Views
CREATE VIEW active_users AS SELECT * FROM users WHERE active = true;
CREATE MATERIALIZED VIEW user_stats AS SELECT COUNT(*) FROM users;

-- Functions
CREATE FUNCTION add(a INT, b INT) RETURNS INT AS $$ SELECT a + b $$ LANGUAGE SQL;

-- Sequences
CREATE SEQUENCE custom_seq START 1000 INCREMENT 1;
```

## Development

Requires [Bun](https://bun.sh):

```bash
git clone https://github.com/elitan/dbterra.git
cd dbterra
bun install

# PostgreSQL tests
docker compose up -d
bun test

# SQLite tests (no docker needed)
bun test src/test/sqlite/
```

## License

MIT
