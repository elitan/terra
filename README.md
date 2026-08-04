# terradb

Declarative schema management for PostgreSQL and SQLite.

## Install

```bash
npm install -g terradb
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
terradb plan -f schema.sql   # preview changes
terradb apply -f schema.sql  # apply changes
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
export DATABASE_URL="sqlite:///absolute/path/to/database.db"
terradb plan -f schema.sql
terradb apply -f schema.sql
```

## How It Works

1. Write your desired schema as CREATE statements
2. Run `terradb plan` to see what changes are needed
3. Run `terradb apply` to execute the changes

terradb compares your schema file against the current database state and generates the necessary ALTER/DROP/CREATE statements.

## Configuration

### PostgreSQL

```bash
export DATABASE_URL="postgres://user:password@localhost:5432/mydb"
```

PostgreSQL URLs may use either the `postgres://` or `postgresql://` scheme.
Percent-encode special characters in the user, password, database name, or
Unix-socket host. TerraDB preserves driver parameters such as
`application_name`, `connect_timeout`, `keepalives`, and TLS certificate paths.
The supported TLS modes follow `node-postgres`: `disable`, `prefer`, `require`,
`verify-ca`, `verify-full`, and `no-verify`; other values fail before a
connection is attempted. Multi-host libpq URLs are not supported by the driver,
so use a single load-balanced or failover endpoint.

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
export DATABASE_URL="sqlite:///absolute/path/to/database.db"
# or an absolute/relative filename
export DATABASE_URL="/path/to/database.db"
# or an official SQLite file URI (including supported URI parameters)
export DATABASE_URL="file:/path/to/database.db?mode=rwc"
# or in-memory
export DATABASE_URL=":memory:"
```

## Feature Support

| Feature | PostgreSQL | SQLite |
|---------|------------|--------|
| Tables & Columns | Yes | Yes |
| Generated Columns | Yes | Yes |
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
| Triggers | Yes | Yes |
| Materialized Views | Yes | No |
| Schemas | Yes | No |
| Extensions | Yes | No |

PostgreSQL 14 through 18 are supported. Stored generated columns work across
that range; virtual generated columns are supported on PostgreSQL 18 and fail
before mutation on older servers.
PostgreSQL 18 `NOT ENFORCED` constraints, temporal constraints using `WITHOUT
OVERLAPS` or `PERIOD`, and named, table-level, `NO INHERIT`, or `NOT VALID`
`NOT NULL` forms are outside the current declarative constraint model. TerraDB
rejects those clauses while parsing desired schemas. During inspection it also
rejects `NOT ENFORCED`, temporal, and `NOT NULL NO INHERIT`/`NOT VALID` catalog
flags in managed external tables before diffing. An ordinary externally named
`NOT NULL` is normalized to column nullability because its name is not part of
the declarative model. Enforced `CHECK` and foreign-key constraints may still
be declared `NOT VALID`, and ordinary unnamed column `NOT NULL` remains fully
supported.

SQLite uses table recreation for schema changes that ALTER TABLE doesn't support (column type changes, constraint modifications, etc.).
Table recreation preserves hidden ROWID values and SQLite-specific definitions including `STRICT`, `WITHOUT ROWID`, `AUTOINCREMENT`, collations, named constraints, and `ON CONFLICT` policies. It validates foreign keys and database integrity before commit, enforces CHECK constraints during migration even when the caller disabled enforcement, and disables `writable_schema` so ALTER operations cannot silently ignore malformed schema entries. It then restores the caller's `foreign_keys`, `defer_foreign_keys`, `ignore_check_constraints`, and `writable_schema` settings. Recreation fails before mutation when declared columns shadow every SQL-visible ROWID name and exact row identity cannot be transferred safely.
SQLite virtual tables are managed losslessly; bundled FTS5 and RTree modules are covered, while their implementation-owned shadow tables are never managed as user tables.
SQLite desired schemas accept top-level `CREATE` statements and manage the persistent `main` database only. Imperative SQL, connection-local temporary objects, and external-database statements are rejected before migration planning; DML inside trigger bodies remains supported.
PostgreSQL desired schemas also describe persistent database state. Session-local temporary tables, views, and sequences are rejected before migration planning instead of being converted into persistent objects. Query-derived tables created with `CREATE TABLE AS` or `SELECT INTO` are also rejected because their structure and optional initial data cannot be reconciled declaratively; define their table structure explicitly and load data separately. `CREATE TABLE LIKE` and typed `CREATE TABLE OF` declarations must likewise be expanded to explicit columns and constraints so copied options or persistent type dependencies are never discarded. Other top-level data, query, session, transaction, maintenance, and untracked DDL commands fail explicitly instead of being silently ignored; SQL inside managed routine bodies remains supported.
Ordinary PostgreSQL `UNLOGGED` tables are lifecycle-supported. `UNLOGGED`
partitioned parents and explicit unlogged leaf partitions are rejected before
planning: PostgreSQL 18 disallows unlogged partitioned parents, while earlier
versions do not propagate parent persistence consistently and TerraDB does not
model mixed-persistence partition hierarchies. Equivalent external catalog
state on PostgreSQL 14–17 is also rejected before diffing.
PostgreSQL partition definitions are compared through PostgreSQL's parsed
representation and TerraDB's semantic column model, so equivalent identifier
quoting, type aliases, formatting, implicit `public` qualification, catalog
collation qualification, default-expression casts, identity-sequence expansion,
and explicit `NULL` converge after inspection. Partition keys also normalize
`pg_catalog` qualification, same-type casts simplified by PostgreSQL, and
effective default or non-default operator classes without hiding meaningful key
changes. A change only
to a leaf partition bound uses transactional `DETACH PARTITION` and `ATTACH
PARTITION` statements, preserving the partition table and its rows. If the new
bound rejects existing rows, the transaction rolls back to the prior attached
partition and bound. Other in-place partition-definition replacements fail
before execution instead of dropping and recreating a potentially populated
partition hierarchy.
Leaf partition bounds support canonical uncast literal values, `NULL`,
`MINVALUE`/`MAXVALUE`, hash modulus/remainder bounds, and `DEFAULT`. Explicit
casts and other evaluated bound expressions are rejected before mutation because
PostgreSQL stores only their one-time result, so the original expression cannot
be inspected or reconciled declaratively.
The supported partition contract is a basic partitioned parent with explicitly
named table-level key/check constraints and direct `CREATE TABLE ... PARTITION
OF` leaves. Parent foreign keys, unnamed or inline key/check/reference
constraints, `IF NOT EXISTS`, subpartitions, leaf column overrides or local
constraints, foreign-table partitions, partition access methods, storage
parameters, tablespaces, and parent column `STORAGE` or `COMPRESSION` settings
are rejected before mutation because TerraDB cannot yet inspect and order them
losslessly. Legacy `serial` pseudo-types are also rejected on partitioned parents;
use an identity column so sequence semantics remain declarative. Imperative
`ALTER TABLE ... ATTACH/DETACH PARTITION` commands are
also rejected in desired schemas; add or remove the declarative leaf instead.
Equivalent unsupported state created outside TerraDB is detected from the
PostgreSQL catalogs and rejected before diffing.

## Commands

```bash
terradb plan -f schema.sql      # Preview changes
terradb plan -f custom.sql      # Use custom schema file
terradb apply -f schema.sql     # Apply changes
terradb apply -f custom.sql     # Apply from custom file
terradb plan -f schema.sql --format json
terradb apply -f schema.sql --dry-run --format json
terradb apply -f schema.sql --no-color
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
CREATE INDEX idx_email_bytewise ON users (email COLLATE "C");  -- PostgreSQL
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
git clone https://github.com/elitan/terradb.git
cd terradb
bun install

# check local test env
bun run test:doctor

# PostgreSQL tests
docker compose up -d
bun run test:pg:18

# PostgreSQL matrix
bun run test:pg:14
bun run test:pg:15
bun run test:pg:16
bun run test:pg:17
bun run test:pg:18

# Extension tests
bun run test:pg:extensions

# SQLite tests (no docker needed)
bun run test:sqlite

# full PR matrix
bun run test:matrix:pr
```

Testing docs:

- `docs/testing-roadmap.md`
- `docs/test-matrix.md`
- `docs/pg-version-variance.md`

## License

MIT
