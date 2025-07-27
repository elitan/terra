# Foreign Key Constraints in pgterra

This document showcases the comprehensive Foreign Key Constraints support in pgterra. FK constraints are fully implemented with complete parsing, migration generation, and SQL execution capabilities.

## Basic Foreign Key Constraints

### Simple Foreign Key Reference

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title VARCHAR(255) NOT NULL,
  CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### Foreign Key with Referential Actions

```sql
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL,
  name VARCHAR(255) NOT NULL,
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) 
    REFERENCES categories(id) ON DELETE CASCADE ON UPDATE RESTRICT
);
```

## Advanced Foreign Key Scenarios

### Composite Foreign Keys

```sql
CREATE TABLE departments (
  company_id INTEGER NOT NULL,
  dept_id INTEGER NOT NULL,
  name VARCHAR(100) NOT NULL,
  PRIMARY KEY (company_id, dept_id)
);

CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  dept_id INTEGER NOT NULL,
  name VARCHAR(100) NOT NULL,
  CONSTRAINT fk_employees_department 
    FOREIGN KEY (company_id, dept_id) 
    REFERENCES departments(company_id, dept_id)
);
```

### Self-Referencing Foreign Keys

```sql
CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  manager_id INTEGER,
  name VARCHAR(100) NOT NULL,
  CONSTRAINT fk_employees_manager FOREIGN KEY (manager_id) REFERENCES employees(id)
);
```

### Circular Foreign Key Dependencies

```sql
CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  department_id INTEGER,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE departments (
  id SERIAL PRIMARY KEY,
  head_employee_id INTEGER,
  name VARCHAR(100) NOT NULL,
  CONSTRAINT fk_departments_head FOREIGN KEY (head_employee_id) REFERENCES employees(id)
);

-- Add the constraint for employees after both tables exist
ALTER TABLE employees 
ADD CONSTRAINT fk_employees_department 
FOREIGN KEY (department_id) REFERENCES departments(id);
```

## Referential Actions Support

pgterra supports all PostgreSQL referential actions:

### ON DELETE Actions
- `CASCADE`: Delete dependent rows
- `RESTRICT`: Prevent deletion if dependent rows exist
- `SET NULL`: Set FK column to NULL
- `SET DEFAULT`: Set FK column to default value
- `NO ACTION`: Same as RESTRICT (default)

### ON UPDATE Actions
- `CASCADE`: Update dependent rows
- `RESTRICT`: Prevent update if dependent rows exist
- `SET NULL`: Set FK column to NULL
- `SET DEFAULT`: Set FK column to default value
- `NO ACTION`: Same as RESTRICT (default)

### Example with All Actions

```sql
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER,
  status_id INTEGER DEFAULT 1,
  
  -- Different referential actions
  CONSTRAINT fk_orders_customer 
    FOREIGN KEY (customer_id) 
    REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,
    
  CONSTRAINT fk_orders_status 
    FOREIGN KEY (status_id) 
    REFERENCES order_statuses(id) ON DELETE SET DEFAULT ON UPDATE RESTRICT
);
```

## Migration Capabilities

pgterra automatically handles FK constraint migrations:

### Adding Foreign Keys
When you add FK constraints to your schema, pgterra generates the appropriate `ALTER TABLE ADD CONSTRAINT` statements.

### Removing Foreign Keys
When FK constraints are removed from your schema, pgterra generates `ALTER TABLE DROP CONSTRAINT` statements.

### Modifying Foreign Keys
When FK constraints change (different reference table, columns, or actions), pgterra:
1. Drops the old constraint
2. Adds the new constraint

## Complex Example: Blog System

```sql
-- Users table
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  username VARCHAR(50) NOT NULL UNIQUE
);

-- Categories with hierarchical structure
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  parent_id INTEGER,
  name VARCHAR(100) NOT NULL,
  CONSTRAINT fk_categories_parent 
    FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE
);

-- Posts with multiple FK relationships
CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  title VARCHAR(255) NOT NULL,
  content TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_posts_user 
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_posts_category 
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
);

-- Comments with nested replies
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  parent_comment_id INTEGER,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_comments_post 
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_comments_user 
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_comments_parent 
    FOREIGN KEY (parent_comment_id) REFERENCES comments(id) ON DELETE CASCADE
);

-- Tags and post_tags junction table
CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE post_tags (
  post_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, tag_id),
  
  CONSTRAINT fk_post_tags_post 
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_post_tags_tag 
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
```

## Implementation Details

### Parser Support (src/core/schema/parser.ts)
- Parses inline FK constraints in CREATE TABLE statements
- Extracts constraint names, referenced tables, columns, and referential actions
- Handles composite foreign keys and complex constraint definitions

### Schema Inspector (src/core/schema/inspector.ts)
- Reads existing FK constraints from PostgreSQL system catalogs
- Extracts all constraint details including referential actions
- Builds complete constraint definitions for schema comparison

### Schema Differ (src/core/schema/differ.ts)
- Compares FK constraints between current and desired schemas
- Generates appropriate migration statements for FK changes
- Handles constraint dependencies and ordering

### SQL Generation (src/utils/sql.ts)
- `generateAddForeignKeySQL()`: Creates ADD CONSTRAINT statements
- `generateDropForeignKeySQL()`: Creates DROP CONSTRAINT statements
- Properly formats constraint names and referential actions

## Testing

Comprehensive test coverage exists for FK constraints:
- Basic FK constraint creation and validation
- Composite foreign keys
- Self-referencing constraints
- Circular dependencies
- All referential actions (CASCADE, RESTRICT, SET NULL, SET DEFAULT)
- Migration generation and execution
- Error handling for invalid constraints

## Features Supported

✅ **Inline FK Constraints**: Define constraints directly in CREATE TABLE  
✅ **Named Constraints**: Custom constraint names  
✅ **Composite Foreign Keys**: Multi-column FK references  
✅ **Self-References**: Tables referencing themselves  
✅ **Circular Dependencies**: Complex dependency resolution  
✅ **All Referential Actions**: CASCADE, RESTRICT, SET NULL, SET DEFAULT, NO ACTION  
✅ **Migration Generation**: Automatic ADD/DROP CONSTRAINT statements  
✅ **Schema Inspection**: Reading existing constraints from database  
✅ **Constraint Comparison**: Detecting changes in FK definitions  
✅ **SQL Generation**: Proper formatting of constraint statements  

## Philosophy Alignment

FK constraints in pgterra follow the declarative philosophy:
- **Declarative**: Define what FK relationships should exist
- **Idempotent**: Same schema produces same result
- **Automatic**: pgterra figures out migration steps
- **Complete**: Full constraint definition in schema files

Users simply declare their desired FK constraints in CREATE TABLE statements, and pgterra handles all the migration complexity automatically.