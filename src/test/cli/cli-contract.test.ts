import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";

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
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`,
  };
}

function findJsonOutputLine(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = lines.find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) {
    throw new Error(`No JSON output line found: ${output}`);
  }
  return jsonLine;
}

function parseJsonOutput(output: string): any {
  return JSON.parse(findJsonOutputLine(output));
}

function extractJsonOutputLine(output: string): string {
  return findJsonOutputLine(output);
}

async function isPostgresReachable(connectionString: string): Promise<boolean> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 1500,
  });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    try {
      await client.end();
    } catch {
    }
  }
}

async function getReachablePostgresUrls(): Promise<string[]> {
  const candidates = [
    process.env.DATABASE_URL_PG14,
    process.env.DATABASE_URL_PG18,
    process.env.DATABASE_URL_PG17,
    process.env.DATABASE_URL,
  ];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (await isPostgresReachable(candidate)) {
      urls.push(candidate);
    }
  }
  return urls;
}

const reachablePostgresUrls = await getReachablePostgresUrls();

describe("CLI Contract", () => {
  test("should show root help with expected commands and options", async function () {
    const result = await runCli(["run", "src/index.ts", "--help"], {
      DATABASE_URL: "",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe("");
    expect(result.stdout).toContain("Usage: terradb");
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toContain("plan [options]");
    expect(result.stdout).toContain("apply [options]");
    expect(result.stdout).toContain("--no-color");
  });

  test("should show apply help with contract flags", async function () {
    const result = await runCli(["run", "src/index.ts", "apply", "--help"], {
      DATABASE_URL: "",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe("");
    expect(result.stdout).toContain("Usage: terradb apply");
    expect(result.stdout).toContain("--auto-approve");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("--strict");
    expect(result.stdout).toContain("--format <format>");
  });

  test("should show plan help with contract flags", async function () {
    const result = await runCli(["run", "src/index.ts", "plan", "--help"], {
      DATABASE_URL: "",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe("");
    expect(result.stdout).toContain("Usage: terradb plan");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout).toContain("--schema <schema>");
  });

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

  test("should return validation error code in json mode for invalid lock timeout", async () => {
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
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(1);
      const payload = parseJsonOutput(result.output);
      expect(payload.schemaVersion).toBe(2);
      expect(payload.error.code).toBe("VALIDATION_ERROR");
      expect(payload.error.name).toBe("ValidationError");
      expect(payload.error.message).toContain("Invalid lock timeout");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should reject unsupported PostgreSQL connection options before connecting", async function () {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const schemaPath = join(dir, "schema.sql");
      await writeFile(schemaPath, "CREATE TABLE users (id INTEGER PRIMARY KEY);\n");

      const result = await runCli(
        [
          "run",
          "src/index.ts",
          "plan",
          "-f",
          schemaPath,
          "-u",
          "postgres://user:secret@unreachable.invalid/database?sslmode=allow",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      const payload = parseJsonOutput(result.stdout);
      expect(payload.error).toEqual({
        code: "VALIDATION_ERROR",
        name: "ValidationError",
        message: "Unsupported PostgreSQL sslmode: allow",
      });
      expect(result.stdout).not.toContain("secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should write json errors to stdout and keep stderr empty", async () => {
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
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).toBe("");
      expect(result.stdout.trim().startsWith("{")).toBe(true);
      const payload = parseJsonOutput(result.output);
      expect(payload.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should write text errors to stderr and keep stdout empty", async () => {
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
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout.trim()).toBe("");
      expect(result.stderr).toContain("Invalid lock timeout: must be a positive number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should return parser error code in json mode for invalid sql", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });
      const schemaPath = join(dir, "bad.sql");
      const dbPath = join(dbDir, "invalid-sql.sqlite");

      await writeFile(
        schemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          broken ???
        );
        `.trim() + "\n"
      );

      const result = await runCli(
        [
          "run",
          "src/index.ts",
          "plan",
          "-f",
          schemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(1);
      const payload = parseJsonOutput(result.output);
      expect(payload.schemaVersion).toBe(2);
      expect(payload.error.code).toBe("PARSER_ERROR");
      expect(payload.error.name).toBe("ParserError");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should return migration error code in json mode for runtime apply failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });

      const baseSchemaPath = join(dir, "base.sql");
      const strictSchemaPath = join(dir, "strict.sql");
      const dbPath = join(dbDir, "migration-error.sqlite");

      await writeFile(
        baseSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT
        );
        `.trim() + "\n"
      );

      await writeFile(
        strictSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      const seedResult = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          baseSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(seedResult.exitCode).toBe(0);

      const db = new Database(dbPath);
      try {
        db.exec("INSERT INTO users (id, email) VALUES (1, NULL)");
      } finally {
        db.close();
      }

      const result = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          strictSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(1);
      const payload = parseJsonOutput(result.output);
      expect(payload.schemaVersion).toBe(2);
      expect(payload.error.code).toBe("MIGRATION_ERROR");
      expect(payload.error.name).toBe("MigrationError");
      expect(payload.error.message).toContain("NOT NULL");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should fail in non-interactive mode without auto-approve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });

      const schemaPath = join(dir, "schema.sql");
      const dbPath = join(dbDir, "prompt-required.sqlite");

      await writeFile(
        schemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY
        );
        `.trim() + "\n"
      );

      const result = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          schemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Confirmation prompt requires interactive terminal");
      expect(result.stderr).toContain("--auto-approve");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should keep prompt-required text output snapshot stable in non-interactive mode", async function () {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });

      const schemaPath = join(dir, "schema.sql");
      const dbPath = join(dbDir, "prompt-required-text-snapshot.sqlite");

      await writeFile(
        schemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY
        );
        `.trim() + "\n"
      );

      const result = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          schemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--no-color",
        ],
        { DATABASE_URL: "", COLUMNS: "80" }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).toBe(
        [
          "Validation Error",
          "",
          "  Confirmation prompt requires interactive terminal. Use --auto-approve to",
          "  continue",
          "",
          "  Entity: apply",
          "  Field: auto-approve",
          "  Value: false",
        ].join("\n")
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should return validation error json when prompt is required in non-interactive mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });

      const schemaPath = join(dir, "schema.sql");
      const dbPath = join(dbDir, "prompt-required-json.sqlite");

      await writeFile(
        schemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY
        );
        `.trim() + "\n"
      );

      const result = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          schemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).toBe("");
      const payload = parseJsonOutput(result.output);
      expect(payload.schemaVersion).toBe(2);
      expect(payload.error.code).toBe("VALIDATION_ERROR");
      expect(payload.error.name).toBe("ValidationError");
      expect(payload.error.message).toContain("Confirmation prompt requires interactive terminal");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should fail with strict mode error before prompt requirement in non-interactive mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });

      const baseSchemaPath = join(dir, "strict-base.sql");
      const dropSchemaPath = join(dir, "strict-drop.sql");
      const dbPath = join(dbDir, "strict-before-prompt.sqlite");

      await writeFile(
        baseSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      await writeFile(
        dropSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY
        );
        `.trim() + "\n"
      );

      const seedResult = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          baseSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(seedResult.exitCode).toBe(0);

      const result = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          dropSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--strict",
          "--dry-run",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Strict mode blocked destructive migration statements");
      expect(result.stderr).not.toContain("Confirmation prompt requires interactive terminal");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should return strict mode json error before prompt requirement in non-interactive mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });

      const baseSchemaPath = join(dir, "strict-json-base.sql");
      const dropSchemaPath = join(dir, "strict-json-drop.sql");
      const dbPath = join(dbDir, "strict-json-before-prompt.sqlite");

      await writeFile(
        baseSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      await writeFile(
        dropSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY
        );
        `.trim() + "\n"
      );

      const seedResult = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          baseSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(seedResult.exitCode).toBe(0);

      const result = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          dropSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--strict",
          "--dry-run",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).toBe("");
      const payload = parseJsonOutput(result.output);
      expect(payload.schemaVersion).toBe(2);
      expect(payload.error.code).toBe("STRICT_MODE_ERROR");
      expect(payload.error.name).toBe("StrictModeError");
      expect(payload.error.message).toContain("Strict mode blocked destructive migration statements");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should keep json error snapshots stable for common failure paths", async function () {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });

      const promptSchemaPath = join(dir, "prompt-schema.sql");
      const promptDbPath = join(dbDir, "prompt-snapshot.sqlite");
      await writeFile(
        promptSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY
        );
        `.trim() + "\n"
      );

      const strictBaseSchemaPath = join(dir, "strict-base.sql");
      const strictDropSchemaPath = join(dir, "strict-drop.sql");
      const strictDbPath = join(dbDir, "strict-snapshot.sqlite");
      await writeFile(
        strictBaseSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );
      await writeFile(
        strictDropSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY
        );
        `.trim() + "\n"
      );

      const seedResult = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          strictBaseSchemaPath,
          "-u",
          `sqlite:///${strictDbPath}`,
          "--auto-approve",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(seedResult.exitCode).toBe(0);

      const cases = [
        {
          args: [
            "run",
            "src/index.ts",
            "apply",
            "-f",
            promptSchemaPath,
            "-u",
            "postgres://test:test@localhost:5432/test_db",
            "--lock-timeout",
            "0",
            "--format",
            "json",
            "--no-color",
          ],
          expected: {
            schemaVersion: 2,
            error: {
              code: "VALIDATION_ERROR",
              name: "ValidationError",
              message: "Invalid lock timeout: must be a positive number",
            },
          },
        },
        {
          args: [
            "run",
            "src/index.ts",
            "apply",
            "-f",
            promptSchemaPath,
            "-u",
            `sqlite:///${promptDbPath}`,
            "--format",
            "json",
            "--no-color",
          ],
          expected: {
            schemaVersion: 2,
            error: {
              code: "VALIDATION_ERROR",
              name: "ValidationError",
              message: "Confirmation prompt requires interactive terminal. Use --auto-approve to continue",
            },
          },
        },
        {
          args: [
            "run",
            "src/index.ts",
            "apply",
            "-f",
            strictDropSchemaPath,
            "-u",
            `sqlite:///${strictDbPath}`,
            "--auto-approve",
            "--dry-run",
            "--strict",
            "--format",
            "json",
            "--no-color",
          ],
          expected: {
            schemaVersion: 2,
            error: {
              code: "STRICT_MODE_ERROR",
              name: "StrictModeError",
              message: "Strict mode blocked destructive migration statements",
            },
          },
        },
      ];

      for (const item of cases) {
        const result = await runCli(item.args, { DATABASE_URL: "" });
        expect(result.exitCode).toBe(1);
        const jsonLine = extractJsonOutputLine(result.output);
        expect(jsonLine).toBe(JSON.stringify(item.expected));
      }
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

  test("should support plan command with json format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });
      const schemaPath = join(dir, "schema.sql");
      const dbPath = join(dbDir, "plan.sqlite");

      await writeFile(
        schemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      const result = await runCli(
        [
          "run",
          "src/index.ts",
          "plan",
          "-f",
          schemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(0);
      const payload = parseJsonOutput(result.output);
      const createUsersSql = `CREATE TABLE "users" (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );`;
      expect(payload).toEqual({
        schemaVersion: 2,
        command: "plan",
        dialect: "sqlite",
        file: schemaPath,
        schemas: ["public"],
        hasChanges: true,
        counts: {
          preTransactional: 0,
          transactional: 1,
          deferred: 0,
          concurrent: 0,
          total: 1,
        },
        statements: {
          preTransactional: [],
          transactional: [createUsersSql],
          deferred: [],
          concurrent: [],
        },
        statementMetadata: [
          {
            order: 1,
            channel: "transactional",
            category: "table",
            risk: "safe",
            sql: createUsersSql,
          },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should treat sql-like file paths as files in plan command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });
      const baseSchemaPath = join(dir, "base.sql");
      const withViewSchemaPath = join(dir, "with-view.sql");
      const dbPath = join(dbDir, "plan-path.sqlite");

      await writeFile(
        baseSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      await writeFile(
        withViewSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );

        CREATE VIEW active_users AS
        SELECT id, email FROM users;
        `.trim() + "\n"
      );

      const applyResult = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          baseSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(applyResult.exitCode).toBe(0);

      const textPlanResult = await runCli(
        [
          "run",
          "src/index.ts",
          "plan",
          "-f",
          withViewSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(textPlanResult.exitCode).toBe(0);
      expect(textPlanResult.output).toContain("CREATE VIEW");
      expect(textPlanResult.output).not.toContain("No changes needed - database is up to date");

      const planResult = await runCli(
        [
          "run",
          "src/index.ts",
          "plan",
          "-f",
          withViewSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(planResult.exitCode).toBe(0);
      const payload = parseJsonOutput(planResult.output);
      expect(payload.command).toBe("plan");
      expect(payload.hasChanges).toBe(true);
      expect(payload.statements.transactional.join("\n")).toContain("CREATE VIEW");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should support apply dry-run with json format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });
      const schemaPath = join(dir, "schema.sql");
      const dbPath = join(dbDir, "apply-json.sqlite");

      await writeFile(
        schemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      const result = await runCli(
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
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(0);
      const payload = parseJsonOutput(result.output);
      const createUsersSql = `CREATE TABLE "users" (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );`;
      expect(payload).toEqual({
        schemaVersion: 2,
        command: "apply",
        dialect: "sqlite",
        file: schemaPath,
        schemas: ["public"],
        dryRun: true,
        strict: false,
        hasChanges: true,
        counts: {
          preTransactional: 0,
          transactional: 1,
          deferred: 0,
          concurrent: 0,
          total: 1,
        },
        statements: {
          preTransactional: [],
          transactional: [createUsersSql],
          deferred: [],
          concurrent: [],
        },
        statementMetadata: [
          {
            order: 1,
            channel: "transactional",
            category: "table",
            risk: "safe",
            sql: createUsersSql,
          },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should return deterministic mixed statement metadata in plan json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });
      const baseSchemaPath = join(dir, "base.sql");
      const nextSchemaPath = join(dir, "next.sql");
      const dbPath = join(dbDir, "metadata.sqlite");

      await writeFile(
        baseSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );

        CREATE TABLE posts (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      await writeFile(
        nextSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL,
          name TEXT
        );
        `.trim() + "\n"
      );

      const applyResult = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          baseSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(applyResult.exitCode).toBe(0);

      const planResult = await runCli(
        [
          "run",
          "src/index.ts",
          "plan",
          "-f",
          nextSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(planResult.exitCode).toBe(0);
      const payload = parseJsonOutput(planResult.output);
      expect(payload.counts.total).toBe(2);
      expect(payload.statementMetadata).toHaveLength(2);

      expect(payload.statementMetadata[0]).toEqual({
        order: 1,
        channel: "transactional",
        category: "table",
        risk: "safe",
        sql: payload.statements.transactional[0],
      });
      expect(payload.statementMetadata[1]).toEqual({
        order: 2,
        channel: "transactional",
        category: "table",
        risk: "destructive",
        sql: payload.statements.transactional[1],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should disable ansi colors with --no-color", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });
      const schemaPath = join(dir, "schema.sql");
      const dbPath = join(dbDir, "no-color.sqlite");

      await writeFile(
        schemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY
        );
        `.trim() + "\n"
      );

      const result = await runCli(
        [
          "run",
          "src/index.ts",
          "plan",
          "-f",
          schemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(result.exitCode).toBe(0);
      expect(result.output.includes("\u001b[")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should keep json plan output deterministic across repeated runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });
      const schemaPath = join(dir, "schema.sql");
      const dbPath = join(dbDir, "deterministic.sqlite");

      await writeFile(
        schemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      const args = [
        "run",
        "src/index.ts",
        "plan",
        "-f",
        schemaPath,
        "-u",
        `sqlite:///${dbPath}`,
        "--format",
        "json",
        "--no-color",
      ];

      const run1 = await runCli(args, { DATABASE_URL: "" });
      const run2 = await runCli(args, { DATABASE_URL: "" });

      expect(run1.exitCode).toBe(0);
      expect(run2.exitCode).toBe(0);

      const payload1 = parseJsonOutput(run1.output);
      const payload2 = parseJsonOutput(run2.output);

      expect(payload1).toEqual(payload2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("should keep raw json plan output byte-identical across repeated runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });
      const schemaPath = join(dir, "schema.sql");
      const dbPath = join(dbDir, "deterministic-raw.sqlite");

      await writeFile(
        schemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      const args = [
        "run",
        "src/index.ts",
        "plan",
        "-f",
        schemaPath,
        "-u",
        `sqlite:///${dbPath}`,
        "--format",
        "json",
        "--no-color",
      ];

      const run1 = await runCli(args, { DATABASE_URL: "" });
      const run2 = await runCli(args, { DATABASE_URL: "" });

      expect(run1.exitCode).toBe(0);
      expect(run2.exitCode).toBe(0);
      expect(extractJsonOutputLine(run1.output)).toBe(extractJsonOutputLine(run2.output));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("should fail in strict mode when destructive statements are present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });
      const schemaPath = join(dir, "schema.sql");
      const dbPath = join(dbDir, "strict.sqlite");

      await writeFile(
        schemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      const createResult = await runCli(
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
      expect(createResult.exitCode).toBe(0);

      await writeFile(schemaPath, "\n");

      const strictResult = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          schemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--strict",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(strictResult.exitCode).toBe(1);
      const payload = parseJsonOutput(strictResult.output);
      expect(payload.schemaVersion).toBe(2);
      expect(payload.error.code).toBe("STRICT_MODE_ERROR");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should fail in strict mode during dry-run when destructive statements are present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });
      const schemaPath = join(dir, "schema.sql");
      const dbPath = join(dbDir, "strict-dry-run.sqlite");

      await writeFile(
        schemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      const createResult = await runCli(
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
      expect(createResult.exitCode).toBe(0);

      await writeFile(schemaPath, "\n");

      const strictDryRunResult = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          schemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--strict",
          "--dry-run",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );

      expect(strictDryRunResult.exitCode).toBe(1);
      const payload = parseJsonOutput(strictDryRunResult.output);
      expect(payload.schemaVersion).toBe(2);
      expect(payload.error.code).toBe("STRICT_MODE_ERROR");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(reachablePostgresUrls.length === 0)(
    "should expose ordered enum additions in the pre-transactional plan channel",
    async function () {
      const postgresUrl = reachablePostgresUrls[0];
      if (!postgresUrl) return;

      const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
      const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      const schemaName = `cli_enum_phase_${suffix}`;
      const seedSchemaPath = join(dir, `enum-phase-seed-${suffix}.sql`);
      const nextSchemaPath = join(dir, `enum-phase-next-${suffix}.sql`);
      const client = new Client({ connectionString: postgresUrl });

      try {
        await writeFile(
          seedSchemaPath,
          `
          CREATE SCHEMA ${schemaName};
          CREATE TYPE ${schemaName}.priority AS ENUM ('low', 'high');
          CREATE TABLE ${schemaName}.tasks (
            id INTEGER PRIMARY KEY,
            priority ${schemaName}.priority NOT NULL DEFAULT 'low'
          );
          `.trim() + "\n"
        );
        await writeFile(
          nextSchemaPath,
          `
          CREATE SCHEMA ${schemaName};
          CREATE TYPE ${schemaName}.priority AS ENUM ('low', 'can''t wait', 'high');
          CREATE TABLE ${schemaName}.tasks (
            id INTEGER PRIMARY KEY,
            priority ${schemaName}.priority NOT NULL DEFAULT 'can''t wait'
          );
          `.trim() + "\n"
        );

        const seedResult = await runCli(
          [
            "run",
            "src/index.ts",
            "apply",
            "-f",
            seedSchemaPath,
            "-u",
            postgresUrl,
            "--schema",
            schemaName,
            "--auto-approve",
            "--no-color",
          ],
          { DATABASE_URL: "" }
        );
        expect(seedResult.exitCode).toBe(0);

        const planResult = await runCli(
          [
            "run",
            "src/index.ts",
            "plan",
            "-f",
            nextSchemaPath,
            "-u",
            postgresUrl,
            "--schema",
            schemaName,
            "--format",
            "json",
            "--no-color",
          ],
          { DATABASE_URL: "" }
        );
        expect(planResult.exitCode).toBe(0);

        const payload = parseJsonOutput(planResult.output);
        const enumStatement =
          `ALTER TYPE "${schemaName}"."priority" ` +
          `ADD VALUE 'can''t wait' BEFORE 'high';`;
        expect(payload.schemaVersion).toBe(2);
        expect(payload.counts.preTransactional).toBe(1);
        expect(payload.statements.preTransactional).toEqual([enumStatement]);
        expect(payload.statementMetadata[0]).toEqual({
          order: 1,
          channel: "pre-transactional",
          category: "enum",
          risk: "safe",
          sql: enumStatement,
        });
        expect(payload.counts.transactional).toBe(1);
      } finally {
        try {
          await client.connect();
          await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        } finally {
          try {
            await client.end();
          } catch {
          }
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
  );

  test.skipIf(reachablePostgresUrls.length === 0)(
    "should expose composite attribute drops as destructive type changes",
    async function () {
      const postgresUrl = reachablePostgresUrls[0];
      if (!postgresUrl) return;

      const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
      const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      const schemaName = `cli_composite_risk_${suffix}`;
      const seedSchemaPath = join(dir, `composite-risk-seed-${suffix}.sql`);
      const nextSchemaPath = join(dir, `composite-risk-next-${suffix}.sql`);
      const client = new Client({ connectionString: postgresUrl });

      try {
        await writeFile(
          seedSchemaPath,
          `
          CREATE SCHEMA ${schemaName};
          CREATE TYPE ${schemaName}.payload AS (
            value integer,
            legacy text
          );
          `.trim() + "\n"
        );
        await writeFile(
          nextSchemaPath,
          `
          CREATE SCHEMA ${schemaName};
          CREATE TYPE ${schemaName}.payload AS (value integer);
          `.trim() + "\n"
        );

        const seedResult = await runCli(
          [
            "run",
            "src/index.ts",
            "apply",
            "-f",
            seedSchemaPath,
            "-u",
            postgresUrl,
            "--schema",
            schemaName,
            "--auto-approve",
            "--no-color",
          ],
          { DATABASE_URL: "" }
        );
        expect(seedResult.exitCode).toBe(0);

        const planResult = await runCli(
          [
            "run",
            "src/index.ts",
            "plan",
            "-f",
            nextSchemaPath,
            "-u",
            postgresUrl,
            "--schema",
            schemaName,
            "--format",
            "json",
            "--no-color",
          ],
          { DATABASE_URL: "" }
        );
        expect(planResult.exitCode).toBe(0);

        const payload = parseJsonOutput(planResult.output);
        const dropStatement =
          `ALTER TYPE "${schemaName}"."payload" ` +
          `DROP ATTRIBUTE "legacy" RESTRICT;`;
        expect(payload.statements.transactional).toEqual([dropStatement]);
        expect(payload.statementMetadata).toEqual([
          {
            order: 1,
            channel: "transactional",
            category: "type",
            risk: "destructive",
            sql: dropStatement,
          },
        ]);

        const strictResult = await runCli(
          [
            "run",
            "src/index.ts",
            "apply",
            "-f",
            nextSchemaPath,
            "-u",
            postgresUrl,
            "--schema",
            schemaName,
            "--auto-approve",
            "--dry-run",
            "--strict",
            "--format",
            "json",
            "--no-color",
          ],
          { DATABASE_URL: "" }
        );
        expect(strictResult.exitCode).toBe(1);
        expect(parseJsonOutput(strictResult.output).error.code).toBe(
          "STRICT_MODE_ERROR"
        );
      } finally {
        try {
          await client.connect();
          await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        } finally {
          try {
            await client.end();
          } catch {
          }
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
  );

  test.skipIf(reachablePostgresUrls.length === 0)(
    "should release advisory lock after strict mode failure in postgres apply path",
    async function () {
      const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
      try {
        for (const postgresUrl of reachablePostgresUrls) {
          const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
          const tableName = `cli_strict_lock_${suffix}`;
          const lockName = `cli-strict-lock-${suffix}`;
          const seedSchemaPath = join(dir, `strict-lock-seed-${suffix}.sql`);
          const strictSchemaPath = join(dir, `strict-lock-drop-${suffix}.sql`);
          try {
            await writeFile(
              seedSchemaPath,
              `
              CREATE TABLE ${tableName} (
                id SERIAL PRIMARY KEY,
                email TEXT NOT NULL
              );
              `.trim() + "\n"
            );
            await writeFile(strictSchemaPath, "\n");

            const seedResult = await runCli(
              [
                "run",
                "src/index.ts",
                "apply",
                "-f",
                seedSchemaPath,
                "-u",
                postgresUrl,
                "--auto-approve",
                "--no-color",
              ],
              { DATABASE_URL: "" }
            );
            expect(seedResult.exitCode).toBe(0);

            const strictResult = await runCli(
              [
                "run",
                "src/index.ts",
                "apply",
                "-f",
                strictSchemaPath,
                "-u",
                postgresUrl,
                "--auto-approve",
                "--strict",
                "--lock-name",
                lockName,
                "--lock-timeout",
                "1",
                "--format",
                "json",
                "--no-color",
              ],
              { DATABASE_URL: "" }
            );

            expect(strictResult.exitCode).toBe(1);
            const strictPayload = parseJsonOutput(strictResult.output);
            expect(strictPayload.schemaVersion).toBe(2);
            expect(strictPayload.error.code).toBe("STRICT_MODE_ERROR");

            const lockProbeClient = new Client({
              connectionString: postgresUrl,
              connectionTimeoutMillis: 1500,
            });
            try {
              await lockProbeClient.connect();
              const probeResult = await lockProbeClient.query<{ acquired: boolean }>(
                "SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired",
                [lockName]
              );
              expect(probeResult.rows[0]?.acquired).toBe(true);
              await lockProbeClient.query(
                "SELECT pg_advisory_unlock(hashtext($1)::bigint)",
                [lockName]
              );
            } finally {
              await lockProbeClient.end();
            }
          } finally {
            const cleanupClient = new Client({
              connectionString: postgresUrl,
              connectionTimeoutMillis: 1500,
            });
            try {
              await cleanupClient.connect();
              await cleanupClient.query(`DROP TABLE IF EXISTS "public"."${tableName}" CASCADE`);
            } finally {
              try {
                await cleanupClient.end();
              } catch {
              }
            }
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(reachablePostgresUrls.length === 0)(
    "should release advisory lock after parser failure in postgres apply path",
    async function () {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      for (const postgresUrl of reachablePostgresUrls) {
        const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
        const tableName = `cli_parser_lock_${suffix}`;
        const lockName = `cli-parser-lock-${suffix}`;
        const validSchemaPath = join(dir, `parser-lock-valid-${suffix}.sql`);
        const invalidSchemaPath = join(dir, `parser-lock-invalid-${suffix}.sql`);
        try {
          await writeFile(
            validSchemaPath,
            `
            CREATE TABLE ${tableName} (
              id SERIAL PRIMARY KEY,
              email TEXT NOT NULL
            );
            `.trim() + "\n"
          );
          await writeFile(
            invalidSchemaPath,
            `
            CREATE TABLE ${tableName} (
              id SERIAL PRIMARY KEY,
              broken ???
            );
            `.trim() + "\n"
          );

          const parserFailure = await runCli(
            [
              "run",
              "src/index.ts",
              "apply",
              "-f",
              invalidSchemaPath,
              "-u",
              postgresUrl,
              "--auto-approve",
              "--lock-name",
              lockName,
              "--lock-timeout",
              "1",
              "--format",
              "json",
              "--no-color",
            ],
            { DATABASE_URL: "" }
          );

          expect(parserFailure.exitCode).toBe(1);
          const parserPayload = parseJsonOutput(parserFailure.output);
          expect(parserPayload.schemaVersion).toBe(2);
          expect(parserPayload.error.code).toBe("PARSER_ERROR");

          const lockProbeClient = new Client({
            connectionString: postgresUrl,
            connectionTimeoutMillis: 1500,
          });
          try {
            await lockProbeClient.connect();
            const lockResult = await lockProbeClient.query(
              "SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired",
              [lockName]
            );
            expect(lockResult.rows[0]?.acquired).toBe(true);
            await lockProbeClient.query(
              "SELECT pg_advisory_unlock(hashtext($1)::bigint)",
              [lockName]
            );
          } finally {
            try {
              await lockProbeClient.end();
            } catch {
            }
          }
        } finally {
          const cleanupClient = new Client({
            connectionString: postgresUrl,
            connectionTimeoutMillis: 1500,
          });
          try {
            await cleanupClient.connect();
            await cleanupClient.query(`DROP TABLE IF EXISTS "public"."${tableName}" CASCADE`);
          } finally {
            try {
              await cleanupClient.end();
            } catch {
            }
          }
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(reachablePostgresUrls.length === 0)(
    "should not require advisory lock in dry-run apply path",
    async function () {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      for (const postgresUrl of reachablePostgresUrls) {
        const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
        const tableName = `cli_dry_run_lock_${suffix}`;
        const lockName = `cli-dry-run-lock-${suffix}`;
        const schemaPath = join(dir, `dry-run-lock-${suffix}.sql`);

        await writeFile(
          schemaPath,
          `
          CREATE TABLE ${tableName} (
            id SERIAL PRIMARY KEY,
            email TEXT NOT NULL
          );
          `.trim() + "\n"
        );

        const lockClient = new Client({
          connectionString: postgresUrl,
          connectionTimeoutMillis: 1500,
        });

        try {
          await lockClient.connect();
          await lockClient.query(
            "SELECT pg_advisory_lock(hashtext($1)::bigint)",
            [lockName]
          );

          const dryRunResult = await runCli(
            [
              "run",
              "src/index.ts",
              "apply",
              "-f",
              schemaPath,
              "-u",
              postgresUrl,
              "--auto-approve",
              "--dry-run",
              "--lock-name",
              lockName,
              "--lock-timeout",
              "1",
              "--format",
              "json",
              "--no-color",
            ],
            { DATABASE_URL: "" }
          );

          expect(dryRunResult.exitCode).toBe(0);
          const dryRunPayload = parseJsonOutput(dryRunResult.output);
          expect(dryRunPayload.schemaVersion).toBe(2);
          expect(dryRunPayload.command).toBe("apply");
          expect(dryRunPayload.dryRun).toBe(true);
          expect(dryRunPayload.hasChanges).toBe(true);
        } finally {
          try {
            await lockClient.query(
              "SELECT pg_advisory_unlock(hashtext($1)::bigint)",
              [lockName]
            );
          } catch {
          }
          await lockClient.query(
            `DROP TABLE IF EXISTS "public"."${tableName}" CASCADE`
          );
          await lockClient.end();
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should keep exit codes stable across success and failure classes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });
      const goodSchemaPath = join(dir, "good.sql");
      const badSchemaPath = join(dir, "bad.sql");
      const dbPath = join(dbDir, "exit-matrix.sqlite");

      await writeFile(
        goodSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      await writeFile(
        badSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          broken ???
        );
        `.trim() + "\n"
      );

      const planSuccess = await runCli(
        [
          "run",
          "src/index.ts",
          "plan",
          "-f",
          goodSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(planSuccess.exitCode).toBe(0);

      const parserFailure = await runCli(
        [
          "run",
          "src/index.ts",
          "plan",
          "-f",
          badSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(parserFailure.exitCode).toBe(1);

      const validationFailure = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          goodSchemaPath,
          "-u",
          "postgres://test:test@localhost:5432/test_db",
          "--lock-timeout",
          "0",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(validationFailure.exitCode).toBe(1);

      const seedApply = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          goodSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(seedApply.exitCode).toBe(0);

      await writeFile(goodSchemaPath, "\n");
      const strictFailure = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          goodSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--strict",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(strictFailure.exitCode).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("should keep json error object shape stable across failure classes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terradb-cli-"));
    try {
      const dbDir = join(dir, "db");
      await mkdir(dbDir, { recursive: true });
      const goodSchemaPath = join(dir, "good.sql");
      const badSchemaPath = join(dir, "bad.sql");
      const dbPath = join(dbDir, "error-shape.sqlite");

      await writeFile(
        goodSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL
        );
        `.trim() + "\n"
      );

      await writeFile(
        badSchemaPath,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          broken ???
        );
        `.trim() + "\n"
      );

      const validationFailure = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          goodSchemaPath,
          "-u",
          "postgres://test:test@localhost:5432/test_db",
          "--lock-timeout",
          "0",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(validationFailure.exitCode).toBe(1);

      const parserFailure = await runCli(
        [
          "run",
          "src/index.ts",
          "plan",
          "-f",
          badSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(parserFailure.exitCode).toBe(1);

      const seedApply = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          goodSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(seedApply.exitCode).toBe(0);

      await writeFile(goodSchemaPath, "\n");
      const strictFailure = await runCli(
        [
          "run",
          "src/index.ts",
          "apply",
          "-f",
          goodSchemaPath,
          "-u",
          `sqlite:///${dbPath}`,
          "--auto-approve",
          "--strict",
          "--format",
          "json",
          "--no-color",
        ],
        { DATABASE_URL: "" }
      );
      expect(strictFailure.exitCode).toBe(1);

      for (const output of [
        validationFailure.output,
        parserFailure.output,
        strictFailure.output,
      ]) {
        const payload = parseJsonOutput(output);
        expect(Object.keys(payload)).toEqual(["schemaVersion", "error"]);
        expect(Object.keys(payload.error)).toEqual(["code", "name", "message"]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
