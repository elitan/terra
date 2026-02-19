import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Response(stream).text();
}

async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
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
    output: `${stdout}\n${stderr}`,
  };
}

describe("CLI Contract", () => {
  test("should fail when no connection string is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const schemaPath = join(dir, "schema.sql");
      await writeFile(schemaPath, "CREATE TABLE users (id INTEGER PRIMARY KEY);\n");

      const result = await runCli(["run", "src/index.ts", "apply", "-f", schemaPath], {
        DATABASE_URL: "",
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Database connection required. Provide -u/--url or set DATABASE_URL environment variable.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should fail fast on invalid lock timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const schemaPath = join(dir, "schema.sql");
      await writeFile(schemaPath, "CREATE TABLE users (id INTEGER PRIMARY KEY);\n");

      const result = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          schemaPath,
          "-u",
          "postgres://test:test@localhost:5432/test_db",
          "--lock-timeout",
          "0",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Invalid lock timeout: must be a positive number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should apply schema on sqlite and support dry-run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });

      const schemaPath = join(dir, "schema.sql");
      const dbPath = join(dbDir, "test.sqlite");

      await writeFile(
        schemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      const applyResult = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          schemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
        ],
        { DATABASE_URL: "" }
      );

      expect(applyResult.exitCode).toBe(0);

      const dryRunResult = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          schemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--dry-run",
        ],
        { DATABASE_URL: "" }
      );

      expect(dryRunResult.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
