import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  mutationRiskManifest,
  type MutationRiskEntry,
} from "./mutation-risk-manifest";

type Options = {
  reportPath: string;
  outPath: string;
};

type Location = {
  line: number | null;
  column: number | null;
};

type EscapedMutant = {
  id: string;
  file: string;
  status: string;
  mutator: string | null;
  replacement: string | null;
  location: Location;
  module: string;
  reason: string;
};

type ModuleRollup = {
  module: string;
  escapedCount: number;
  files: string[];
  reasons: string[];
};

type EscapedMutantReport = {
  generatedAt: string;
  sourceReport: string;
  totalEscaped: number;
  modules: ModuleRollup[];
  mutants: EscapedMutant[];
};

type ReportMutant = {
  id?: unknown;
  status?: unknown;
  mutatorName?: unknown;
  replacement?: unknown;
  location?: unknown;
};

type UnknownObject = Record<string, unknown>;

function parseArgs(argv: string[]): Options {
  const options: Options = {
    reportPath: "coverage/mutation/mutation-report.json",
    outPath: "coverage/mutation/escaped-mutants.json",
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
    if (name === "report") {
      options.reportPath = value;
      index += 1;
      continue;
    }
    if (name === "out") {
      options.outPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument --${name}`);
  }

  return options;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function toLocation(raw: unknown): Location {
  if (!isObject(raw)) {
    return { line: null, column: null };
  }

  const start = raw.start;
  if (!isObject(start)) {
    return { line: null, column: null };
  }

  const line = typeof start.line === "number" ? start.line : null;
  const column = typeof start.column === "number" ? start.column : null;
  return { line, column };
}

function isEscapedStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "survived" || normalized === "nocoverage";
}

function matchManifestEntry(file: string): MutationRiskEntry | null {
  const normalizedFile = normalizePath(file);
  for (const entry of mutationRiskManifest.entries) {
    const normalizedManifestPath = normalizePath(entry.path);
    if (
      normalizedFile === normalizedManifestPath ||
      normalizedFile.startsWith(`${normalizedManifestPath}/`)
    ) {
      return entry;
    }
  }
  return null;
}

function deriveModuleFromPath(file: string): string {
  const normalized = normalizePath(file);
  const segments = normalized.split("/");
  const srcIndex = segments.indexOf("src");
  if (srcIndex >= 0 && segments[srcIndex + 1]) {
    return `src/${segments[srcIndex + 1]}`;
  }
  if (segments[0]) {
    return segments[0];
  }
  return "unknown";
}

function mapMutant(file: string, mutant: ReportMutant, index: number): EscapedMutant | null {
  const statusRaw = toStringOrNull(mutant.status);
  if (!statusRaw) {
    return null;
  }
  if (!isEscapedStatus(statusRaw)) {
    return null;
  }

  const matchedEntry = matchManifestEntry(file);
  const module = matchedEntry ? matchedEntry.owner : deriveModuleFromPath(file);
  const reason = matchedEntry ? matchedEntry.reason : "no manifest mapping";

  const idRaw = toStringOrNull(mutant.id);
  const id = idRaw || `${normalizePath(file)}#${index + 1}`;

  return {
    id,
    file: normalizePath(file),
    status: statusRaw,
    mutator: toStringOrNull(mutant.mutatorName),
    replacement: toStringOrNull(mutant.replacement),
    location: toLocation(mutant.location),
    module,
    reason,
  };
}

function extractFromFilesNode(filesNode: UnknownObject): EscapedMutant[] {
  const escaped: EscapedMutant[] = [];
  for (const [file, fileNode] of Object.entries(filesNode)) {
    if (!isObject(fileNode)) {
      continue;
    }
    const mutants = fileNode.mutants;
    if (!Array.isArray(mutants)) {
      continue;
    }
    for (let index = 0; index < mutants.length; index += 1) {
      const mutant = mutants[index];
      if (!isObject(mutant)) {
        continue;
      }
      const mapped = mapMutant(file, mutant, index);
      if (mapped) {
        escaped.push(mapped);
      }
    }
  }
  return escaped;
}

function extractFromMutantsArray(mutants: unknown[]): EscapedMutant[] {
  const escaped: EscapedMutant[] = [];
  for (let index = 0; index < mutants.length; index += 1) {
    const mutant = mutants[index];
    if (!isObject(mutant)) {
      continue;
    }
    const fileRaw =
      toStringOrNull(mutant.file) ||
      toStringOrNull(mutant.sourceFilePath) ||
      toStringOrNull(mutant.path);
    if (!fileRaw) {
      continue;
    }
    const mapped = mapMutant(fileRaw, mutant, index);
    if (mapped) {
      escaped.push(mapped);
    }
  }
  return escaped;
}

function extractEscapedMutants(parsed: unknown): EscapedMutant[] {
  if (!isObject(parsed)) {
    return [];
  }

  const filesNode = parsed.files;
  if (isObject(filesNode)) {
    return extractFromFilesNode(filesNode);
  }

  const mutantsNode = parsed.mutants;
  if (Array.isArray(mutantsNode)) {
    return extractFromMutantsArray(mutantsNode);
  }

  return [];
}

function buildModuleRollup(mutants: EscapedMutant[]): ModuleRollup[] {
  const map = new Map<string, { files: Set<string>; reasons: Set<string>; escapedCount: number }>();

  for (const mutant of mutants) {
    const existing = map.get(mutant.module);
    if (!existing) {
      map.set(mutant.module, {
        escapedCount: 1,
        files: new Set([mutant.file]),
        reasons: new Set([mutant.reason]),
      });
      continue;
    }
    existing.escapedCount += 1;
    existing.files.add(mutant.file);
    existing.reasons.add(mutant.reason);
  }

  const rollup: ModuleRollup[] = [];
  for (const [module, value] of map.entries()) {
    rollup.push({
      module,
      escapedCount: value.escapedCount,
      files: Array.from(value.files).sort(),
      reasons: Array.from(value.reasons).sort(),
    });
  }

  rollup.sort(function (a, b) {
    if (b.escapedCount !== a.escapedCount) {
      return b.escapedCount - a.escapedCount;
    }
    return a.module.localeCompare(b.module);
  });

  return rollup;
}

function toReport(sourceReport: string, mutants: EscapedMutant[]): EscapedMutantReport {
  return {
    generatedAt: new Date().toISOString(),
    sourceReport,
    totalEscaped: mutants.length,
    modules: buildModuleRollup(mutants),
    mutants,
  };
}

function writeReport(path: string, report: EscapedMutantReport): void {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

function printSummary(report: EscapedMutantReport, outPath: string): void {
  console.log(`escaped mutants: ${report.totalEscaped}`);
  console.log(`module groups: ${report.modules.length}`);
  console.log(`report: ${outPath}`);
  for (const module of report.modules.slice(0, 10)) {
    console.log(`- ${module.module}: ${module.escapedCount}`);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const content = readFileSync(options.reportPath, "utf-8");
  const parsed = JSON.parse(content) as unknown;
  const escapedMutants = extractEscapedMutants(parsed);
  const report = toReport(options.reportPath, escapedMutants);
  writeReport(options.outPath, report);
  printSummary(report, options.outPath);
}

main();
