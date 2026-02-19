import { describe, expect, test } from "bun:test";
import { Logger } from "../../utils/logger";
import { OutputFormatter } from "../../utils/output-formatter";

describe("Logger and output formatter coverage", () => {
  test("logger methods write via console", () => {
    const logs: unknown[][] = [];
    const errors: unknown[][] = [];
    const originalLog = console.log;
    const originalError = console.error;

    console.log = function (...args: unknown[]) {
      logs.push(args);
    };
    console.error = function (...args: unknown[]) {
      errors.push(args);
    };

    try {
      Logger.info("info");
      Logger.success("success");
      Logger.warning("warning");
      Logger.error("error");
      Logger.cyan("cyan");
      Logger.print("print");
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    expect(logs.length).toBe(5);
    expect(errors.length).toBe(1);
  });

  test("output formatter methods cover empty and full branches", () => {
    expect(OutputFormatter.box([])).toBe("");

    const boxed = OutputFormatter.box(["CREATE TABLE users (id INT);"]);
    expect(boxed).toContain("CREATE TABLE users");

    expect(OutputFormatter.section("Transactional")).toBe("\n  Transactional");
    expect(OutputFormatter.warningSection("Danger")).toContain("Danger");
    expect(OutputFormatter.summary("1 change")).toBe("→ 1 change");
  });
});
