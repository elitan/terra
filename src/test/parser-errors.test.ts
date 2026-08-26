import { describe, test, expect } from "bun:test";
import { SchemaParser } from "../core/schema/parser";
import { ParserError } from "../types/errors";
import { writeFileSync, unlinkSync } from "fs";

describe("Parser Error Handling", () => {
  const parser = new SchemaParser();

  describe("File not found errors", () => {
    test("should throw ParserError when schema file does not exist", async () => {
      await expect(parser.parseSchemaFile("/nonexistent/path/schema.sql")).rejects.toThrow(ParserError);
    });

    test("should include file path in error", async () => {
      try {
        await parser.parseSchemaFile("/nonexistent/path/schema.sql");
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);
        const parserError = error as ParserError;
        expect(parserError.filePath).toBe("/nonexistent/path/schema.sql");
        expect(parserError.message).toContain("Schema file not found");
      }
    });
  });

  describe("Syntax error handling", () => {
    test("should throw ParserError for invalid SQL syntax", async () => {
      const invalidSQL = "CREATE TABLE users (id SERIAL PRIMARY KEY, name";

      await expect(parser.parseSchema(invalidSQL)).rejects.toThrow(ParserError);
    });

    test("should have descriptive error message", async () => {
      const invalidSQL = "CREATE TABLE users (id SERIAL PRIMARY KEY, name";

      try {
        await parser.parseSchema(invalidSQL);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);
        const parserError = error as ParserError;
        expect(parserError.message).toBeDefined();
        expect(parserError.message.length).toBeGreaterThan(0);
      }
    });

    test("should include file path when parsing from file", async () => {
      const testFile = "/tmp/test-parser-error.sql";
      const invalidSQL = "CREATE TABLE users (id SERIAL PRIMARY KEY, name";
      writeFileSync(testFile, invalidSQL);

      try {
        await parser.parseSchemaFile(testFile);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);
        const parserError = error as ParserError;
        expect(parserError.filePath).toBe(testFile);
      } finally {
        unlinkSync(testFile);
      }
    });
  });

  describe("Declarative constraint violations", () => {
    test("should allow ALTER TABLE ADD CONSTRAINT FOREIGN KEY statements", async () => {
      const sql = `
        CREATE TABLE users (id SERIAL PRIMARY KEY);
        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER
        );
        ALTER TABLE posts
        ADD CONSTRAINT posts_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      `;

      const result = await parser.parseSchema(sql);

      expect(result.tables).toHaveLength(2);
      const posts = result.tables.find(function (table) {
        return table.name === "posts";
      });
      expect(posts?.foreignKeys).toEqual([
        {
          name: "posts_user_id_fkey",
          columns: ["user_id"],
          referencedTable: "users",
          referencedColumns: ["id"],
          onDelete: "CASCADE",
          onUpdate: "NO ACTION",
        },
      ]);
    });

    test("should merge ALTER TABLE ADD COLUMN statements into desired table state", async () => {
      const sqlWithAlter = `
        CREATE TABLE people (id SERIAL PRIMARY KEY);
        CREATE TABLE internal_departments (id SERIAL PRIMARY KEY);
        CREATE TABLE fortnox.cost_centers (id SERIAL PRIMARY KEY);
        ALTER TABLE internal_departments
          ADD COLUMN name VARCHAR(100) NOT NULL,
          ADD COLUMN fortnox_cost_center_id INTEGER
            REFERENCES fortnox.cost_centers(id) ON DELETE SET NULL;
      `;

      const result = await parser.parseSchema(sqlWithAlter);
      const departments = result.tables.find(function (table) {
        return table.name === "internal_departments";
      });

      expect(departments?.columns.map(function (column) {
        return {
          name: column.name,
          type: column.type,
          nullable: column.nullable,
        };
      })).toEqual([
        { name: "id", type: "SERIAL", nullable: false },
        { name: "name", type: "VARCHAR(100)", nullable: false },
        {
          name: "fortnox_cost_center_id",
          type: "INT4",
          nullable: true,
        },
      ]);
      expect(departments?.foreignKeys).toContainEqual({
        name: undefined,
        columns: ["fortnox_cost_center_id"],
        referencedTable: "fortnox.cost_centers",
        referencedColumns: ["id"],
        onDelete: "SET NULL",
        onUpdate: "NO ACTION",
      });
    });

    test("should have descriptive message for unsupported ALTER TABLE mutations", async () => {
      const sqlWithAlter = `
        CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);
        ALTER TABLE users ALTER COLUMN name TYPE VARCHAR(100);
      `;

      try {
        await parser.parseSchema(sqlWithAlter);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);
        const parserError = error as ParserError;
        expect(parserError.message).toContain("This ALTER TABLE statement is not supported");
        expect(parserError.message).toContain("declarative schema tool");
      }
    });

    test("should throw ParserError for DROP TABLE statements", async () => {
      const sqlWithDrop = `
        CREATE TABLE users (id SERIAL PRIMARY KEY);
        DROP TABLE old_table;
      `;

      await expect(parser.parseSchema(sqlWithDrop)).rejects.toThrow(ParserError);
    });

    test("should have descriptive message for DROP statements", async () => {
      const sqlWithDrop = `
        CREATE TABLE users (id SERIAL PRIMARY KEY);
        DROP TABLE old_table;
      `;

      try {
        await parser.parseSchema(sqlWithDrop);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);
        const parserError = error as ParserError;
        expect(parserError.message).toContain("DROP statements are not supported");
        expect(parserError.message).toContain("declarative schema tool");
      }
    });

    test("should include file path for declarative violations when parsing from file", async () => {
      const testFile = "/tmp/test-alter-error.sql";
      const sqlWithAlter = "ALTER TABLE users ALTER COLUMN name TYPE VARCHAR(100);";
      writeFileSync(testFile, sqlWithAlter);

      try {
        await parser.parseSchemaFile(testFile);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);
        const parserError = error as ParserError;
        expect(parserError.filePath).toBe(testFile);
      } finally {
        unlinkSync(testFile);
      }
    });
  });

  describe("Valid schema parsing", () => {
    test("should not throw error for valid schema", async () => {
      const validSQL = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      await expect(parser.parseSchema(validSQL)).resolves.toBeDefined();
    });

    test("should parse valid schema successfully", async () => {
      const validSQL = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      const result = await parser.parseSchema(validSQL);
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0].name).toBe("users");
    });
  });

  describe("Reserved keywords handling", () => {
    test("should automatically quote reserved keyword 'year' as column name", async () => {
      const sqlWithYear = `
        CREATE TABLE company_yearly_data (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL,
          year INT NOT NULL,
          revenue INT,
          UNIQUE (company_id, year)
        );
      `;

      await expect(parser.parseSchema(sqlWithYear)).resolves.toBeDefined();
    });

    test("should parse table with 'year' column successfully", async () => {
      const sqlWithYear = `
        CREATE TABLE company_yearly_data (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL,
          year INT NOT NULL,
          revenue INT
        );
      `;

      const result = await parser.parseSchema(sqlWithYear);
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0].name).toBe("company_yearly_data");
      expect(result.tables[0].columns).toHaveLength(4);

      const yearColumn = result.tables[0].columns.find(c => c.name === "year");
      expect(yearColumn).toBeDefined();
      expect(yearColumn?.type).toBe("INT4");
    });

    test("should handle multiple reserved keywords", async () => {
      const sqlWithKeywords = `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          user INTEGER NOT NULL,
          day INT NOT NULL,
          month INT NOT NULL,
          year INT NOT NULL
        );
      `;

      await expect(parser.parseSchema(sqlWithKeywords)).resolves.toBeDefined();

      const result = await parser.parseSchema(sqlWithKeywords);
      expect(result.tables[0].columns).toHaveLength(5);
    });

    test("should keep quoted reserved keyword in unique constraint", async function () {
      const sql = `
        CREATE TABLE test_table (
          "status" TEXT,
          UNIQUE ("status")
        );
      `;

      await expect(parser.parseSchema(sql)).resolves.toBeDefined();
    });

    test("should keep quoted reserved keyword in primary key constraint", async function () {
      const sql = `
        CREATE TABLE test_table (
          "order" INT,
          PRIMARY KEY ("order")
        );
      `;

      await expect(parser.parseSchema(sql)).resolves.toBeDefined();
    });

    test("should automatically quote reserved keyword in inline first-column definitions", async function () {
      const sql = "CREATE TABLE intervals (user INT);";

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      const userColumn = result.tables[0].columns.find(c => c.name === "user");
      expect(userColumn).toBeDefined();
      expect(userColumn?.type).toBe("INT4");
    });

    test("should automatically quote reserved keyword for money columns", async function () {
      const sql = "CREATE TABLE intervals (user MONEY);";

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      const userColumn = result.tables[0].columns.find(c => c.name === "user");
      expect(userColumn).toBeDefined();
      expect(userColumn?.type).toBe("MONEY");
    });

    test("should automatically quote reserved keyword for bit columns", async function () {
      const sql = "CREATE TABLE flags (user BIT(8));";

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      const userColumn = result.tables[0].columns.find(c => c.name === "user");
      expect(userColumn).toBeDefined();
      expect(userColumn?.type).toBe("BIT(8)");
    });

    test("should automatically quote reserved keyword for network columns", async function () {
      const sql = "CREATE TABLE networks (user INET);";

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      const userColumn = result.tables[0].columns.find(c => c.name === "user");
      expect(userColumn).toBeDefined();
      expect(userColumn?.type).toBe("INET");
    });

    test("should automatically quote reserved keyword for xml columns", async function () {
      const sql = "CREATE TABLE docs (user XML);";

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      const userColumn = result.tables[0].columns.find(c => c.name === "user");
      expect(userColumn).toBeDefined();
      expect(userColumn?.type).toBe("XML");
    });

    test("should automatically quote reserved keyword for oid columns", async function () {
      const sql = "CREATE TABLE objects (user OID);";

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      const userColumn = result.tables[0].columns.find(c => c.name === "user");
      expect(userColumn).toBeDefined();
      expect(userColumn?.type).toBe("OID");
    });

    test("should automatically quote reserved keyword for text search columns", async function () {
      const sql = "CREATE TABLE search_docs (user TSVECTOR);";

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      const userColumn = result.tables[0].columns.find(c => c.name === "user");
      expect(userColumn).toBeDefined();
      expect(userColumn?.type).toBe("TSVECTOR");
    });

    test("should automatically quote reserved keyword for bytea columns", async function () {
      const sql = "CREATE TABLE blobs (user BYTEA);";

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      const userColumn = result.tables[0].columns.find(c => c.name === "user");
      expect(userColumn).toBeDefined();
      expect(userColumn?.type).toBe("BYTEA");
    });

    test("should automatically quote reserved keyword for geometric columns", async function () {
      const sql = "CREATE TABLE geometry (user POINT);";

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      const userColumn = result.tables[0].columns.find(c => c.name === "user");
      expect(userColumn).toBeDefined();
      expect(userColumn?.type).toBe("POINT");
    });

    test("should automatically quote reserved keyword for user-defined types", async function () {
      const sql = `
        CREATE TYPE mood AS ENUM ('sad', 'ok');
        CREATE TABLE users (
          user mood
        );
      `;

      const result = await parser.parseSchema(sql);
      expect(result.tables).toHaveLength(1);
      const userColumn = result.tables[0].columns.find(c => c.name === "user");
      expect(userColumn).toBeDefined();
      expect(userColumn?.type).toBe("MOOD");
    });

    test("should not rewrite reserved words inside function bodies", async function () {
      const sql = `
        CREATE FUNCTION public.test_reserved_body(input_date date)
        RETURNS integer
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RETURN extract(year FROM input_date);
          PERFORM status FROM records ORDER BY status FOR UPDATE;
        END;
        $$;
      `;

      const result = await parser.parseSchema(sql);

      expect(result.functions[0]?.body).toContain("extract(year FROM input_date)");
      expect(result.functions[0]?.body).toContain("ORDER BY status FOR UPDATE");
      expect(result.functions[0]?.body).not.toContain('"year"');
      expect(result.functions[0]?.body).not.toContain('"status"');
    });
  });
});
