import { describe, test, expect } from "bun:test";
import { SchemaParser } from "../core/schema/parser";
import { ParserError } from "../types/errors";
import { writeFileSync, unlinkSync } from "fs";

describe("Parser Error Handling", () => {
  const parser = new SchemaParser();

  describe("File not found errors", () => {
    test("should throw ParserError when schema file does not exist", () => {
      expect(() => {
        parser.parseSchemaFile("/nonexistent/path/schema.sql");
      }).toThrow(ParserError);
    });

    test("should include file path in error", () => {
      try {
        parser.parseSchemaFile("/nonexistent/path/schema.sql");
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
    test("should throw ParserError for invalid SQL syntax", () => {
      const invalidSQL = "CREATE TABLE users (id SERIAL PRIMARY KEY, name";

      expect(() => {
        parser.parseSchema(invalidSQL);
      }).toThrow(ParserError);
    });

    test("should extract line and column from CST error", () => {
      const invalidSQL = "CREATE TABLE users (id SERIAL PRIMARY KEY, name";

      try {
        parser.parseSchema(invalidSQL);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);
        const parserError = error as ParserError;
        expect(parserError.line).toBeDefined();
        expect(parserError.column).toBeDefined();
        expect(parserError.line).toBe(1);
        expect(parserError.column).toBeGreaterThan(0);
      }
    });

    test("should include file path when parsing from file", () => {
      const testFile = "/tmp/test-parser-error.sql";
      const invalidSQL = "CREATE TABLE users (id SERIAL PRIMARY KEY, name";
      writeFileSync(testFile, invalidSQL);

      try {
        parser.parseSchemaFile(testFile);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);
        const parserError = error as ParserError;
        expect(parserError.filePath).toBe(testFile);
        expect(parserError.line).toBeDefined();
        expect(parserError.column).toBeDefined();
      } finally {
        unlinkSync(testFile);
      }
    });
  });

  describe("Declarative constraint violations", () => {
    test("should throw ParserError for ALTER TABLE statements", () => {
      const sqlWithAlter = `
        CREATE TABLE users (id SERIAL PRIMARY KEY);
        ALTER TABLE users ADD COLUMN name VARCHAR(100);
      `;

      expect(() => {
        parser.parseSchema(sqlWithAlter);
      }).toThrow(ParserError);
    });

    test("should have descriptive message for ALTER TABLE", () => {
      const sqlWithAlter = `
        CREATE TABLE users (id SERIAL PRIMARY KEY);
        ALTER TABLE users ADD COLUMN name VARCHAR(100);
      `;

      try {
        parser.parseSchema(sqlWithAlter);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);
        const parserError = error as ParserError;
        expect(parserError.message).toContain("ALTER TABLE statements are not supported");
        expect(parserError.message).toContain("declarative schema tool");
      }
    });

    test("should throw ParserError for DROP TABLE statements", () => {
      const sqlWithDrop = `
        CREATE TABLE users (id SERIAL PRIMARY KEY);
        DROP TABLE old_table;
      `;

      expect(() => {
        parser.parseSchema(sqlWithDrop);
      }).toThrow(ParserError);
    });

    test("should have descriptive message for DROP statements", () => {
      const sqlWithDrop = `
        CREATE TABLE users (id SERIAL PRIMARY KEY);
        DROP TABLE old_table;
      `;

      try {
        parser.parseSchema(sqlWithDrop);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);
        const parserError = error as ParserError;
        expect(parserError.message).toContain("DROP statements are not supported");
        expect(parserError.message).toContain("declarative schema tool");
      }
    });

    test("should include file path for declarative violations when parsing from file", () => {
      const testFile = "/tmp/test-alter-error.sql";
      const sqlWithAlter = "ALTER TABLE users ADD COLUMN name VARCHAR(100);";
      writeFileSync(testFile, sqlWithAlter);

      try {
        parser.parseSchemaFile(testFile);
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
    test("should not throw error for valid schema", () => {
      const validSQL = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      expect(() => {
        parser.parseSchema(validSQL);
      }).not.toThrow();
    });

    test("should parse valid schema successfully", () => {
      const validSQL = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        );
      `;

      const result = parser.parseSchema(validSQL);
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0].name).toBe("users");
    });
  });
});
