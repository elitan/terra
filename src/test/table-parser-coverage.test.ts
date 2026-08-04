import { describe, expect, test } from "bun:test";
import { parse } from "pgsql-parser";
import { parseCreateTable } from "../core/schema/parser/tables/table-parser";

describe("Table parser coverage", () => {
  test("returns null when relation or table name is missing", function () {
    expect(parseCreateTable({})).toBeNull();
    expect(parseCreateTable({ relation: {} })).toBeNull();
  });

  test("returns parsed table shape", function () {
    const parsed = parseCreateTable({
      relation: { relname: "users", schemaname: "public" },
      tableElts: [
        {
          ColumnDef: {
            colname: "id",
            typeName: { names: [{ String: { sval: "int4" } }] },
            constraints: [{ Constraint: { contype: "CONSTR_NOTNULL" } }],
          },
        },
      ],
    });

    expect(parsed).toEqual({
      name: "users",
      schema: "public",
      columns: [{ name: "id", type: "INT4", nullable: false, default: undefined, generated: undefined }],
      primaryKey: undefined,
      foreignKeys: undefined,
      checkConstraints: undefined,
      uniqueConstraints: undefined,
    });
  });

  test("parses quoted schema table and column identifiers with mixed case", async function () {
    const ast = await parse(`
      CREATE TABLE "TenantSchema"."UserAccounts" (
        "UserID" SERIAL PRIMARY KEY,
        "DisplayName" TEXT NOT NULL,
        "OrgID" INTEGER,
        CONSTRAINT "FK_User_Org" FOREIGN KEY ("OrgID")
          REFERENCES "TenantSchema"."Organizations"("OrgID"),
        CONSTRAINT "UQ_Display_Name" UNIQUE ("DisplayName")
      );
    `);

    const stmt = ast.stmts[0]?.stmt?.CreateStmt;
    const parsed = parseCreateTable(stmt);

    expect(parsed?.name).toBe("UserAccounts");
    expect(parsed?.schema).toBe("TenantSchema");
    expect(parsed?.columns.map((column) => column.name)).toEqual([
      "UserID",
      "DisplayName",
      "OrgID",
    ]);
    expect(parsed?.primaryKey?.columns).toEqual(["UserID"]);
    expect(parsed?.foreignKeys).toEqual([
      {
        name: "FK_User_Org",
        columns: ["OrgID"],
        referencedTable: "TenantSchema.Organizations",
        referencedColumns: ["OrgID"],
        onDelete: "NO ACTION",
        onUpdate: "NO ACTION",
      },
    ]);
    expect(parsed?.uniqueConstraints).toEqual([
      {
        name: "UQ_Display_Name",
        columns: ["DisplayName"],
      },
    ]);
  });

  test("parses PostgreSQL 18 generated column storage kinds", async function () {
    const ast = await parse(`
      CREATE TABLE generated_storage (
        source text,
        implicit_virtual text GENERATED ALWAYS AS (lower(source)),
        explicit_virtual text GENERATED ALWAYS AS (upper(source)) VIRTUAL,
        explicit_stored text GENERATED ALWAYS AS (source || '!') STORED
      );
    `);
    const parsed = parseCreateTable(ast.stmts[0]?.stmt?.CreateStmt);

    expect(parsed?.columns.map(function (column) {
      return {
        name: column.name,
        generated: column.generated,
      };
    })).toEqual([
      { name: "source", generated: undefined },
      {
        name: "implicit_virtual",
        generated: {
          always: true,
          expression: "lower(source)",
          stored: false,
        },
      },
      {
        name: "explicit_virtual",
        generated: {
          always: true,
          expression: "upper(source)",
          stored: false,
        },
      },
      {
        name: "explicit_stored",
        generated: {
          always: true,
          expression: "source || '!'",
          stored: true,
        },
      },
    ]);
  });

  test("parses unlogged persistence and canonical public references", async function () {
    const ast = await parse(`
      CREATE UNLOGGED TABLE public.child_records (
        id integer PRIMARY KEY,
        parent_id integer REFERENCES parent_records(id)
      );
    `);

    const parsed = parseCreateTable(ast.stmts[0]?.stmt?.CreateStmt);

    expect(parsed?.unlogged).toBe(true);
    expect(parsed?.foreignKeys?.[0]?.referencedTable).toBe("parent_records");
  });

  test("parses custom and default table tablespaces", async function () {
    const ast = await parse(`
      CREATE TABLE custom_space (id integer) TABLESPACE "Fast Space";
      CREATE TABLE default_space (id integer) TABLESPACE pg_default;
    `);

    const custom = parseCreateTable(ast.stmts[0]?.stmt?.CreateStmt);
    const defaultTable = parseCreateTable(ast.stmts[1]?.stmt?.CreateStmt);

    expect(custom?.tablespace).toBe("Fast Space");
    expect(defaultTable?.tablespace).toBeUndefined();
  });

  test("parses a table access method", async function () {
    const ast = await parse(`
      CREATE TABLE custom_heap (id integer) USING "Terra Heap";
      CREATE TABLE default_heap (id integer);
    `);

    const custom = parseCreateTable(ast.stmts[0]?.stmt?.CreateStmt);
    const defaultTable = parseCreateTable(ast.stmts[1]?.stmt?.CreateStmt);

    expect(custom?.accessMethod).toBe("Terra Heap");
    expect(defaultTable?.accessMethod).toBeUndefined();
  });

  test("parses multiple inheritance parents", async function () {
    const ast = await parse(`
      CREATE TABLE child (extra text)
      INHERITS (public.parent_one, "Tenant"."ParentTwo");
    `);
    const parsed = parseCreateTable(ast.stmts[0]?.stmt?.CreateStmt);

    expect(parsed?.inherits).toEqual([
      { name: "parent_one", schema: "public" },
      { name: "ParentTwo", schema: "Tenant" },
    ]);
  });

  test("parses exclusion constraint index and timing options", async function () {
    const ast = await parse(`
      CREATE TABLE bookings (
        id integer,
        label text,
        during int4range,
        CONSTRAINT bookings_no_overlap
          EXCLUDE USING gist (
            during WITH &&,
            (lower(label)) COLLATE "C" gist_trgm_ops
              WITH OPERATOR(custom_ops.=)
          )
          INCLUDE (id)
          WITH (fillfactor=80)
          USING INDEX TABLESPACE "Fast Indexes"
          WHERE (NOT isempty(during))
          DEFERRABLE INITIALLY DEFERRED
      );
    `);
    const parsed = parseCreateTable(ast.stmts[0]?.stmt?.CreateStmt);

    expect(parsed?.exclusionConstraints).toEqual([
      {
        name: "bookings_no_overlap",
        method: "gist",
        elements: [
          { definition: "during", operator: { name: "&&" } },
          {
            definition: '(lower(label)) COLLATE "C" gist_trgm_ops',
            operator: { name: "=", schema: "custom_ops" },
          },
        ],
        include: ["id"],
        storageParameters: { fillfactor: "80" },
        tablespace: "Fast Indexes",
        where: "NOT (isempty(during))",
        deferrable: true,
        initiallyDeferred: true,
      },
    ]);
  });

  test("keeps a unique constraint when the table has no primary key", async function () {
    const ast = await parse(`
      CREATE TABLE unique_only (email text UNIQUE NULLS NOT DISTINCT);
    `);
    const parsed = parseCreateTable(ast.stmts[0]?.stmt?.CreateStmt);

    expect(parsed?.primaryKey).toBeUndefined();
    expect(parsed?.uniqueConstraints).toEqual([
      {
        columns: ["email"],
        name: undefined,
        nullsNotDistinct: true,
      },
    ]);
  });

  test("parses table-level null uniqueness semantics", async function () {
    const ast = await parse(`
      CREATE TABLE unique_table_level (
        tenant_id integer,
        email text,
        display_name text,
        updated_at timestamp,
        CONSTRAINT unique_tenant_email
          UNIQUE NULLS NOT DISTINCT (tenant_id, email)
          INCLUDE (display_name, updated_at)
          WITH (fillfactor=75)
          USING INDEX TABLESPACE pg_default
      );
    `);
    const parsed = parseCreateTable(ast.stmts[0]?.stmt?.CreateStmt);

    expect(parsed?.uniqueConstraints).toEqual([
      {
        columns: ["tenant_id", "email"],
        name: "unique_tenant_email",
        include: ["display_name", "updated_at"],
        storageParameters: { fillfactor: "75" },
        tablespace: "pg_default",
        nullsNotDistinct: true,
      },
    ]);
  });

  test("parses primary key index and timing options", async function () {
    const ast = await parse(`
      CREATE TABLE primary_options (
        id integer,
        tenant_id integer,
        display_name text,
        CONSTRAINT primary_options_pkey
          PRIMARY KEY (tenant_id, id)
          INCLUDE (display_name)
          WITH (fillfactor=75)
          USING INDEX TABLESPACE pg_default
          DEFERRABLE INITIALLY DEFERRED
      );
    `);
    const parsed = parseCreateTable(ast.stmts[0]?.stmt?.CreateStmt);

    expect(parsed?.primaryKey).toEqual({
      name: "primary_options_pkey",
      columns: ["tenant_id", "id"],
      include: ["display_name"],
      storageParameters: { fillfactor: "75" },
      tablespace: "pg_default",
      deferrable: true,
      initiallyDeferred: true,
    });
  });

  test("normalizes unquoted mixed-case identifiers to lowercase while keeping quoted case", async function () {
    const ast = await parse(`
      CREATE TABLE MixedCaseTable (
        UserID INTEGER,
        "ExactCase" TEXT
      );
    `);

    const stmt = ast.stmts[0]?.stmt?.CreateStmt;
    const parsed = parseCreateTable(stmt);

    expect(parsed?.name).toBe("mixedcasetable");
    expect(parsed?.columns.map((column) => column.name)).toEqual([
      "userid",
      "ExactCase",
    ]);
  });

  test("returns null when parsing throws", function () {
    const stmt: any = {};
    Object.defineProperty(stmt, "relation", {
      get: function () {
        throw new Error("boom");
      },
    });

    expect(parseCreateTable(stmt)).toBeNull();
  });
});
