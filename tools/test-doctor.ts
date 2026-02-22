#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type CheckResult = {
  ok: boolean;
  name: string;
  detail: string;
};

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return { ok: result.status === 0, output };
}

function parseEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(filePath)) {
    return values;
  }
  const content = readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    values[key] = value;
  }
  return values;
}

function getEnvValue(
  key: string,
  envFileValues: Record<string, string>
): string | undefined {
  const processValue = process.env[key];
  if (processValue && processValue.length > 0) {
    return processValue;
  }
  const envValue = envFileValues[key];
  if (envValue && envValue.length > 0) {
    return envValue;
  }
  return undefined;
}

function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
  } catch {
    return false;
  }
}

function checkBun(): CheckResult {
  const result = run("bun", ["--version"]);
  if (!result.ok) {
    return { ok: false, name: "bun", detail: "bun is not available" };
  }
  return { ok: true, name: "bun", detail: `version ${result.output}` };
}

function checkDocker(): CheckResult {
  const docker = run("docker", ["info"]);
  if (!docker.ok) {
    return { ok: false, name: "docker", detail: "docker daemon is not reachable" };
  }
  const compose = run("docker", ["compose", "version"]);
  if (!compose.ok) {
    return { ok: false, name: "docker-compose", detail: "docker compose is not available" };
  }
  return { ok: true, name: "docker", detail: "docker and docker compose are ready" };
}

function checkEnvFile(envPath: string): CheckResult {
  if (!existsSync(envPath)) {
    return { ok: false, name: ".env", detail: `.env missing at ${envPath}` };
  }
  return { ok: true, name: ".env", detail: envPath };
}

function checkDbUrls(envFileValues: Record<string, string>): CheckResult[] {
  const required: Array<{ key: string; fallback?: string }> = [
    {
      key: "DATABASE_URL",
      fallback: "postgres://test_user:test_password@localhost:5487/sql_terraform_test",
    },
    {
      key: "DATABASE_URL_PG14",
      fallback: "postgres://test_user:test_password@localhost:5486/sql_terraform_test",
    },
    {
      key: "DATABASE_URL_PG15",
      fallback: "postgres://test_user:test_password@localhost:5485/sql_terraform_test",
    },
    {
      key: "DATABASE_URL_PG16",
      fallback: "postgres://test_user:test_password@localhost:5484/sql_terraform_test",
    },
    {
      key: "DATABASE_URL_PG17",
      fallback: "postgres://test_user:test_password@localhost:5487/sql_terraform_test",
    },
  ];

  const optional: Array<{ key: string; fallback?: string }> = [
    {
      key: "DATABASE_URL_PGVECTOR",
      fallback: "postgres://test_user:test_password@localhost:5488/sql_terraform_test",
    },
    {
      key: "DATABASE_URL_POSTGIS",
      fallback: "postgres://test_user:test_password@localhost:5489/sql_terraform_test",
    },
  ];

  const checks: CheckResult[] = [];

  for (const item of required) {
    const value = getEnvValue(item.key, envFileValues) || item.fallback;
    if (!value || !validateUrl(value)) {
      checks.push({
        ok: false,
        name: item.key,
        detail: "missing or invalid postgres url",
      });
      continue;
    }
    checks.push({ ok: true, name: item.key, detail: value });
  }

  for (const item of optional) {
    const value = getEnvValue(item.key, envFileValues) || item.fallback;
    if (!value || !validateUrl(value)) {
      checks.push({
        ok: false,
        name: item.key,
        detail: "missing or invalid postgres url",
      });
      continue;
    }
    checks.push({ ok: true, name: item.key, detail: value });
  }

  return checks;
}

function printResult(result: CheckResult): void {
  const prefix = result.ok ? "ok" : "fail";
  console.log(`${prefix} ${result.name}: ${result.detail}`);
}

function runDoctor(): number {
  const envPath = resolve(process.cwd(), ".env");
  const envFileValues = parseEnvFile(envPath);

  const checks: CheckResult[] = [];
  checks.push(checkBun());
  checks.push(checkDocker());
  checks.push(checkEnvFile(envPath));
  checks.push(...checkDbUrls(envFileValues));

  for (const check of checks) {
    printResult(check);
  }

  const failed = checks.filter((check) => !check.ok).length;
  if (failed > 0) {
    console.error(`test doctor failed: ${failed} check(s) failed`);
    return 1;
  }

  console.log("test doctor passed");
  return 0;
}

process.exit(runDoctor());
