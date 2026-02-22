import { describe, expect, test } from "bun:test";
import { SchemaParser } from "../core/schema/parser";

type ParseTotals = {
  tables: number;
  enums: number;
  views: number;
  functions: number;
  procedures: number;
  triggers: number;
  sequences: number;
  extensions: number;
  schemas: number;
  comments: number;
};

type MatrixCase = {
  name: string;
  sql: string;
  expected: ParseTotals;
};

function totals(parsed: any): ParseTotals {
  return {
    tables: parsed.tables.length,
    enums: parsed.enums.length,
    views: parsed.views.length,
    functions: parsed.functions.length,
    procedures: parsed.procedures.length,
    triggers: parsed.triggers.length,
    sequences: parsed.sequences.length,
    extensions: parsed.extensions.length,
    schemas: parsed.schemas.length,
    comments: parsed.comments.length,
  };
}

describe("Parser object matrix parity", function () {
  test("parses each supported object family in isolation", async function () {
    const parser = new SchemaParser();
    const cases: MatrixCase[] = [
      {
        name: "schema",
        sql: "CREATE SCHEMA analytics;",
        expected: {
          tables: 0,
          enums: 0,
          views: 0,
          functions: 0,
          procedures: 0,
          triggers: 0,
          sequences: 0,
          extensions: 0,
          schemas: 1,
          comments: 0,
        },
      },
      {
        name: "extension",
        sql: "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;",
        expected: {
          tables: 0,
          enums: 0,
          views: 0,
          functions: 0,
          procedures: 0,
          triggers: 0,
          sequences: 0,
          extensions: 1,
          schemas: 0,
          comments: 0,
        },
      },
      {
        name: "enum",
        sql: "CREATE TYPE public.status_enum AS ENUM ('a', 'b');",
        expected: {
          tables: 0,
          enums: 1,
          views: 0,
          functions: 0,
          procedures: 0,
          triggers: 0,
          sequences: 0,
          extensions: 0,
          schemas: 0,
          comments: 0,
        },
      },
      {
        name: "sequence",
        sql: "CREATE SEQUENCE public.seq_status START WITH 1 INCREMENT BY 1;",
        expected: {
          tables: 0,
          enums: 0,
          views: 0,
          functions: 0,
          procedures: 0,
          triggers: 0,
          sequences: 1,
          extensions: 0,
          schemas: 0,
          comments: 0,
        },
      },
      {
        name: "table",
        sql: "CREATE TABLE public.users (id INT PRIMARY KEY, email TEXT UNIQUE);",
        expected: {
          tables: 1,
          enums: 0,
          views: 0,
          functions: 0,
          procedures: 0,
          triggers: 0,
          sequences: 0,
          extensions: 0,
          schemas: 0,
          comments: 0,
        },
      },
      {
        name: "view",
        sql: "CREATE VIEW public.v_users AS SELECT 1 AS id;",
        expected: {
          tables: 0,
          enums: 0,
          views: 1,
          functions: 0,
          procedures: 0,
          triggers: 0,
          sequences: 0,
          extensions: 0,
          schemas: 0,
          comments: 0,
        },
      },
      {
        name: "materialized-view",
        sql: "CREATE MATERIALIZED VIEW public.mv_users AS SELECT 1 AS id;",
        expected: {
          tables: 0,
          enums: 0,
          views: 1,
          functions: 0,
          procedures: 0,
          triggers: 0,
          sequences: 0,
          extensions: 0,
          schemas: 0,
          comments: 0,
        },
      },
      {
        name: "function",
        sql: "CREATE FUNCTION public.fn_one() RETURNS integer LANGUAGE SQL AS $$SELECT 1;$$;",
        expected: {
          tables: 0,
          enums: 0,
          views: 0,
          functions: 1,
          procedures: 0,
          triggers: 0,
          sequences: 0,
          extensions: 0,
          schemas: 0,
          comments: 0,
        },
      },
      {
        name: "procedure",
        sql: "CREATE PROCEDURE public.proc_one() LANGUAGE SQL AS $$SELECT 1;$$;",
        expected: {
          tables: 0,
          enums: 0,
          views: 0,
          functions: 0,
          procedures: 1,
          triggers: 0,
          sequences: 0,
          extensions: 0,
          schemas: 0,
          comments: 0,
        },
      },
      {
        name: "trigger",
        sql: "CREATE TRIGGER trg_users BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.fn_touch();",
        expected: {
          tables: 0,
          enums: 0,
          views: 0,
          functions: 0,
          procedures: 0,
          triggers: 1,
          sequences: 0,
          extensions: 0,
          schemas: 0,
          comments: 0,
        },
      },
      {
        name: "comment",
        sql: "COMMENT ON TABLE public.users IS 'users';",
        expected: {
          tables: 0,
          enums: 0,
          views: 0,
          functions: 0,
          procedures: 0,
          triggers: 0,
          sequences: 0,
          extensions: 0,
          schemas: 0,
          comments: 1,
        },
      },
    ];

    for (const item of cases) {
      const parsed = await parser.parseSchema(item.sql);
      expect(totals(parsed), item.name).toEqual(item.expected);
    }
  });

  test("keeps parseSchema and focused parsers aligned for tables indexes and views", async function () {
    const parser = new SchemaParser();
    const sql = `
      CREATE TABLE public.users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL
      );
      CREATE INDEX idx_users_email ON public.users (email);
      CREATE VIEW public.v_users AS SELECT id, email FROM public.users;
      CREATE MATERIALIZED VIEW public.mv_users AS SELECT id FROM public.users;
    `;

    const parsed = await parser.parseSchema(sql);
    const tableOnly = await parser.parseCreateTableStatements(sql);
    const indexOnly = await parser.parseCreateIndexStatements(sql);
    const viewOnly = await parser.parseCreateViewStatements(sql);

    const schemaIndexNames = parsed.tables
      .flatMap(function (table) {
        return table.indexes || [];
      })
      .map(function (index) {
        return index.name;
      })
      .sort();

    expect(parsed.tables.map(function (table) {
      return table.name;
    })).toEqual(tableOnly.map(function (table) {
      return table.name;
    }));

    expect(schemaIndexNames).toEqual(
      indexOnly
        .map(function (index) {
          return index.name;
        })
        .sort()
    );

    expect(parsed.views.map(function (view) {
      return `${view.name}:${view.materialized ? "m" : "v"}`;
    }).sort()).toEqual(
      viewOnly.map(function (view) {
        return `${view.name}:${view.materialized ? "m" : "v"}`;
      }).sort()
    );
  });
});
