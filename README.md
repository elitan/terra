# PG Terra

A proof-of-concept Infrastructure as Code tool for PostgreSQL databases, similar to Terraform but specifically designed for database schema management.

## Features

- **Schema as Code**: Define your database schema in a single `schema.sql` file
- **Plan & Apply**: Preview changes before applying them (like Terraform plan/apply)
- **Full Schema Management**:
  - Create new tables
  - Add new columns to existing tables
  - Drop removed columns
  - Drop removed tables
  - Detect column changes (type, nullable, defaults)

## Installation

```bash
bun install
```

## Configuration

Set your PostgreSQL connection details via environment variables:

```bash
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=your_database
export DB_USER=postgres
export DB_PASSWORD=your_password
```

## Usage

### 1. Create your schema.sql file

Define your desired database schema:

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content TEXT,
  user_id INTEGER NOT NULL,
  published BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 2. Plan your changes

See what changes would be applied without actually applying them:

```bash
bun run plan
# or with custom schema file:
bun run plan --file my-schema.sql
```

### 3. Apply changes

Apply the changes to your database:

```bash
bun run apply
# or with custom schema file:
bun run apply --file my-schema.sql
```

## How it works

1. **Parse**: The tool parses your `schema.sql` file to understand the desired schema
2. **Inspect**: It connects to your PostgreSQL database and inspects the current schema
3. **Diff**: It compares the desired vs current state and generates the necessary DDL statements
4. **Execute**: On apply, it runs the DDL statements in a transaction to safely update your database

## Example Workflow

```bash
# Start with an empty database
bun run plan
# Output: Found 3 change(s) to apply:
# 1. CREATE TABLE users (...)
# 2. CREATE TABLE posts (...)
# 3. CREATE TABLE comments (...)

# Apply the changes
bun run apply
# Output: All changes applied successfully!

# Modify schema.sql (add a column to users table)
# Add: age INTEGER DEFAULT 0

bun run plan
# Output: Found 1 change(s) to apply:
# 1. ALTER TABLE users ADD COLUMN age INTEGER DEFAULT 0;

bun run apply
# Output: All changes applied successfully!
```

## Current Limitations

This is a proof of concept with the following limitations:

- Basic SQL parsing (regex-based)
- Limited column modification support (shows TODO comments)
- No foreign key constraints yet
- No indexes management
- No data migration support
- PostgreSQL only

## Future Enhancements

- Better SQL parsing with AST
- Full column modification support (ALTER COLUMN)
- Index management
- Foreign key constraints
- Data migrations
- Multiple database support
- Rollback functionality
- Schema versioning

# pgterra
