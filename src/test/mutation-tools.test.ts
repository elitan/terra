import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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

type NativeMutationReport = {
  diffRef: string | null;
  results: Array<{
    command: string;
    line: number;
    status: string;
  }>;
};

type MutationGateReport = {
  diffRef: string | null;
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

function runChangedLineMutationScenario(
  mode: "changed" | "deleted" | "whole-file"
): NativeMutationReport {
  const temporaryDirectory = realpathSync(
    mkdtempSync(join(tmpdir(), "terradb-mutation-runner-"))
  );
  const sourceDirectory = join(
    temporaryDirectory,
    "src",
    "providers",
    "sqlite"
  );
  const sourcePath = join(sourceDirectory, "parser.ts");
  const verificationPath = join(temporaryDirectory, "candidate.test.ts");
  const baselinePath = join(temporaryDirectory, "baseline.json");
  const reportPath = join(temporaryDirectory, "mutation-report.json");
  const initialSource = [
    "export const first = true;",
    "export const second = false;",
    "export const changed = true;",
    "",
  ].join("\n");
  const changedSource = mode === "deleted"
    ? [
      "export const first = true;",
      "export const second = false;",
      "",
    ].join("\n")
    : [
      "export const first = true;",
      "export const second = false;",
      "export const changed = false;",
      "",
    ].join("\n");

  try {
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(sourcePath, initialSource);
    writeFileSync(join(temporaryDirectory, "package.json"), JSON.stringify({
      scripts: {
        "test:sqlite": "bun test candidate.test.ts",
      },
    }));
    execFileSync("git", ["init", "--quiet"], { cwd: temporaryDirectory });
    execFileSync("git", ["config", "user.email", "test@terradb.local"], {
      cwd: temporaryDirectory,
    });
    execFileSync("git", ["config", "user.name", "TerraDB Test"], {
      cwd: temporaryDirectory,
    });
    execFileSync("git", ["add", "src/providers/sqlite/parser.ts"], {
      cwd: temporaryDirectory,
    });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: temporaryDirectory,
    });
    writeFileSync(sourcePath, changedSource);
    writeFileSync(verificationPath, `
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("keeps the expected changed literal", function () {
  const source = readFileSync(${JSON.stringify(sourcePath)}, "utf-8");
  expect(source).toContain("changed = false");
});
`);
    writeFileSync(baselinePath, JSON.stringify({
      targetFiles: [{ file: sourcePath, selected: true }],
      diffRef: mode === "whole-file" ? null : "HEAD",
    }));

    execFileSync(
      process.execPath,
      [
        "run",
        resolve("tools/run-mutation-changed.ts"),
        "--baseline",
        baselinePath,
        "--report",
        reportPath,
        "--max-per-file",
        "10",
        "--timeout-ms",
        "30000",
      ],
      {
        cwd: temporaryDirectory,
        stdio: "pipe",
      }
    );
    return JSON.parse(readFileSync(reportPath, "utf-8")) as NativeMutationReport;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runMutationGate(
  args: string[],
  environment: Record<string, string>
): MutationGateReport {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "terradb-mutation-gate-"));
  const reportPath = join(temporaryDirectory, "gate-report.json");

  try {
    execFileSync(
      process.execPath,
      [
        "run",
        resolve("tools/check-mutation-gate.ts"),
        "--mode",
        "report",
        "--out",
        reportPath,
        "--score",
        "100",
        ...args,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MUTATION_BASE_REF: "",
          MUTATION_HEAD_REF: "",
          ...environment,
        },
        stdio: "pipe",
      }
    );
    return JSON.parse(readFileSync(reportPath, "utf-8")) as MutationGateReport;
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

test("changed mutation candidates stay inside added and modified lines", function () {
  const changedReport = runChangedLineMutationScenario("changed");
  const deletionReport = runChangedLineMutationScenario("deleted");
  const wholeFileReport = runChangedLineMutationScenario("whole-file");

  expect(changedReport.diffRef).toBe("HEAD");
  expect(changedReport.results).toEqual([
    expect.objectContaining({
      command: "bun run test:sqlite",
      line: 3,
      status: "killed",
    }),
  ]);
  expect(deletionReport.results).toEqual([]);
  expect(wholeFileReport.diffRef).toBeNull();
  expect(wholeFileReport.results.map(function (result) {
    return result.line;
  })).toEqual([1, 2, 3]);
});

test("mutation gate resolves clean-checkout base and head refs", function () {
  const pullRequestReport = runMutationGate([], {
    MUTATION_BASE_REF: "HEAD",
    MUTATION_HEAD_REF: "HEAD~1",
  });
  const defaultHeadReport = runMutationGate([], {
    MUTATION_BASE_REF: "HEAD",
  });
  const commandLineReport = runMutationGate([
    "--base",
    "HEAD~1",
    "--head",
    "HEAD",
  ], {
    MUTATION_BASE_REF: "HEAD",
    MUTATION_HEAD_REF: "HEAD~1",
  });

  expect(pullRequestReport.diffRef).toBe(
    "HEAD...HEAD~1"
  );
  expect(defaultHeadReport.diffRef).toBe("HEAD...HEAD");
  expect(commandLineReport.diffRef).toBe("HEAD~1...HEAD");
  expect(runMutationGate([], {}).diffRef).toBe("HEAD");
  expect(runMutationGate([
    "--files",
    "src/core/schema/differ.ts",
  ], {}).diffRef).toBeNull();
});
