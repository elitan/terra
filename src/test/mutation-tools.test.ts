import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type SummarizedReport = {
  totalEscaped: number;
  modules: Array<Record<string, unknown>>;
  mutants: Array<Record<string, unknown>>;
};

function summarizeEscapedMutants(input: unknown): SummarizedReport {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "terradb-mutation-rollup-"));
  const inputPath = join(temporaryDirectory, "mutation-report.json");
  const outputPath = join(temporaryDirectory, "escaped-mutants.json");

  try {
    writeFileSync(inputPath, JSON.stringify(input));
    execFileSync(
      process.execPath,
      [
        "run",
        resolve("tools/summarize-escaped-mutants.ts"),
        "--report",
        inputPath,
        "--out",
        outputPath,
      ],
      {
        cwd: process.cwd(),
        stdio: "pipe",
      }
    );
    return JSON.parse(readFileSync(outputPath, "utf-8")) as SummarizedReport;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("escaped mutant rollup reads native runner reports", function () {
  const sourcePath = resolve("src/providers/sqlite/index.ts");
  const report = summarizeEscapedMutants({
    results: [
      {
        id: `${sourcePath}#1`,
        file: sourcePath,
        operator: "false_to_true",
        line: 486,
        column: 46,
        replacement: "true",
        status: "survived",
      },
      {
        id: `${sourcePath}#2`,
        file: sourcePath,
        operator: "true_to_false",
        line: 504,
        column: 47,
        replacement: "false",
        status: "killed",
      },
    ],
  });

  expect(report.totalEscaped).toBe(1);
  expect(report.modules).toEqual([{
    module: "sqlite-provider",
    escapedCount: 1,
    files: [sourcePath],
    reasons: ["controls SQLite migration atomicity and integrity verification"],
  }]);
  expect(report.mutants).toEqual([{
    id: `${sourcePath}#1`,
    file: sourcePath,
    status: "survived",
    mutator: "false_to_true",
    replacement: "true",
    location: { line: 486, column: 46 },
    module: "sqlite-provider",
    reason: "controls SQLite migration atomicity and integrity verification",
  }]);
});

test("escaped mutant rollup retains Stryker report compatibility", function () {
  const sourcePath = "src/core/schema/differ.ts";
  const report = summarizeEscapedMutants({
    files: {
      [sourcePath]: {
        mutants: [
          {
            id: "stryker-survivor",
            status: "Survived",
            mutatorName: "ConditionalExpression",
            replacement: "false",
            location: { start: { line: 17, column: 4 } },
          },
          {
            id: "stryker-killed",
            status: "Killed",
            mutatorName: "BooleanLiteral",
            replacement: "true",
            location: { start: { line: 20, column: 2 } },
          },
        ],
      },
    },
  });

  expect(report.totalEscaped).toBe(1);
  expect(report.modules).toEqual([{
    module: "core-schema",
    escapedCount: 1,
    files: [sourcePath],
    reasons: ["directly controls migration safety and idempotency"],
  }]);
  expect(report.mutants).toEqual([expect.objectContaining({
    id: "stryker-survivor",
    mutator: "ConditionalExpression",
    location: { line: 17, column: 4 },
  })]);
});
