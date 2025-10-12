# Terra

Declarative schema management for Postgres. Define your desired schema, Terra handles the migrations.

## Quick Start

```bash
npm install -g terra
```

## How it works

**1. Start with a schema:**

```sql
-- schema.sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

```bash
terra apply  # Creates the table
```

**2. Update your schema declaratively:**

```sql
-- schema.sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  full_name VARCHAR(200) NOT NULL,  -- new column
  is_active BOOLEAN DEFAULT true,   -- another new column
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE posts (                 -- new table
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
```

**3. Terra calculates the migration:**

```bash
$ terra plan
📋 Analyzing schema changes...

Planned changes:
  1. ALTER TABLE users ADD COLUMN full_name VARCHAR(200) NOT NULL
  2. ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT true
  3. CREATE TABLE posts (id SERIAL PRIMARY KEY, title VARCHAR(255) NOT NULL, user_id INTEGER REFERENCES users(id), created_at TIMESTAMP DEFAULT NOW())

$ terra apply  # Applies the changes safely
```

**That's it.** No migration files, no manual ALTER statements, no dependency ordering. Just define what you want.

## Configuration

Set your database connection:

```bash
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=mydb
export DB_USER=postgres
export DB_PASSWORD=password
```

## Features

- ✅ Tables, columns, and data types
- ✅ Primary keys, foreign keys, check constraints, unique constraints  
- ✅ Indexes (btree, gin, gist, partial, expression-based)
- ✅ ENUM types
- ✅ Dependency resolution for complex schemas
- ✅ Data-safe migrations with validation
- ✅ Destructive operation protection

## Why declarative?

Like Terraform for infrastructure, Terra lets you define *what* you want, not *how* to get there:

- **Version control your complete schema** - not scattered migration files
- **No migration ordering issues** - Terra handles dependencies
- **Easier code reviews** - see the full schema state, not just changes
- **Safe schema changes** - preview before applying, with rollback support

## Development

```bash
git clone https://github.com/elitan/terra.git
cd terra
bun install

# Set up test database connection
export DATABASE_URL="postgres://user:password@localhost:5432/test_db"

# Run tests
bun test
```

**Note:** Tests require a `DATABASE_URL` environment variable pointing to a PostgreSQL database. The tests will create and drop tables as needed, so use a dedicated test database.