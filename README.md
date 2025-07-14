# PgTerra

Infrastructure as Code for PostgreSQL databases. Define your schema in SQL, let PgTerra handle the migrations.

## Example

**Step 1: Define your schema**

```sql
-- schema.sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Step 2: Plan changes**

```bash
$ bun run plan
📋 Analyzing schema changes...
📝 Found 2 change(s) to apply:

Transactional changes:
  1. CREATE TABLE users (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL, name VARCHAR(100) NOT NULL, created_at TIMESTAMP DEFAULT NOW())
  2. CREATE TABLE posts (id SERIAL PRIMARY KEY, title VARCHAR(255) NOT NULL, user_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW())
```

**Step 3: Apply changes**

```bash
$ bun run apply
🚀 Applying schema changes...
Applying transactional changes...
Executing: CREATE TABLE users (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL, name VARCHAR(100) NOT NULL, created_at TIMESTAMP DEFAULT NOW())
✓ Done
Executing: CREATE TABLE posts (id SERIAL PRIMARY KEY, title VARCHAR(255) NOT NULL, user_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW())
✓ Done
🎉 All changes applied successfully!
```

## Schema Evolution

**Update schema.sql:**

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  full_name VARCHAR(200) NOT NULL,  -- renamed from 'name'
  is_active BOOLEAN DEFAULT true,   -- new column
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Plan shows the diff:**

```bash
$ bun run plan
📋 Analyzing schema changes...
📝 Found 3 change(s) to apply:

Transactional changes:
  1. ALTER TABLE users ADD COLUMN full_name VARCHAR(200) NOT NULL
  2. ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT true
  3. ALTER TABLE users DROP COLUMN name
```

## Setup

```bash
# Install
bun install

# Configure database
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=postgres
export DB_USER=postgres
export DB_PASSWORD=postgres

# Use
bun run plan    # preview changes
bun run apply   # execute changes
```

## Development

```bash
bun run test:full       # run tests
```
