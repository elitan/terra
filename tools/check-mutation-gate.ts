import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  mutationRiskManifest,
  type MutationRiskEntry,
  type MutationRiskLevel,
} from "./mutation-risk-manifest";

type GateMode = "gate" | "report";

type Options = {
  mode: GateMode;
  threshold: number;
  minRisk: MutationRiskLevel;
  outPath: string;
  reportPath?: string;
  filesArg?: string;
  filesFromPath?: string;
  baseRef?: string;
  headRef?: string;
  scoreArg?: string;
};

type RiskMatch = {
  path: string;
  owner: string;
  level: MutationRiskLevel;
  reason: string;
};

type FileAssessment = {
  file: string;
  risk: MutationRiskLevel | null;
  matched: RiskMatch[];
  requiresGate: boolean;
};

type MutationGateReport = {
  generatedAt: string;
  mode: GateMode;
  threshold: number;
  minRisk: MutationRiskLevel;
  changedFilesTotal: number;
  targetFilesTotal: number;
  changedFiles: FileAssessment[];
  targetFiles: FileAssessment[];
  score: number | null;
  scoreSource: string | null;
  pass: boolean;
};

const RISK_ORDER: Record<MutationRiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    mode: "gate",
    threshold: 85,
    minRisk: "high",
    outPath: "coverage/mutation/changed-files-baseline.json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || !token.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    if (name === "mode") {
      if (value !== "gate" && value !== "report") {
        throw new Error(`Invalid mode "${value}"`);
      }
      options.mode = value;
      index += 1;
      continue;
    }
    if (name === "threshold") {
      const parsed = Number.parseFloat(value);
      if (Number.isNaN(parsed)) {
        throw new Error(`Invalid threshold "${value}"`);
      }
      options.threshold = parsed;
      index += 1;
      continue;
    }
    if (name === "min-risk") {
      if (!isRiskLevel(value)) {
        throw new Error(`Invalid risk level "${value}"`);
      }
      options.minRisk = value;
      index += 1;
      continue;
    }
    if (name === "out") {
      options.outPath = value;
      index += 1;
      continue;
    }
    if (name === "report") {
      options.reportPath = value;
      index += 1;
      continue;
    }
    if (name === "files") {
      options.filesArg = value;
      index += 1;
      continue;
    }
    if (name === "files-from") {
      options.filesFromPath = value;
      index += 1;
      continue;
    }
    if (name === "base") {
      options.baseRef = value;
      index += 1;
      continue;
    }
    if (name === "head") {
      options.headRef = value;
      index += 1;
      continue;
    }
    if (name === "score") {
      options.scoreArg = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument --${name}`);
  }

  return options;
}

function isRiskLevel(value: string): value is MutationRiskLevel {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").trim();
}

function getChangedFiles(options: Options): string[] {
  if (options.filesArg) {
    return options.filesArg
      .split(",")
      .map(normalizePath)
      .filter(Boolean)
      .sort();
  }

  if (options.filesFromPath) {
    const content = readFileSync(options.filesFromPath, "utf-8");
    return content
      .split(/\r?\n/)
      .map(normalizePath)
      .filter(Boolean)
      .sort();
  }

  if (options.baseRef && options.headRef) {
    const diff = execGitDiff(`${options.baseRef}...${options.headRef}`);
    return diff;
  }

  return execGitDiff("HEAD");
}

function execGitDiff(ref: string): string[] {
  const command =
    ref === "HEAD"
      ? "git diff --name-only --diff-filter=ACMRTUXB HEAD"
      : `git diff --name-only --diff-filter=ACMRTUXB ${ref}`;

  const output = execSync(command, { encoding: "utf-8" });
  return output
    .split(/\r?\n/)
    .map(normalizePath)
    .filter(Boolean)
    .sort();
}

function matchesManifestPath(file: string, manifestPath: string): boolean {
  const normalizedFile = normalizePath(file);
  const normalizedManifestPath = normalizePath(manifestPath);
  if (normalizedFile === normalizedManifestPath) {
    return true;
  }
  return normalizedFile.startsWith(`${normalizedManifestPath}/`);
}

function compareRisk(a: MutationRiskLevel, b: MutationRiskLevel): number {
  return RISK_ORDER[a] - RISK_ORDER[b];
}

function highestRisk(matches: RiskMatch[]): MutationRiskLevel | null {
  if (matches.length === 0) {
    return null;
  }
  let highest = matches[0].level;
  for (let index = 1; index < matches.length; index += 1) {
    const current = matches[index].level;
    if (compareRisk(current, highest) > 0) {
      highest = current;
    }
  }
  return highest;
}

function assessChangedFiles(files: string[], minRisk: MutationRiskLevel): FileAssessment[] {
  const minimum = RISK_ORDER[minRisk];
  const assessments: FileAssessment[] = [];

  for (const file of files) {
    const matches: RiskMatch[] = [];
    for (const entry of mutationRiskManifest.entries) {
      if (matchesManifestPath(file, entry.path)) {
        matches.push(toRiskMatch(entry));
      }
    }
    const risk = highestRisk(matches);
    const requiresGate = risk !== null && RISK_ORDER[risk] >= minimum;
    assessments.push({
      file,
      risk,
      matched: matches,
      requiresGate,
    });
  }

  return assessments;
}

function toRiskMatch(entry: MutationRiskEntry): RiskMatch {
  return {
    path: entry.path,
    owner: entry.owner,
    level: entry.level,
    reason: entry.reason,
  };
}

function parseNumericScore(value: string | undefined): number | null {
  if (!value || value.trim() === "") {
    return null;
  }
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

function getScoreFromReport(reportPath: string): number | null {
  const content = readFileSync(reportPath, "utf-8");
  const parsed = JSON.parse(content) as Record<string, unknown>;

  const directKeys = ["score", "mutationScore", "mutation_score"];
  for (const key of directKeys) {
    const value = parsed[key];
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      const parsedValue = parseNumericScore(value);
      if (parsedValue !== null) {
        return parsedValue;
      }
    }
  }

  const summary = parsed.summary;
  if (summary && typeof summary === "object") {
    const summaryScore = (summary as Record<string, unknown>).score;
    if (typeof summaryScore === "number") {
      return summaryScore;
    }
    if (typeof summaryScore === "string") {
      const parsedValue = parseNumericScore(summaryScore);
      if (parsedValue !== null) {
        return parsedValue;
      }
    }
  }

  return null;
}

function resolveScore(options: Options): { score: number | null; source: string | null } {
  const fromArg = parseNumericScore(options.scoreArg);
  if (fromArg !== null) {
    return { score: fromArg, source: "--score" };
  }

  const fromEnv = parseNumericScore(process.env.MUTATION_SCORE_CHANGED);
  if (fromEnv !== null) {
    return { score: fromEnv, source: "MUTATION_SCORE_CHANGED" };
  }

  if (options.reportPath) {
    const fromReport = getScoreFromReport(options.reportPath);
    if (fromReport !== null) {
      return { score: fromReport, source: `report:${options.reportPath}` };
    }
    return { score: null, source: `report:${options.reportPath}` };
  }

  const reportFromEnv = process.env.MUTATION_REPORT_PATH;
  if (reportFromEnv && reportFromEnv.trim() !== "") {
    if (existsSync(reportFromEnv)) {
      const fromReport = getScoreFromReport(reportFromEnv);
      if (fromReport !== null) {
        return { score: fromReport, source: `report:${reportFromEnv}` };
      }
      return { score: null, source: `report:${reportFromEnv}` };
    }
  }

  const defaultReportPath = "coverage/mutation/mutation-report.json";
  if (existsSync(defaultReportPath)) {
    const fromReport = getScoreFromReport(defaultReportPath);
    if (fromReport !== null) {
      return { score: fromReport, source: `report:${defaultReportPath}` };
    }
    return { score: null, source: `report:${defaultReportPath}` };
  }

  return { score: null, source: null };
}

function toReport(
  options: Options,
  assessments: FileAssessment[],
  score: number | null,
  scoreSource: string | null
): MutationGateReport {
  const targetFiles = assessments.filter(function (assessment) {
    return assessment.requiresGate;
  });

  let pass = true;
  if (targetFiles.length > 0) {
    if (score === null) {
      pass = options.mode === "report";
    } else {
      pass = score >= options.threshold;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    threshold: options.threshold,
    minRisk: options.minRisk,
    changedFilesTotal: assessments.length,
    targetFilesTotal: targetFiles.length,
    changedFiles: assessments,
    targetFiles,
    score,
    scoreSource,
    pass,
  };
}

function writeReport(path: string, report: MutationGateReport): void {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

function printSummary(report: MutationGateReport, outPath: string): void {
  console.log(`mutation mode: ${report.mode}`);
  console.log(`changed files: ${report.changedFilesTotal}`);
  console.log(`target files (${report.minRisk}+): ${report.targetFilesTotal}`);
  if (report.score !== null) {
    console.log(`score: ${report.score.toFixed(2)} (threshold ${report.threshold.toFixed(2)})`);
  } else if (report.scoreSource) {
    console.log(`score: missing (${report.scoreSource})`);
  } else {
    console.log("score: missing");
  }
  console.log(`report: ${outPath}`);

  if (report.targetFilesTotal === 0) {
    console.log("result: pass (no target files)");
    return;
  }

  if (!report.pass) {
    if (report.score === null) {
      console.log("result: fail (target files changed and score missing)");
      return;
    }
    console.log("result: fail (score below threshold)");
    return;
  }

  console.log("result: pass");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const changedFiles = getChangedFiles(options);
  const assessments = assessChangedFiles(changedFiles, options.minRisk);
  const scoreResult = resolveScore(options);
  const report = toReport(options, assessments, scoreResult.score, scoreResult.source);
  writeReport(options.outPath, report);
  printSummary(report, options.outPath);

  if (!report.pass) {
    process.exit(1);
  }
}

main();
