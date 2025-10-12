import { describe, test, expect } from "bun:test";
import {
  TerraError,
  ParserError,
  MigrationError,
  DependencyError,
  ValidationError,
} from "../types/errors";

describe("Error Classes", () => {
  describe("TerraError", () => {
    test("should create base error with code and message", () => {
      const error = new TerraError("TEST_ERROR", "Something went wrong");

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(TerraError);
      expect(error.code).toBe("TEST_ERROR");
      expect(error.message).toBe("Something went wrong");
      expect(error.name).toBe("TerraError");
    });

    test("should include context when provided", () => {
      const error = new TerraError("TEST_ERROR", "Error message", {
        foo: "bar",
        count: 42,
      });

      expect(error.context).toEqual({ foo: "bar", count: 42 });
    });

    test("should have stack trace", () => {
      const error = new TerraError("TEST_ERROR", "Error message");
      expect(error.stack).toBeDefined();
    });
  });

  describe("ParserError", () => {
    test("should create parser error with file location", () => {
      const error = new ParserError(
        "Syntax error in SQL",
        "schema.sql",
        12,
        48
      );

      expect(error).toBeInstanceOf(ParserError);
      expect(error).toBeInstanceOf(TerraError);
      expect(error.code).toBe("PARSER_ERROR");
      expect(error.message).toBe("Syntax error in SQL");
      expect(error.filePath).toBe("schema.sql");
      expect(error.line).toBe(12);
      expect(error.column).toBe(48);
    });

    test("should include SQL snippet when provided", () => {
      const error = new ParserError(
        "Unexpected token",
        "schema.sql",
        5,
        10,
        "CREATE TABLE users (id SERIAL"
      );

      expect(error.sqlSnippet).toBe("CREATE TABLE users (id SERIAL");
    });

    test("should work without optional parameters", () => {
      const error = new ParserError("Generic parse error");

      expect(error.filePath).toBeUndefined();
      expect(error.line).toBeUndefined();
      expect(error.column).toBeUndefined();
    });
  });

  describe("MigrationError", () => {
    test("should create migration error with statement", () => {
      const error = new MigrationError(
        "Failed to execute statement",
        "ALTER TABLE users ADD COLUMN email VARCHAR(255);"
      );

      expect(error).toBeInstanceOf(MigrationError);
      expect(error.code).toBe("MIGRATION_ERROR");
      expect(error.statement).toBe(
        "ALTER TABLE users ADD COLUMN email VARCHAR(255);"
      );
    });

    test("should include PostgreSQL error details", () => {
      const error = new MigrationError(
        "Duplicate key violation",
        "INSERT INTO users (email) VALUES ('test@example.com');",
        {
          code: "23505",
          detail: "Key (email)=(test@example.com) already exists.",
          hint: "Use ON CONFLICT to handle duplicates.",
          position: "42",
        }
      );

      expect(error.pgError).toBeDefined();
      expect(error.pgError?.code).toBe("23505");
      expect(error.pgError?.detail).toContain("already exists");
      expect(error.pgError?.hint).toContain("ON CONFLICT");
    });
  });

  describe("DependencyError", () => {
    test("should create dependency error with table info", () => {
      const error = new DependencyError(
        "Circular dependency detected",
        ["users", "posts", "comments"]
      );

      expect(error).toBeInstanceOf(DependencyError);
      expect(error.code).toBe("DEPENDENCY_ERROR");
      expect(error.tables).toEqual(["users", "posts", "comments"]);
    });

    test("should include dependency graph when provided", () => {
      const error = new DependencyError("Unresolvable dependencies", ["a", "b"], {
        a: ["b"],
        b: ["a"],
      });

      expect(error.dependencyGraph).toEqual({ a: ["b"], b: ["a"] });
    });
  });

  describe("ValidationError", () => {
    test("should create validation error with entity details", () => {
      const error = new ValidationError(
        "Invalid email format",
        "User",
        "email",
        "not-an-email"
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.entity).toBe("User");
      expect(error.field).toBe("email");
      expect(error.value).toBe("not-an-email");
    });
  });

  describe("Error inheritance chain", () => {
    test("all error types should be instanceof TerraError", () => {
      const parserError = new ParserError("test");
      const migrationError = new MigrationError("test");
      const dependencyError = new DependencyError("test");
      const validationError = new ValidationError("test");

      expect(parserError).toBeInstanceOf(TerraError);
      expect(migrationError).toBeInstanceOf(TerraError);
      expect(dependencyError).toBeInstanceOf(TerraError);
      expect(validationError).toBeInstanceOf(TerraError);
    });

    test("all error types should be instanceof Error", () => {
      const terraError = new TerraError("TEST", "test");
      const parserError = new ParserError("test");

      expect(terraError).toBeInstanceOf(Error);
      expect(parserError).toBeInstanceOf(Error);
    });
  });
});
