import { describe, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SchemaParser } from "../../core/schema/parser";

type FuzzCase = {
  index: number;
  name: string;
  sql: string;
};

const defaultSeed = 20260222;
const defaultRandomCaseCount = 50;
const defaultRandomCaseLength = 64;

async function parseWithHandledError(parser: SchemaParser, sql: string): Promise<void> {
  try {
    await parser.parseSchema(sql);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new Error(`parser threw non-error value: ${String(error)}`);
    }
  }
}

function fixtureDir(): string {
  return join(process.cwd(), "src", "test", "fixtures", "parser-fuzz");
}

function readFixtures(): FuzzCase[] {
  const dir = fixtureDir();
  const files = readdirSync(dir)
    .filter(function (name) {
      return name.endsWith(".sql");
    })
    .sort();

  return files.map(function (name, index) {
    return {
      index,
      name,
      sql: readFileSync(join(dir, name), "utf-8"),
    };
  });
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid integer value: ${value}`);
  }

  return parsed;
}

function parseSeed(value: string | undefined): number {
  const parsed = parseOptionalInteger(value);
  if (parsed === undefined) {
    return defaultSeed;
  }
  return parsed;
}

function selectCases(cases: FuzzCase[], index: number | undefined, envName: string): FuzzCase[] {
  if (index === undefined) {
    return cases;
  }

  if (cases.length === 0) {
    throw new Error(`${envName} is set but no fuzz cases are available`);
  }

  if (index < 0 || index >= cases.length) {
    throw new Error(`${envName} must be between 0 and ${cases.length - 1}`);
  }

  return [cases[index] as FuzzCase];
}

function createXorshift32(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) {
    state = 0x9e3779b9;
  }

  return function () {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function createRandomAsciiCases(seed: number, count: number, length: number): FuzzCase[] {
  const next = createXorshift32(seed);
  const cases: FuzzCase[] = [];

  for (let i = 0; i < count; i++) {
    let sample = "";

    for (let j = 0; j < length; j++) {
      const code = 32 + (next() % 95);
      sample += String.fromCharCode(code);
    }

    cases.push({
      index: i,
      name: `random-${i}`,
      sql: sample,
    });
  }

  return cases;
}

function replayMessage(prefix: string, details: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}. replay: ${details}`;
}

describe("Parser Fuzz", () => {
  test("handles malformed corpus without crashing", async function () {
    const parser = new SchemaParser();
    const selectedCases = selectCases(
      readFixtures(),
      parseOptionalInteger(process.env.PARSER_FUZZ_FIXTURE_CASE),
      "PARSER_FUZZ_FIXTURE_CASE"
    );

    for (const fuzzCase of selectedCases) {
      try {
        await parseWithHandledError(parser, fuzzCase.sql);
      } catch (error) {
        throw new Error(
          replayMessage(
            `fixture fuzz case failed (${fuzzCase.name})`,
            `PARSER_FUZZ_FIXTURE_CASE=${fuzzCase.index} bun run test:fuzz`,
            error
          )
        );
      }
    }
  });

  test("handles deterministic random ascii input without crashing", async function () {
    const parser = new SchemaParser();
    const seed = parseSeed(process.env.PARSER_FUZZ_SEED);
    const selectedCases = selectCases(
      createRandomAsciiCases(seed, defaultRandomCaseCount, defaultRandomCaseLength),
      parseOptionalInteger(process.env.PARSER_FUZZ_RANDOM_CASE),
      "PARSER_FUZZ_RANDOM_CASE"
    );

    for (const fuzzCase of selectedCases) {
      try {
        await parseWithHandledError(parser, fuzzCase.sql);
      } catch (error) {
        throw new Error(
          replayMessage(
            `random fuzz case failed (${fuzzCase.name})`,
            `PARSER_FUZZ_SEED=${seed} PARSER_FUZZ_RANDOM_CASE=${fuzzCase.index} bun run test:fuzz`,
            error
          )
        );
      }
    }
  });
});
