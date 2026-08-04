import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "libsql";

const EXPECTED_LIBSQL_VERSION = "0.5.29";
const EXPECTED_SQLITE_VERSION = "3.45.1";

type PackageManifest = {
  version?: string;
  dependencies?: Record<string, string>;
};

function readPackageManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

describe("SQLite runtime contract", function () {
  test("pins the package and embedded SQLite feature baseline", function () {
    const projectManifest = readPackageManifest(
      fileURLToPath(new URL("../../../package.json", import.meta.url))
    );
    const require = createRequire(import.meta.url);
    const libsqlEntry = require.resolve("libsql");
    const libsqlManifest = readPackageManifest(
      join(dirname(libsqlEntry), "package.json")
    );

    expect(projectManifest.dependencies?.libsql).toBe(EXPECTED_LIBSQL_VERSION);
    expect(libsqlManifest.version).toBe(EXPECTED_LIBSQL_VERSION);

    const database = new Database(":memory:");
    try {
      const version = database
        .prepare("SELECT sqlite_version() AS version")
        .get() as { version: string };
      const compileOptions = database
        .prepare("PRAGMA compile_options")
        .all() as Array<{ compile_options: string }>;
      const optionNames = compileOptions.map(function getOption(row) {
        return row.compile_options;
      });

      expect(version.version).toBe(EXPECTED_SQLITE_VERSION);
      expect(optionNames).toContain("ENABLE_FTS5");
      expect(optionNames).toContain("ENABLE_RTREE");
    } finally {
      database.close();
    }
  });
});
