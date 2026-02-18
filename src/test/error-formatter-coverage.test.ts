import { describe, expect, test } from "bun:test";
import { ErrorFormatter } from "../utils/error-formatter";
import {
  DependencyError,
  ParserError,
  TerraError,
  ValidationError,
} from "../types/errors";

describe("ErrorFormatter coverage", () => {
  test("formats dependency error with tables", () => {
    const error = new DependencyError("circular dependency detected", ["users", "teams"]);
    const formatted = ErrorFormatter.format(error);

    expect(formatted).toContain("Dependency Error");
    expect(formatted).toContain("Affected tables:");
    expect(formatted).toContain("users");
    expect(formatted).toContain("teams");
  });

  test("formats validation error with entity details", () => {
    const error = new ValidationError("invalid value", "users", "status", "unknown");
    const formatted = ErrorFormatter.format(error);

    expect(formatted).toContain("Validation Error");
    expect(formatted).toContain("Entity: users");
    expect(formatted).toContain("Field: status");
    expect(formatted).toContain("Value: unknown");
  });

  test("formats validation error without entity details", () => {
    const error = new ValidationError("failed validation");
    const formatted = ErrorFormatter.format(error);

    expect(formatted).toContain("Validation Error");
    expect(formatted).toContain("failed validation");
    expect(formatted).not.toContain("Entity:");
  });

  test("formats base terra error and context", () => {
    const error = new TerraError("GENERIC", "operation failed", {
      attempt: 2,
      dryRun: true,
    });
    error.name = "";
    const formatted = ErrorFormatter.format(error);

    expect(formatted).toContain("Terra Error");
    expect(formatted).toContain("operation failed");
    expect(formatted).toContain("Context:");
    expect(formatted).toContain("attempt: 2");
    expect(formatted).toContain("dryRun: true");
  });

  test("formats parser error with location snippet and unexpected end suggestion", () => {
    const error = new ParserError(
      "unexpected end of input while parsing statement",
      "schema.sql",
      12,
      3,
      "CREATE TABLE users (id SERIAL"
    );
    const formatted = ErrorFormatter.format(error);

    expect(formatted).toContain("Parser Error");
    expect(formatted).toContain("in schema.sql:12:3");
    expect(formatted).toContain("SQL:");
    expect(formatted).toContain("CREATE TABLE users");
    expect(formatted).toContain("Suggestion:");
    expect(formatted).toContain("missing closing parentheses");
  });
});
