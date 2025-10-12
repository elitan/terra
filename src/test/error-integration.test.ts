import { describe, test, expect } from "bun:test";
import { SchemaParser } from "../core/schema/parser";
import { ErrorFormatter } from "../utils/error-formatter";
import { ParserError, MigrationError } from "../types/errors";
import { writeFileSync, unlinkSync } from "fs";

describe("Error Integration Tests", () => {
  describe("Parser Error Formatting", () => {
    test("should format parser error with file location", () => {
      const testFile = "/tmp/test-error-formatting.sql";
      const invalidSQL = "CREATE TABLE users (id SERIAL PRIMARY KEY, name";
      writeFileSync(testFile, invalidSQL);

      try {
        const parser = new SchemaParser();
        parser.parseSchemaFile(testFile);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);

        const formatted = ErrorFormatter.format(error);

        // Check formatted output
        expect(formatted).toContain("Parser Error");
        expect(formatted).toContain(testFile);
        expect(formatted).toContain("Unexpected end of input");
      } finally {
        unlinkSync(testFile);
      }
    });

    test("should format ALTER TABLE error with suggestion", () => {
      const parser = new SchemaParser();
      const sqlWithAlter = `
        CREATE TABLE users (id SERIAL PRIMARY KEY);
        ALTER TABLE users ADD COLUMN name VARCHAR(100);
      `;

      try {
        parser.parseSchema(sqlWithAlter);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);

        const formatted = ErrorFormatter.format(error);

        // Check formatted output contains suggestion
        expect(formatted).toContain("Parser Error");
        expect(formatted).toContain("ALTER TABLE statements are not supported");
        expect(formatted).toContain("Suggestion");
        expect(formatted).toContain("CREATE TABLE");
      }
    });

    test("should format DROP statement error with suggestion", () => {
      const parser = new SchemaParser();
      const sqlWithDrop = `
        CREATE TABLE users (id SERIAL PRIMARY KEY);
        DROP TABLE old_table;
      `;

      try {
        parser.parseSchema(sqlWithDrop);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);

        const formatted = ErrorFormatter.format(error);

        // Check formatted output
        expect(formatted).toContain("Parser Error");
        expect(formatted).toContain("DROP statements are not supported");
        expect(formatted).toContain("Suggestion");
        expect(formatted).toContain("remove");
      }
    });
  });

  describe("Migration Error Formatting", () => {
    test("should format migration error with statement", () => {
      const error = new MigrationError(
        "duplicate key value violates unique constraint",
        "INSERT INTO users (email) VALUES ('test@example.com');",
        {
          code: "23505",
          detail: "Key (email)=(test@example.com) already exists.",
          hint: "Use ON CONFLICT to handle duplicates.",
        }
      );

      const formatted = ErrorFormatter.format(error);

      // Check formatted output
      expect(formatted).toContain("Migration Error");
      expect(formatted).toContain("duplicate key");
      expect(formatted).toContain("Failed statement");
      expect(formatted).toContain("INSERT INTO users");
      expect(formatted).toContain("PostgreSQL Error Code: 23505");
      expect(formatted).toContain("Detail:");
      expect(formatted).toContain("already exists");
      expect(formatted).toContain("Hint:");
      expect(formatted).toContain("ON CONFLICT");
    });

    test("should format migration error without PG details gracefully", () => {
      const error = new MigrationError(
        "Transaction failed",
        "CREATE TABLE test (id SERIAL);"
      );

      const formatted = ErrorFormatter.format(error);

      expect(formatted).toContain("Migration Error");
      expect(formatted).toContain("Transaction failed");
      expect(formatted).toContain("Failed statement");
      expect(formatted).toContain("CREATE TABLE");
    });
  });

  describe("Error Formatter Edge Cases", () => {
    test("should format generic Error objects", () => {
      const error = new Error("Something went wrong");
      const formatted = ErrorFormatter.format(error);

      expect(formatted).toContain("Error");
      expect(formatted).toContain("Something went wrong");
    });

    test("should format string errors", () => {
      const formatted = ErrorFormatter.format("String error message");

      expect(formatted).toContain("Error");
      expect(formatted).toContain("String error message");
    });

    test("should handle very long error messages", () => {
      const longMessage = "This is a very long error message that should be wrapped to fit the terminal width and make it readable for users without horizontal scrolling. ".repeat(3);
      const error = new ParserError(longMessage);

      const formatted = ErrorFormatter.format(error);

      // Should not have lines longer than reasonable terminal width
      const lines = formatted.split('\n');
      lines.forEach((line) => {
        // Allow some buffer over 80 chars for edge cases
        expect(line.length).toBeLessThan(90);
      });
    });
  });

  describe("Output Format", () => {
    test("formatted errors should be multi-line strings", () => {
      const error = new ParserError("Test error");
      const formatted = ErrorFormatter.format(error);

      // Should have multiple lines
      expect(formatted).toContain("\n");
      expect(formatted).toContain("Parser Error");
    });
  });
});
