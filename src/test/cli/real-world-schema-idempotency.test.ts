import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CliApplyOutput } from "../../types/cli-output";

const requiredExtensionNames = ["vector", "pgcrypto", "pg_trgm", "postgis"];

function schemaPath(): string {
  return join(process.cwd(), "src", "test", "fixtures", "idempotency-regressions", "synthetic-extensions-schema.sql");
}

function managedSchemas(file: string): string[] {
  const schemas = new Set<string>(["public"]);
  const content = readFileSync(file, "utf-8");
  const pattern = /^\s*create\s+schema(?:\s+if\s+not\s+exists)?\s+("?)([a-zA-Z_][a-zA-Z0-9_]*)\1\s*;/gim;

  for (const match of content.matchAll(pattern)) {
    const schemaName = match[2];
    if (schemaName) {
      schemas.add(schemaName);
    }
  }

  return Array.from(schemas);
}

function candidateUrls(): string[] {
  const values = [
    process.env.REAL_WORLD_SCHEMA_DATABASE_URL,
    process.env.EXTENSIONS_DATABASE_URL,
    process.env.DATABASE_URL,
    process.env.DATABASE_URL_PG18,
    process.env.DATABASE_URL_PG17,
    process.env.DATABASE_URL_PG16,
    process.env.DATABASE_URL_PG15,
    process.env.DATABASE_URL_PG14,
    "postgres://test_user:test_password@localhost:5490/postgres",
  ];
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    urls.push(value);
  }

  return urls;
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return "";
  }
  return await new Response(stream).text();
}

async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(extraEnv)) {
    env[key] = value;
  }

  const proc = Bun.spawn([process.execPath, ...args], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ]);

  return {
    exitCode,
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`,
  };
}

function parseJsonOutput(output: string): CliApplyOutput {
  const lines = output
    .split("\n")
    .map(function (line) {
      return line.trim();
    })
    .filter(Boolean);
  const jsonLine = lines.find(function (line) {
    return line.startsWith("{") && line.endsWith("}");
  });

  if (!jsonLine) {
    throw new Error(`No JSON output line found: ${output}`);
  }

  return JSON.parse(jsonLine) as CliApplyOutput;
}

async function availableExtensions(connectionString: string): Promise<Set<string> | undefined> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 1500,
  });

  try {
    await client.connect();
    const result = await client.query(
      `
      SELECT name
      FROM pg_available_extensions
      WHERE name = ANY($1::text[])
      `,
      [requiredExtensionNames]
    );

    return new Set(
      result.rows.map(function (row) {
        return row.name as string;
      })
    );
  } catch {
    return undefined;
  } finally {
    try {
      await client.end();
    } catch {
    }
  }
}

async function findSyntheticSchemaDatabaseUrl(): Promise<string | undefined> {
  for (const url of candidateUrls()) {
    const extensions = await availableExtensions(url);
    if (!extensions) {
      continue;
    }

    const supportsAll = requiredExtensionNames.every(function (name) {
      return extensions.has(name);
    });

    if (supportsAll) {
      return url;
    }
  }

  return undefined;
}

const syntheticSchemaDatabaseUrl = await findSyntheticSchemaDatabaseUrl();

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function buildDatabaseUrl(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createDatabase(connectionString: string, databaseName: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(connectionString: string, databaseName: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

describe("CLI synthetic schema idempotency", () => {
  test.skipIf(!syntheticSchemaDatabaseUrl)(
    "should apply the synthetic schema twice with no changes on second run",
    async function () {
    const databaseName = `synthetic_schema_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const databaseUrl = buildDatabaseUrl(syntheticSchemaDatabaseUrl!, databaseName);
    const file = schemaPath();
    const schemas = managedSchemas(file);
    const schemaArgs = schemas.flatMap(function (schemaName) {
      return ["--schema", schemaName];
    });

    await createDatabase(syntheticSchemaDatabaseUrl!, databaseName);

    try {
      const firstRun = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          file,
          "-u",
          databaseUrl,
          ...schemaArgs,
          "--auto-approve",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(firstRun.exitCode).toBe(0);
      const firstPayload = parseJsonOutput(firstRun.output);
      expect(firstPayload.command).toBe("apply");
      expect(firstPayload.hasChanges).toBe(true);
      expect(firstPayload.counts.total).toBeGreaterThan(0);

      const secondRun = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          file,
          "-u",
          databaseUrl,
          ...schemaArgs,
          "--auto-approve",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(secondRun.exitCode).toBe(0);
      const secondPayload = parseJsonOutput(secondRun.output);
      expect(secondPayload.command).toBe("apply");
      expect(secondPayload.file).toBe(file);
      expect(secondPayload.hasChanges).toBe(false);
      expect(secondPayload.counts).toEqual({
        preTransactional: 0,
        transactional: 0,
        deferred: 0,
        concurrent: 0,
        total: 0,
      });
      expect(secondPayload.statements).toEqual({
        preTransactional: [],
        transactional: [],
        deferred: [],
        concurrent: [],
      });
      expect(secondPayload.statementMetadata).toEqual([]);
    } finally {
      await dropDatabase(syntheticSchemaDatabaseUrl!, databaseName);
    }
  }, 180000);
});
