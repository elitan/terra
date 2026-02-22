import { readFileSync } from "node:fs";

type LcovFileCoverage = {
  file: string;
  lf: number;
  lh: number;
  fnf: number;
  fnh: number;
};

type CoverageRule = {
  pattern: string;
  minLine: number;
  minFunc: number;
};

type CoverageTotals = {
  lf: number;
  lh: number;
  fnf: number;
  fnh: number;
};

const DEFAULT_EXCLUDES = ["src/test/"];

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

function formatPercent(value: number): string {
  return value.toFixed(2);
}

function parseRules(rawRules: string[]): CoverageRule[] {
  const rules: CoverageRule[] = [];
  for (const raw of rawRules) {
    const parts = raw.split(":");
    if (parts.length !== 3) {
      throw new Error(
        `Invalid rule "${raw}". Expected format pattern:minLine:minFunc`
      );
    }
    const [pattern, minLineRaw, minFuncRaw] = parts;
    if (!pattern) {
      throw new Error(`Invalid rule "${raw}". Missing pattern`);
    }
    const minLine = toNumber(minLineRaw, Number.NaN);
    const minFunc = toNumber(minFuncRaw, Number.NaN);
    if (Number.isNaN(minLine) || Number.isNaN(minFunc)) {
      throw new Error(`Invalid rule "${raw}". Invalid numeric thresholds`);
    }
    rules.push({ pattern, minLine, minFunc });
  }
  return rules;
}

function parseLcov(content: string): LcovFileCoverage[] {
  const entries: LcovFileCoverage[] = [];
  const blocks = content.split("end_of_record");

  for (const block of blocks) {
    const lines = block.split("\n");
    let file = "";
    let lf = 0;
    let lh = 0;
    let fnf = 0;
    let fnh = 0;

    for (const line of lines) {
      if (line.startsWith("SF:")) {
        file = line.slice(3).trim();
        continue;
      }
      if (line.startsWith("LF:")) {
        lf = toNumber(line.slice(3), 0);
        continue;
      }
      if (line.startsWith("LH:")) {
        lh = toNumber(line.slice(3), 0);
        continue;
      }
      if (line.startsWith("FNF:")) {
        fnf = toNumber(line.slice(4), 0);
        continue;
      }
      if (line.startsWith("FNH:")) {
        fnh = toNumber(line.slice(4), 0);
      }
    }

    if (file && !shouldExclude(file)) {
      entries.push({ file, lf, lh, fnf, fnh });
    }
  }

  return entries;
}

function shouldExclude(file: string): boolean {
  for (const pattern of DEFAULT_EXCLUDES) {
    if (file.includes(pattern)) {
      return true;
    }
  }
  return false;
}

function aggregateCoverage(entries: LcovFileCoverage[]): CoverageTotals {
  const totals: CoverageTotals = { lf: 0, lh: 0, fnf: 0, fnh: 0 };
  for (const entry of entries) {
    totals.lf += entry.lf;
    totals.lh += entry.lh;
    totals.fnf += entry.fnf;
    totals.fnh += entry.fnh;
  }
  return totals;
}

function lineCoverage(totals: CoverageTotals): number {
  if (totals.lf === 0) return 100;
  return (totals.lh / totals.lf) * 100;
}

function functionCoverage(totals: CoverageTotals): number {
  if (totals.fnf === 0) return 100;
  return (totals.fnh / totals.fnf) * 100;
}

function filterByPattern(
  entries: LcovFileCoverage[],
  pattern: string
): LcovFileCoverage[] {
  return entries.filter((entry) => entry.file.includes(pattern));
}

function checkThresholds(
  name: string,
  totals: CoverageTotals,
  minLine: number,
  minFunc: number
): boolean {
  const line = lineCoverage(totals);
  const func = functionCoverage(totals);
  const ok = line >= minLine && func >= minFunc;
  const status = ok ? "pass" : "fail";
  console.log(
    `${status} ${name}: lines=${formatPercent(line)}% (min ${formatPercent(
      minLine
    )}%), functions=${formatPercent(func)}% (min ${formatPercent(minFunc)}%)`
  );
  return ok;
}

function main() {
  const [, , reportPath = "coverage/lcov.info", minLineArg = "95", minFuncArg = "95", ...rawRules] =
    process.argv;

  const minLine = toNumber(minLineArg, 95);
  const minFunc = toNumber(minFuncArg, 95);
  const rules = parseRules(rawRules);
  const content = readFileSync(reportPath, "utf-8");
  const entries = parseLcov(content);
  const globalTotals = aggregateCoverage(entries);

  let passed = true;
  passed = checkThresholds("global", globalTotals, minLine, minFunc) && passed;

  for (const rule of rules) {
    const matched = filterByPattern(entries, rule.pattern);
    if (matched.length === 0) {
      console.log(`fail ${rule.pattern}: no files matched`);
      passed = false;
      continue;
    }
    const totals = aggregateCoverage(matched);
    const ok = checkThresholds(
      rule.pattern,
      totals,
      rule.minLine,
      rule.minFunc
    );
    passed = ok && passed;
  }

  if (!passed) {
    process.exit(1);
  }
}

main();
