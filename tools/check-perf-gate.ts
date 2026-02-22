#!/usr/bin/env bun

import { readFileSync } from "node:fs";

type PerfReport = {
  metrics: Record<string, number>;
};

type Threshold = {
  name: string;
  maxMs: number;
};

function parseThresholds(raw: string[]): Threshold[] {
  const thresholds: Threshold[] = [];
  for (const item of raw) {
    const parts = item.split(":");
    if (parts.length !== 2) {
      throw new Error(`Invalid threshold "${item}". Expected name:maxMs`);
    }
    const [name, maxMsRaw] = parts;
    if (!name) {
      throw new Error(`Invalid threshold "${item}". Missing name`);
    }
    const maxMs = Number.parseFloat(maxMsRaw);
    if (Number.isNaN(maxMs)) {
      throw new Error(`Invalid threshold "${item}". Invalid maxMs`);
    }
    thresholds.push({ name, maxMs });
  }
  return thresholds;
}

function loadReport(path: string): PerfReport {
  const content = readFileSync(path, "utf-8");
  const parsed = JSON.parse(content) as PerfReport;
  if (!parsed.metrics || typeof parsed.metrics !== "object") {
    throw new Error(`Invalid report file ${path}. Missing metrics`);
  }
  return parsed;
}

function main() {
  const [, , reportPath = "coverage/perf-report.json", ...rawThresholds] =
    process.argv;
  const thresholds = parseThresholds(rawThresholds);
  if (thresholds.length === 0) {
    throw new Error("At least one threshold is required (name:maxMs)");
  }
  const report = loadReport(reportPath);

  let passed = true;
  for (const threshold of thresholds) {
    const actual = report.metrics[threshold.name];
    if (typeof actual !== "number") {
      console.log(`fail ${threshold.name}: missing metric`);
      passed = false;
      continue;
    }
    const ok = actual <= threshold.maxMs;
    const status = ok ? "pass" : "fail";
    console.log(
      `${status} ${threshold.name}: ${actual.toFixed(2)}ms (max ${threshold.maxMs.toFixed(2)}ms)`
    );
    if (!ok) {
      passed = false;
    }
  }

  if (!passed) {
    process.exit(1);
  }
}

main();
