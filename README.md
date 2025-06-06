# PG Terra

A proof-of-concept Infrastructure as Code tool for PostgreSQL databases, similar to Terraform but specifically designed for database schema management.

## Core Schema Objects

- [ ] **Tables**

  - Creation, alteration, dropping
  - Ownership, storage parameters, comments

- [ ] **Columns**

  - Creation, alteration (data type, default, nullability)
  - Dropping, NOT NULL/NULL, default values, collations, comments

- [ ] **Indexes**

  - Creation, alteration (REINDEX), dropping
  - Types: B-tree, GIN, GiST, BRIN, Hash
  - Unique, partial, expression, concurrent creation, storage parameters

- [ ] **Constraints**
  - [ ] **Primary Keys**: Creation, composite
  - [ ] **Foreign Keys**: Creation, ON DELETE/ON UPDATE actions (CASCADE, RESTRICT, SET NULL), DEFERRABLE
  - [ ] **Unique Constraints**: Creation
  - [ ] **Check Constraints**: CHECK clauses

---

## Advanced Schema Objects & Features

- [ ] **Sequences**

  - Creation, alteration (start, increment, min/max, cycle), dropping
  - Column ownership

- [ ] **Views**

  - Standard and Materialized: creation, OR REPLACE, dropping
  - Refresh for materialized views

- [ ] **Functions/Procedures (Routines)**

  - Creation, alteration (OR REPLACE), dropping
  - Language (PL/pgSQL, SQL), parameters, return types, volatility, security

- [ ] **Triggers**

  - Creation, enabling/disabling, dropping
  - BEFORE/AFTER/INSTEAD OF
  - FOR EACH ROW/STATEMENT
  - Event types: INSERT, UPDATE, DELETE, TRUNCATE
  - WHEN clause

- [ ] **Domains**

  - Creation, alteration, dropping
  - Underlying type, constraints

- [ ] **Enums (Enumerated Types)**

  - Creation, adding values

- [ ] **Composite Types**

  - Defining custom data structures

- [ ] **Extensions**

  - Enabling/disabling PostgreSQL extensions

- [ ] **Rules**

  - Creation, dropping

- [ ] **Collation Sequences**

  - Creating custom collations

- [ ] **Event Triggers**
  - Triggers on DDL events

---

## Database-Level Configuration & Management

- [ ] **Roles/Users and Permissions (Grants)**

  - Creation, alteration, dropping roles/users
  - Password management
  - Granting/revoking privileges on objects
  - Role memberships

- [ ] **Schemas (Namespaces)**

  - Creation, alteration, dropping
  - Ownership, search path

- [ ] **Tablespaces**

  - Creation, alteration, dropping

- [ ] **Database Properties**

  - Encoding, locale, connection limits, template database

- [ ] **Comments/Descriptions**
  - Associating comments with various database objects
