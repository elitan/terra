import { readFileSync } from "node:fs";

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

function formatPercent(value: number): string {
  return value.toFixed(2);
}

function main() {
  const [, , reportPath = "coverage/lcov.info", minLineArg = "80", minFuncArg = "80"] = process.argv;
  const minLine = toNumber(minLineArg, 80);
  const minFunc = toNumber(minFuncArg, 80);

  const content = readFileSync(reportPath, "utf-8");

  let totalLines = 0;
  let hitLines = 0;
  let totalFuncs = 0;
  let hitFuncs = 0;

  for (const line of content.split("\n")) {
    if (line.startsWith("LF:")) {
      totalLines += toNumber(line.slice(3), 0);
      continue;
    }
    if (line.startsWith("LH:")) {
      hitLines += toNumber(line.slice(3), 0);
      continue;
    }
    if (line.startsWith("FNF:")) {
      totalFuncs += toNumber(line.slice(4), 0);
      continue;
    }
    if (line.startsWith("FNH:")) {
      hitFuncs += toNumber(line.slice(4), 0);
    }
  }

  const lineCoverage = totalLines === 0 ? 100 : (hitLines / totalLines) * 100;
  const functionCoverage = totalFuncs === 0 ? 100 : (hitFuncs / totalFuncs) * 100;

  console.log(`Coverage gate: lines=${formatPercent(lineCoverage)}% (min ${formatPercent(minLine)}%), functions=${formatPercent(functionCoverage)}% (min ${formatPercent(minFunc)}%)`);

  if (lineCoverage < minLine || functionCoverage < minFunc) {
    process.exit(1);
  }
}

main();
