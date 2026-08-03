import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { SchemaService } from "../../core/schema/service";
import { SQLiteProvider } from "../../providers/sqlite";
import type { SQLiteConnectionConfig } from "../../providers/types";

type QuoteStyle = "bracket" | "double" | "backtick";

interface SQLiteGrammarCase {
  stem: string;
  payloadColumn: string;
  quoteStyle: QuoteStyle;
  strict: boolean;
  withoutRowid: boolean;
  autoincrement: boolean;
  storedGenerated: boolean;
  collation: "BINARY" | "NOCASE" | "RTRIM";
  indexOrder: "ASC" | "DESC";
  conflict: "IGNORE" | "REPLACE";
  tokenizer: "porter" | "unicode61 remove_diacritics 2";
  interleavedComment: boolean;
  reverseOptions: boolean;
}

const grammarCase = fc.record({
  stem: fc.constantFrom(
    "attach",
    "case end",
    "semi; table",
    'quote "table"',
    "café"
  ),
  payloadColumn: fc.constantFrom(
    "detach",
    "payload; drop",
    'value "text"',
    "select"
  ),
  quoteStyle: fc.constantFrom<QuoteStyle>("bracket", "double", "backtick"),
  strict: fc.boolean(),
  withoutRowid: fc.boolean(),
  autoincrement: fc.boolean(),
  storedGenerated: fc.boolean(),
  collation: fc.constantFrom("BINARY" as const, "NOCASE" as const, "RTRIM" as const),
  indexOrder: fc.constantFrom("ASC" as const, "DESC" as const),
  conflict: fc.constantFrom("IGNORE" as const, "REPLACE" as const),
  tokenizer: fc.constantFrom(
    "porter" as const,
    "unicode61 remove_diacritics 2" as const
  ),
  interleavedComment: fc.boolean(),
  reverseOptions: fc.boolean(),
});

let databaseSequence = 0;

function quoteName(value: string, style: QuoteStyle): string {
  if (style === "bracket") {
    return `[${value}]`;
  }
  if (style === "backtick") {
    return `\`${value.replace(/`/g, "``")}\``;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function renderTableOptions(testCase: SQLiteGrammarCase): string {
  const options = [
    testCase.strict ? "STRICT" : "",
    testCase.withoutRowid ? "WITHOUT ROWID" : "",
  ].filter(Boolean);
  if (testCase.reverseOptions) {
    options.reverse();
  }
  return options.length > 0 ? ` ${options.join(", ")}` : "";
}

function renderSchema(testCase: SQLiteGrammarCase): {
  sql: string;
  names: {
    table: string;
    audit: string;
    view: string;
    trigger: string;
    index: string;
    fts: string;
    id: string;
    payload: string;
    score: string;
    derived: string;
  };
} {
  const names = {
    table: `${testCase.stem} records`,
    audit: `${testCase.stem} audit`,
    view: `${testCase.stem} view`,
    trigger: `${testCase.stem} trigger`,
    index: `${testCase.stem} index`,
    fts: `${testCase.stem} search`,
    id: 'id "key"',
    payload: testCase.payloadColumn,
    score: "score; value",
    derived: "derived value",
  };
  const q = function (value: string): string {
    return quoteName(value, testCase.quoteStyle);
  };
  const createComment = testCase.interleavedComment
    ? " /* ATTACH; DROP; CASE END */"
    : "";
  const autoincrement = testCase.autoincrement && !testCase.withoutRowid
    ? " AUTOINCREMENT"
    : "";
  const generatedStorage = testCase.storedGenerated ? "STORED" : "VIRTUAL";

  return {
    names,
    sql: `
      -- DROP TABLE ignored_comment;
      CREATE${createComment} TABLE ${q(names.table)} (
        ${q(names.id)} INTEGER PRIMARY KEY${autoincrement},
        ${q(names.payload)} TEXT COLLATE ${testCase.collation}
          CONSTRAINT ${q(`${testCase.stem} payload required`)} NOT NULL ON CONFLICT FAIL
          DEFAULT 'ATTACH; quote '' value, ) (',
        ${q(names.score)} INTEGER NOT NULL DEFAULT 0
          CHECK (((${q(names.score)} >= -100) AND (abs(${q(names.score)}) <= 1000))),
        ${q(names.derived)} TEXT GENERATED ALWAYS AS (
          trim(${q(names.payload)}) || ':' || printf('%d', ${q(names.score)})
        ) ${generatedStorage},
        CONSTRAINT ${q(`${testCase.stem} unique payload`)}
          UNIQUE (${q(names.payload)}) ON CONFLICT ${testCase.conflict}
      )${renderTableOptions(testCase)};

      CREATE TABLE ${q(names.audit)} (
        entry_id INTEGER,
        message TEXT
      );

      CREATE INDEX ${q(names.index)} ON ${q(names.table)} (
        lower(${q(names.payload)}) COLLATE NOCASE ${testCase.indexOrder},
        ${q(names.score)} ASC
      ) WHERE ${q(names.score)} >= 0 AND instr(${q(names.payload)}, ')') = 0;

      CREATE VIEW ${q(names.view)} (${q("entry id")}, ${q("text value")}, ${q("computed")}) AS
        SELECT ${q(names.id)}, ${q(names.payload)}, ${q(names.derived)}
        FROM ${q(names.table)}
        WHERE ${q(names.score)} >= 0;

      CREATE TRIGGER ${q(names.trigger)}
      AFTER INSERT ON ${q(names.table)}
      BEGIN
        UPDATE ${q(names.table)}
        SET ${q(names.payload)} = trim(NEW.${q(names.payload)})
        WHERE ${q(names.id)} = NEW.${q(names.id)};
        INSERT INTO ${q(names.audit)} (entry_id, message)
        VALUES (
          NEW.${q(names.id)},
          CASE WHEN NEW.${q(names.score)} > 0 THEN 'INSERT; ATTACH' ELSE 'DROP' END
        );
      END;

      CREATE${createComment} VIRTUAL TABLE ${q(names.fts)} USING fts5(
        title,
        body,
        tokenize = '${testCase.tokenizer}'
      );
    `,
  };
}

