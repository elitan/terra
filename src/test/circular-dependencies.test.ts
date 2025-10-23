import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../core/schema/service";
import { createTestClient, cleanDatabase, createTestDatabaseService } from "./utils";

describe("Circular Dependencies", () => {
  let client: Client;
  let schemaService: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    const databaseService = createTestDatabaseService();
    schemaService = new SchemaService(databaseService);
  });

  afterEach(async () => {
    await client.end();
  });

  describe("Two-table Cycles", () => {
    test("should handle authors ↔ books cycle", async () => {
      const schema = `
        CREATE TABLE authors (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          latest_book_id INTEGER,
          CONSTRAINT fk_latest_book FOREIGN KEY (latest_book_id) REFERENCES books(id)
        );

        CREATE TABLE books (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          author_id INTEGER NOT NULL,
          CONSTRAINT fk_author FOREIGN KEY (author_id) REFERENCES authors(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify tables exist
      const tables = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      expect(tables.rows.map(r => r.table_name)).toEqual(['authors', 'books']);

      // Verify both foreign keys exist
      const constraints = await client.query(`
        SELECT
          tc.table_name,
          tc.constraint_name,
          kcu.column_name,
          ccu.table_name as referenced_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
        ORDER BY tc.table_name, tc.constraint_name
      `);

      expect(constraints.rows).toHaveLength(2);

      // Test data insertion
      await client.query("INSERT INTO authors (name) VALUES ('Jane Austen')");
      await client.query("INSERT INTO books (title, author_id) VALUES ('Pride and Prejudice', 1)");
      await client.query("UPDATE authors SET latest_book_id = 1 WHERE id = 1");

      const book = await client.query("SELECT author_id FROM books WHERE id = 1");
      const author = await client.query("SELECT latest_book_id FROM authors WHERE id = 1");

      expect(book.rows[0].author_id).toBe(1);
      expect(author.rows[0].latest_book_id).toBe(1);
    });

    test("should handle departments ↔ employees cycle", async () => {
      const schema = `
        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          manager_id INTEGER,
          CONSTRAINT fk_manager FOREIGN KEY (manager_id) REFERENCES employees(id)
        );

        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          department_id INTEGER,
          CONSTRAINT fk_department FOREIGN KEY (department_id) REFERENCES departments(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify both FKs exist
      const constraints = await client.query(`
        SELECT COUNT(*) as fk_count
        FROM information_schema.table_constraints
        WHERE constraint_type = 'FOREIGN KEY'
      `);

      expect(constraints.rows[0].fk_count).toBe('2');

      // Test data insertion
      await client.query("INSERT INTO departments (name) VALUES ('Engineering')");
      await client.query("INSERT INTO employees (name, department_id) VALUES ('Alice', 1)");
      await client.query("UPDATE departments SET manager_id = 1 WHERE id = 1");

      const dept = await client.query("SELECT manager_id FROM departments WHERE id = 1");
      expect(dept.rows[0].manager_id).toBe(1);
    });
  });

  describe("Three-table Cycles", () => {
    test("should handle A → B → C → A cycle", async () => {
      const schema = `
        CREATE TABLE table_a (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          b_id INTEGER,
          CONSTRAINT fk_b FOREIGN KEY (b_id) REFERENCES table_b(id)
        );

        CREATE TABLE table_b (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          c_id INTEGER,
          CONSTRAINT fk_c FOREIGN KEY (c_id) REFERENCES table_c(id)
        );

        CREATE TABLE table_c (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          a_id INTEGER,
          CONSTRAINT fk_a FOREIGN KEY (a_id) REFERENCES table_a(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify all tables and FKs exist
      const tables = await client.query(`
        SELECT COUNT(*) as table_count
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `);

      expect(tables.rows[0].table_count).toBe('3');

      const constraints = await client.query(`
        SELECT COUNT(*) as fk_count
        FROM information_schema.table_constraints
        WHERE constraint_type = 'FOREIGN KEY'
      `);

      expect(constraints.rows[0].fk_count).toBe('3');

      // Test data insertion
      await client.query("INSERT INTO table_a (name) VALUES ('A')");
      await client.query("INSERT INTO table_b (name) VALUES ('B')");
      await client.query("INSERT INTO table_c (name, a_id) VALUES ('C', 1)");
      await client.query("UPDATE table_a SET b_id = 1 WHERE id = 1");
      await client.query("UPDATE table_b SET c_id = 1 WHERE id = 1");

      const result = await client.query("SELECT COUNT(*) as count FROM table_c WHERE a_id = 1");
      expect(result.rows[0].count).toBe('1');
    });
  });

  describe("Mixed Dependencies", () => {
    test("should handle tables with and without cycles", async () => {
      const schema = `
        -- No cycle
        CREATE TABLE categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );

        -- No cycle
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category_id INTEGER NOT NULL,
          CONSTRAINT fk_category FOREIGN KEY (category_id) REFERENCES categories(id)
        );

        -- Circular dependency between users and profiles
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) NOT NULL,
          profile_id INTEGER,
          CONSTRAINT fk_profile FOREIGN KEY (profile_id) REFERENCES profiles(id)
        );

        CREATE TABLE profiles (
          id SERIAL PRIMARY KEY,
          bio TEXT,
          user_id INTEGER,
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify all tables exist
      const tables = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      expect(tables.rows.map(r => r.table_name)).toEqual([
        'categories', 'products', 'profiles', 'users'
      ]);

      // Verify all FKs exist (1 for products->categories, 2 for users<->profiles cycle)
      const constraints = await client.query(`
        SELECT COUNT(*) as fk_count
        FROM information_schema.table_constraints
        WHERE constraint_type = 'FOREIGN KEY'
      `);

      expect(constraints.rows[0].fk_count).toBe('3');

      // Test data insertion
      await client.query("INSERT INTO categories (name) VALUES ('Electronics')");
      await client.query("INSERT INTO products (name, category_id) VALUES ('Laptop', 1)");
      await client.query("INSERT INTO users (username) VALUES ('alice')");
      await client.query("INSERT INTO profiles (bio, user_id) VALUES ('Developer', 1)");
      await client.query("UPDATE users SET profile_id = 1 WHERE id = 1");

      const result = await client.query("SELECT COUNT(*) as count FROM users WHERE profile_id IS NOT NULL");
      expect(result.rows[0].count).toBe('1');
    });
  });

  describe("Deletion with Cycles", () => {
    test("should drop tables involved in cycles", async () => {
      // First create tables with circular dependencies
      const createSchema = `
        CREATE TABLE teams (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          captain_id INTEGER,
          CONSTRAINT fk_captain FOREIGN KEY (captain_id) REFERENCES players(id)
        );

        CREATE TABLE players (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          team_id INTEGER,
          CONSTRAINT fk_team FOREIGN KEY (team_id) REFERENCES teams(id)
        );
      `;

      await schemaService.apply(createSchema, ['public'], true);

      // Insert some data
      await client.query("INSERT INTO teams (name) VALUES ('Red Team')");
      await client.query("INSERT INTO players (name, team_id) VALUES ('Alice', 1)");
      await client.query("UPDATE teams SET captain_id = 1 WHERE id = 1");

      // Now drop all tables
      const emptySchema = ``;

      await schemaService.apply(emptySchema, ['public'], true);

      // Verify all tables are gone
      const tables = await client.query(`
        SELECT COUNT(*) as table_count
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `);

      expect(tables.rows[0].table_count).toBe('0');
    });

    test("should drop some tables from a cycle", async () => {
      // Create tables with circular dependencies
      const createSchema = `
        CREATE TABLE nodes (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          parent_id INTEGER,
          next_id INTEGER,
          CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES nodes(id),
          CONSTRAINT fk_next FOREIGN KEY (next_id) REFERENCES nodes(id)
        );

        CREATE TABLE metadata (
          id SERIAL PRIMARY KEY,
          node_id INTEGER NOT NULL,
          value TEXT,
          CONSTRAINT fk_node FOREIGN KEY (node_id) REFERENCES nodes(id)
        );
      `;

      await schemaService.apply(createSchema, ['public'], true);

      // Now keep nodes but remove metadata
      const updatedSchema = `
        CREATE TABLE nodes (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          parent_id INTEGER,
          next_id INTEGER,
          CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES nodes(id),
          CONSTRAINT fk_next FOREIGN KEY (next_id) REFERENCES nodes(id)
        );
      `;

      await schemaService.apply(updatedSchema, ['public'], true);

      const tables = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      expect(tables.rows.map(r => r.table_name)).toEqual(['nodes']);
    });
  });

  describe("Self-referential with External Cycles", () => {
    test("should handle self-referential FK and circular FK together", async () => {
      const schema = `
        CREATE TABLE organizations (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          parent_org_id INTEGER,
          ceo_id INTEGER,
          CONSTRAINT fk_parent_org FOREIGN KEY (parent_org_id) REFERENCES organizations(id),
          CONSTRAINT fk_ceo FOREIGN KEY (ceo_id) REFERENCES people(id)
        );

        CREATE TABLE people (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          org_id INTEGER,
          CONSTRAINT fk_org FOREIGN KEY (org_id) REFERENCES organizations(id)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      // Verify all FKs exist
      const constraints = await client.query(`
        SELECT
          tc.table_name,
          tc.constraint_name
        FROM information_schema.table_constraints tc
        WHERE tc.constraint_type = 'FOREIGN KEY'
        ORDER BY tc.table_name, tc.constraint_name
      `);

      expect(constraints.rows).toHaveLength(3);

      // Test data insertion
      await client.query("INSERT INTO organizations (name) VALUES ('ACME Corp')");
      await client.query("INSERT INTO people (name, org_id) VALUES ('John Doe', 1)");
      await client.query("UPDATE organizations SET ceo_id = 1 WHERE id = 1");

      // Add a subsidiary
      await client.query("INSERT INTO organizations (name, parent_org_id) VALUES ('ACME Labs', 1)");

      const result = await client.query("SELECT COUNT(*) as count FROM organizations WHERE parent_org_id IS NOT NULL");
      expect(result.rows[0].count).toBe('1');
    });
  });
});
