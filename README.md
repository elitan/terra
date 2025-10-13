<div align="center">
  <img src="assets/readme-hero.png" alt="Terra - Declarative PostgreSQL schema management" />
  <br />
  <br />
  <a href="https://github.com/elitan/terra/blob/main/LICENSE">
    <img alt="MIT License" src="https://img.shields.io/github/license/elitan/terra" />
  </a>
  <a href="https://github.com/elitan/terra/stargazers">
    <img alt="GitHub Stars" src="https://img.shields.io/github/stars/elitan/terra?style=social" />
  </a>
  <br />
  <a href="https://x.com/elitasson">
    <img alt="Twitter Follow" src="https://img.shields.io/twitter/follow/elitasson?style=social" />
  </a>
</div>

<br />

# Terra

Declarative PostgreSQL schema management. 

## Install

```bash
npm install -g pgterra
```

## Usage

**1. Create schema.sql:**

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE
);
```

**2. Preview changes:**

```bash
terra plan
```

**3. Apply:**

```bash
terra apply
```

**4. Update schema.sql:**

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,        -- added
  active BOOLEAN DEFAULT true        -- added
);

CREATE TABLE posts (                 -- added
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  user_id INTEGER NOT NULL,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_user_email ON users (LOWER(email));  -- added
```

**5. Terra generates the ALTER statements:**

```bash
$ terra plan
ALTER TABLE users ADD COLUMN name VARCHAR(100) NOT NULL
ALTER TABLE users ADD COLUMN active BOOLEAN DEFAULT true
CREATE TABLE posts (...)
CREATE INDEX idx_user_email ON users (LOWER(email))

$ terra apply
```

## Configuration

Database connection via `DATABASE_URL` or individual variables:

```bash
export DATABASE_URL="postgres://user:password@localhost:5432/mydb"
```

Or:

```bash
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=mydb
export DB_USER=postgres
export DB_PASSWORD=password
```

## What's supported

**Tables & Columns:**
All PostgreSQL column types, default values, NOT NULL constraints

**Functions & Procedures:**
User-defined functions and procedures with full PostgreSQL feature support

**Triggers:**
Table triggers with BEFORE/AFTER/INSTEAD OF timing

**Sequences:**
Custom sequences with configurable properties

**Constraints:**
```sql
-- Primary keys
id SERIAL PRIMARY KEY

-- Foreign keys with actions
CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE

-- Check constraints
CONSTRAINT check_positive CHECK (quantity > 0)

-- Unique constraints
email VARCHAR(255) UNIQUE
CONSTRAINT unique_email UNIQUE (email, domain)
```

**Indexes:**
```sql
-- Basic
CREATE INDEX idx_email ON users (email);

-- Partial
CREATE INDEX idx_active_users ON users (email) WHERE active = true;

-- Expression
CREATE INDEX idx_lower_email ON users (LOWER(email));

-- Concurrent (built automatically when safe)
```

**ENUM types:**
```sql
CREATE TYPE status AS ENUM ('pending', 'active', 'inactive');

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  status status NOT NULL
);
```

**Views:**
```sql
CREATE VIEW active_users AS
SELECT id, email FROM users WHERE active = true;

CREATE MATERIALIZED VIEW user_stats AS
SELECT COUNT(*) as total FROM users;
```

**Functions:**
```sql
CREATE FUNCTION calculate_total(quantity INT, price DECIMAL)
RETURNS DECIMAL
AS $$
  SELECT quantity * price
$$
LANGUAGE SQL IMMUTABLE;
```

**Procedures:**
```sql
CREATE PROCEDURE archive_old_posts(days_old INT)
LANGUAGE SQL
AS $$
  DELETE FROM posts WHERE created_at < NOW() - INTERVAL '1 day' * days_old;
$$;
```

**Triggers:**
```sql
-- First create a trigger function
CREATE FUNCTION update_modified_timestamp()
RETURNS TRIGGER
AS $$
  BEGIN
    NEW.modified_at = NOW();
    RETURN NEW;
  END;
$$
LANGUAGE plpgsql;

-- Then create the trigger
CREATE TRIGGER set_modified_timestamp
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_modified_timestamp();
```

**Sequences:**
```sql
CREATE SEQUENCE custom_id_seq
START 1000
INCREMENT 1
CACHE 20;
```

## Commands

```bash
terra plan                    # Preview changes
terra plan -f custom.sql      # Use custom schema file
terra apply                   # Apply changes
terra apply -f custom.sql     # Apply from custom file
```

## Development

Requires [Bun](https://bun.sh):

```bash
git clone https://github.com/elitan/terra.git
cd terra
bun install

# Start test database
docker compose up -d

# Run tests
export DATABASE_URL="postgres://test_user:test_password@localhost:5487/sql_terraform_test"
bun test
```

## License

MIT