function nextConfig(): SQLiteConnectionConfig {
  databaseSequence += 1;
  return {
    dialect: "sqlite",
    filename: `file:terradb-grammar-${Date.now()}-${databaseSequence}?mode=memory&cache=shared`,
  };
}

describe("SQLite grammar-aware properties", function () {
  test("generated supported DDL parses, applies, executes, and replans idempotently", async function () {
    const seed = Number.parseInt(process.env.FC_SEED || "20260803", 10);
    const numRuns = Number.parseInt(
      process.env.SQLITE_GRAMMAR_RUNS || "60",
      10
    );
    const replayPath = process.env.FC_PATH;

    await fc.assert(
      fc.asyncProperty(grammarCase, async function (testCase) {
        const rendered = renderSchema(testCase);
        const provider = new SQLiteProvider();
        const config = nextConfig();
        const anchor = await provider.createClient(config);
        const service = new SchemaService(provider, config);
        const q = quoteIdentifier;

        try {
          const parsed = await provider.parseSchema(rendered.sql);
          expect(parsed.tables.map(function (table) {
            return table.name;
          })).toEqual([
            rendered.names.audit,
            rendered.names.fts,
            rendered.names.table,
          ].sort());
          expect(parsed.tables.filter(function (table) {
            return table.virtual;
          }).map(function (table) {
            return table.name;
          })).toEqual([rendered.names.fts]);
          expect(parsed.views.map(function (view) {
            return view.name;
          })).toEqual([rendered.names.view]);
          expect(parsed.triggers.map(function (trigger) {
            return trigger.name;
          })).toEqual([rendered.names.trigger]);

          const applyPlan = await service.apply(rendered.sql, ["public"], true);
          expect(applyPlan.transactional.some(function (statement) {
            return /CREATE TABLE.*_(?:config|content|data|docsize|idx)/i.test(statement);
          })).toBe(false);
          const replan = await service.plan(rendered.sql);
          if (replan.hasChanges) {
            throw new Error(
              `expected generated schema to be idempotent: ${JSON.stringify(replan)}`
            );
          }

          await anchor.query(
            `INSERT INTO ${q(rendered.names.table)} (${q(rendered.names.id)}, ${q(rendered.names.payload)}, ${q(rendered.names.score)}) VALUES (?, ?, ?)`,
            [1, "  Hello  ", 7]
          );
          const row = await anchor.query<{ payload: string; derived: string }>(
            `SELECT ${q(rendered.names.payload)} AS payload, ${q(rendered.names.derived)} AS derived FROM ${q(rendered.names.table)}`
          );
          expect(row.rows).toEqual([{ payload: "Hello", derived: "Hello:7" }]);
          const audit = await anchor.query<{ message: string }>(
            `SELECT message FROM ${q(rendered.names.audit)}`
          );
          expect(audit.rows).toEqual([{ message: "INSERT; ATTACH" }]);
          const view = await anchor.query<{ computed: string }>(
            `SELECT ${q("computed")} AS computed FROM ${q(rendered.names.view)}`
          );
          expect(view.rows).toEqual([{ computed: "Hello:7" }]);

          await anchor.query(
            `INSERT INTO ${q(rendered.names.fts)} (title, body) VALUES (?, ?)`,
            ["Grammar résumé", "A searchable needle"]
          );
          const fts = await anchor.query<{ title: string }>(
            `SELECT title FROM ${q(rendered.names.fts)} WHERE ${q(rendered.names.fts)} MATCH ?`,
            ["needle"]
          );
          expect(fts.rows).toEqual([{ title: "Grammar résumé" }]);

          const queryPlan = await anchor.query<{ detail: string }>(`
            EXPLAIN QUERY PLAN
            SELECT ${q(rendered.names.id)}
            FROM ${q(rendered.names.table)}
            WHERE ${q(rendered.names.score)} >= 0
              AND instr(${q(rendered.names.payload)}, ')') = 0
              AND lower(${q(rendered.names.payload)}) COLLATE NOCASE = 'hello'
              AND ${q(rendered.names.score)} = 7
          `);
          expect(queryPlan.rows.some(function (entry) {
            return entry.detail.includes(rendered.names.index);
          })).toBe(true);
        } finally {
          await anchor.end();
        }
      }),
      {
        seed,
        numRuns,
        endOnFailure: true,
        ...(replayPath ? { path: replayPath } : {}),
      }
    );
  }, { timeout: 120000 });
});
