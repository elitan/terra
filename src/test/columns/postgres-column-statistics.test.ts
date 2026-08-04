import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Client } from "pg";
import { SchemaParser } from "../../core/schema/parser";
import {
  parseAlterPostgresStatistics,
} from "../../core/schema/parser/column-statistics-parser";
import { SchemaDiffer } from "../../core/schema/differ";
import { DatabaseInspector } from "../../core/schema/inspector";
import { ViewHandler } from "../../core/schema/handlers/view-handler";
import { ValidationError } from "../../types/errors";
import type { MigrationPlan } from "../../types/migration";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";
import { createColumnTestServices } from "./column-test-utils";

describe("PostgreSQL column statistics parser", function () {
  test("canonicalizes tables, inheritance, materialized views, and expression indexes", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE TABLE public.statistics_parent (
        id integer,
        payload text
      );
      CREATE TABLE public.statistics_child ()
        INHERITS (public.statistics_parent);
      ALTER TABLE public.statistics_parent
        ALTER COLUMN payload SET STATISTICS 250,
        ALTER COLUMN payload SET (
          n_distinct=-0.5,
          n_distinct_inherited=42
        );

      CREATE INDEX statistics_expression_idx
        ON public.statistics_parent ((length(payload)));
      ALTER INDEX public.statistics_expression_idx
        ALTER COLUMN 1 SET STATISTICS 500;

      CREATE MATERIALIZED VIEW public.statistics_summary (payload)
        AS SELECT payload FROM public.statistics_parent;
      ALTER MATERIALIZED VIEW public.statistics_summary
        ALTER COLUMN payload SET STATISTICS 300,
        ALTER COLUMN payload SET (n_distinct=0);
    `);

    expect(parsed.tables[0]?.columnStatistics).toEqual([
      {
        column: "payload",
        statisticsTarget: 250,
        nDistinct: -0.5,
        nDistinctInherited: 42,
      },
    ]);
    expect(parsed.tables[1]?.columnStatistics).toEqual([
      { column: "payload", statisticsTarget: 250 },
    ]);
    expect(parsed.tables[0]?.indexes?.[0]?.expressionStatisticsTarget).toBe(
      500
    );
    expect(parsed.views[0]?.columnStatistics).toEqual([
      { column: "payload", statisticsTarget: 300, nDistinct: 0 },
    ]);
  });

  test("normalizes every default spelling to omitted state", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE TABLE public.statistics_defaults (payload text);
      ALTER TABLE ONLY public.statistics_defaults
        ALTER payload SET STATISTICS DEFAULT,
        ALTER payload RESET (n_distinct, n_distinct_inherited);
      CREATE INDEX statistics_defaults_idx
        ON public.statistics_defaults ((length(payload)));
      ALTER INDEX public.statistics_defaults_idx
        ALTER 1 SET STATISTICS -1;
    `);

    expect(parsed.tables[0]?.columnStatistics).toBeUndefined();
    expect(
      parsed.tables[0]?.indexes?.[0]?.expressionStatisticsTarget
    ).toBeUndefined();
  });

  test("rejects invalid or ambiguous declarations before planning", async function () {
    const invalidSchemas = [
      {
        sql: `CREATE TABLE t (c text); ALTER TABLE t ALTER c SET STATISTICS 10001;`,
        message: "0 through 10000",
      },
      {
        sql: `CREATE TABLE t (c text); ALTER TABLE t ALTER c SET STATISTICS -2;`,
        message: "0 through 10000",
      },
      {
        sql: `CREATE TABLE t (c text); ALTER TABLE t ALTER c SET (n_distinct=-1.1);`,
        message: "greater than or equal to -1",
      },
      {
        sql: `CREATE TABLE t (c text); ALTER TABLE t ALTER c SET (unknown_option=1);`,
        message: "supports only n_distinct",
      },
      {
        sql: `CREATE TABLE t (c text); ALTER TABLE t ALTER c SET (n_distinct=1, n_distinct=2);`,
        message: "declared more than once",
      },
      {
        sql: `CREATE TABLE t (c text); ALTER TABLE t ALTER c SET STATISTICS 1; ALTER TABLE ONLY t ALTER c SET STATISTICS 2;`,
        message: "declared more than once",
      },
      {
        sql: `CREATE TABLE t (c text); ALTER TABLE t ALTER missing SET STATISTICS 1;`,
        message: "does not name a local or inherited column",
      },
      {
        sql: `CREATE MATERIALIZED VIEW m AS SELECT 1 AS c; ALTER MATERIALIZED VIEW m ALTER c SET STATISTICS 1;`,
        message: "explicit output-column list",
      },
      {
        sql: `CREATE TABLE t (c text); CREATE INDEX i ON t (c); ALTER INDEX i ALTER 1 SET STATISTICS 1;`,
        message: "must select an expression key",
      },
      {
        sql: `CREATE TABLE t (c text); CREATE INDEX i ON t ((length(c))); ALTER INDEX i ALTER 2 SET STATISTICS 1;`,
        message: "does not have key position 2",
      },
      {
        sql: `CREATE TABLE p (c text) PARTITION BY LIST (c); ALTER TABLE p ALTER c SET STATISTICS 1;`,
        message: "partition column statistics",
      },
      {
        sql: `CREATE TABLE t (c text); CREATE INDEX i ON t ((length(c))); ALTER INDEX i ALTER 1 SET STATISTICS DEFAULT;`,
        message: "use -1",
      },
      {
        sql: `CREATE MATERIALIZED VIEW m (c) AS SELECT 1; ALTER TABLE m ALTER c SET STATISTICS 1;`,
        message: "must use ALTER TABLE for an ordinary table",
      },
      {
        sql: `ALTER TABLE missing ALTER c SET STATISTICS 1;`,
        message: "was not found in the desired schema",
      },
      {
        sql: `ALTER INDEX missing ALTER 1 SET STATISTICS 1;`,
        message: "was not found in the desired schema",
      },
      {
        sql: `CREATE TABLE t (c text); CREATE INDEX i ON t ((length(c))); ALTER INDEX i ALTER 1 SET STATISTICS 1; ALTER INDEX i ALTER 1 SET STATISTICS 2;`,
        message: "declared more than once",
      },
      {
        sql: `CREATE TABLE t (c text); ALTER MATERIALIZED VIEW t ALTER c SET STATISTICS 1;`,
        message: "must use ALTER MATERIALIZED VIEW",
      },
      {
        sql: `CREATE VIEW v (c) AS SELECT 1; ALTER MATERIALIZED VIEW v ALTER c SET STATISTICS 1;`,
        message: "must use ALTER MATERIALIZED VIEW",
      },
      {
        sql: `ALTER MATERIALIZED VIEW missing ALTER c SET STATISTICS 1;`,
        message: "was not found in the desired schema",
      },
      {
        sql: `CREATE MATERIALIZED VIEW m (c) AS SELECT 1; ALTER MATERIALIZED VIEW m ALTER missing SET STATISTICS 1;`,
        message: "does not name an output column",
      },
      {
        sql: `CREATE MATERIALIZED VIEW m (c) AS SELECT 1; ALTER MATERIALIZED VIEW m ALTER c SET STATISTICS 1; ALTER MATERIALIZED VIEW m ALTER c SET STATISTICS 2;`,
        message: "declared more than once",
      },
    ];

    for (const invalid of invalidSchemas) {
      await expect(
        new SchemaParser().parseSchema(invalid.sql)
      ).rejects.toThrow(invalid.message);
    }
  });

  test("parses numeric AST variants and rejects malformed statistics nodes", function () {
    const relation = { relname: "statistics_ast", schemaname: "public" };
    const numericVariants = [
      { arg: { Float: { fval: "1.5" } }, expected: 1.5 },
      { arg: { A_Const: { Integer: { ival: 2 } } }, expected: 2 },
      { arg: { A_Const: { Float: { fval: "2.5" } } }, expected: 2.5 },
    ];

    for (const [index, variant] of numericVariants.entries()) {
      const changes = parseAlterPostgresStatistics({
        objtype: "OBJECT_TABLE",
        relation,
        cmds: [{
          AlterTableCmd: {
            subtype: "AT_SetOptions",
            name: `column_${index}`,
            def: {
              List: {
                items: [{
                  DefElem: {
                    defname: "n_distinct",
                    arg: variant.arg,
                  },
                }],
              },
            },
          },
        }],
      });
      expect(changes[0]?.value).toBe(variant.expected);
    }

    const invalidStatements = [
      {
        objtype: "OBJECT_VIEW",
        relation,
        cmds: [{ AlterTableCmd: { subtype: "AT_SetStatistics" } }],
        message: "supported only for ordinary tables",
      },
      {
        objtype: "OBJECT_TABLE",
        relation: {},
        cmds: [{ AlterTableCmd: { subtype: "AT_SetStatistics" } }],
        message: "missing a relation name",
      },
      {
        objtype: "OBJECT_INDEX",
        relation,
        cmds: [{ AlterTableCmd: { subtype: "AT_SetOptions" } }],
        message: "not per-column attribute options",
      },
      {
        objtype: "OBJECT_TABLE",
        relation,
        cmds: [{ AlterTableCmd: { subtype: "AT_SetStatistics" } }],
        message: "missing a column name",
      },
      {
        objtype: "OBJECT_TABLE",
        relation,
        cmds: [{
          AlterTableCmd: {
            subtype: "AT_SetOptions",
            name: "payload",
            def: { List: { items: [] } },
          },
        }],
        message: "must name n_distinct",
      },
    ];

    for (const invalid of invalidStatements) {
      expect(function parseInvalidStatisticsNode() {
        parseAlterPostgresStatistics(invalid);
      }).toThrow(invalid.message);
    }
  });

  test("orders table and concurrent expression-index settings safely", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE TABLE public.statistics_order (payload text);
      ALTER TABLE ONLY public.statistics_order
        ALTER payload SET STATISTICS 101,
        ALTER payload SET (n_distinct=-0.25);
      CREATE INDEX CONCURRENTLY statistics_order_idx
        ON public.statistics_order ((length(payload)));
      ALTER INDEX public.statistics_order_idx
        ALTER 1 SET STATISTICS 202;
    `);
    const plan = new SchemaDiffer().generateMigrationPlan(parsed.tables, []);

    expect(plan.transactional.join("\n")).toContain(
      'ALTER TABLE ONLY "public"."statistics_order" ALTER COLUMN "payload" SET STATISTICS 101, ALTER COLUMN "payload" SET (n_distinct=-0.25);'
    );
    expect(plan.concurrent.join("\n")).toContain(
      'CREATE INDEX CONCURRENTLY "statistics_order_idx"'
    );
    expect(plan.deferred).toEqual([
      'ALTER INDEX "public"."statistics_order_idx" ALTER COLUMN 1 SET STATISTICS 202;',
    ]);
  });

  test("generates canonical resets without replacing relations or indexes", function () {
    const desired = [{
      name: "statistics_reset",
      schema: "public",
      columns: [{ name: "payload", type: "TEXT", nullable: true }],
      indexes: [{
        name: "statistics_reset_idx",
        tableName: "statistics_reset",
        schema: "public",
        columns: [],
        expression: "length(payload)",
        type: "btree" as const,
        unique: false,
        concurrent: false,
      }],
    }];
    const current = [{
      ...desired[0],
      columnStatistics: [{
        column: "payload",
        statisticsTarget: 111,
        nDistinct: -0.5,
        nDistinctInherited: 9,
      }],
      indexes: [{
        ...desired[0]!.indexes[0]!,
        expressionStatisticsTarget: 222,
      }],
    }];

    const plan = new SchemaDiffer().generateMigrationPlan(desired, current);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain(
      'ALTER TABLE ONLY "public"."statistics_reset" ALTER COLUMN "payload" SET STATISTICS -1, ALTER COLUMN "payload" RESET (n_distinct, n_distinct_inherited);'
    );
    expect(sql).toContain(
      'ALTER INDEX "public"."statistics_reset_idx" ALTER COLUMN 1 SET STATISTICS -1;'
    );
    expect(sql).not.toContain("DROP INDEX");
    expect(sql).not.toContain("CREATE INDEX");
  });

  test("reports concurrent materialized-view indexes as structured validation errors", function () {
    const view = {
      name: "statistics_concurrent_view",
      schema: "public",
      definition: "SELECT 1 AS payload",
      materialized: true,
      columnNames: ["payload"],
      indexes: [{
        name: "statistics_concurrent_view_idx",
        tableName: "statistics_concurrent_view",
        schema: "public",
        columns: ["payload"],
        type: "btree" as const,
        unique: false,
        concurrent: true,
      }],
    };

    try {
      new ViewHandler().generateStatements([view], []);
      throw new Error("expected materialized-view index validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe("concurrent");
      expect((error as ValidationError).value).toBe(true);
    }
  });
});

describe("PostgreSQL column statistics lifecycle", function () {
  let client: Client;
  const inspector = new DatabaseInspector();

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  test("creates, inspects, changes, resets, and converges without replacing objects", async function () {
    const initialSchema = `
      CREATE TABLE public.statistics_lifecycle (
        id integer PRIMARY KEY,
        payload text,
        generated_length integer GENERATED ALWAYS AS (length(payload)) STORED
      );
      ALTER TABLE ONLY public.statistics_lifecycle
        ALTER payload SET STATISTICS 250,
        ALTER payload SET (
          n_distinct=-0.5,
          n_distinct_inherited=42
        ),
        ALTER generated_length SET STATISTICS 125;
      CREATE INDEX statistics_lifecycle_expr_idx
        ON public.statistics_lifecycle ((length(payload)));
      ALTER INDEX public.statistics_lifecycle_expr_idx
        ALTER 1 SET STATISTICS 500;
      CREATE MATERIALIZED VIEW public.statistics_lifecycle_mv (payload)
        AS SELECT payload FROM public.statistics_lifecycle;
      ALTER MATERIALIZED VIEW public.statistics_lifecycle_mv
        ALTER payload SET STATISTICS 300,
        ALTER payload SET (n_distinct=0, n_distinct_inherited=-1);
      CREATE INDEX statistics_lifecycle_mv_expr_idx
        ON public.statistics_lifecycle_mv ((length(payload)));
      ALTER INDEX public.statistics_lifecycle_mv_expr_idx
        ALTER 1 SET STATISTICS 600;
    `;
    const changedSchema = initialSchema
      .replace("SET STATISTICS 250", "SET STATISTICS 251")
      .replace("n_distinct=-0.5", "n_distinct=-0.25")
      .replace("SET STATISTICS 500", "SET STATISTICS 501")
      .replace("SET STATISTICS 300", "SET STATISTICS 301")
      .replace("SET STATISTICS 600", "SET STATISTICS 601");
    const resetSchema = `
      CREATE TABLE public.statistics_lifecycle (
        id integer PRIMARY KEY,
        payload text,
        generated_length integer GENERATED ALWAYS AS (length(payload)) STORED
      );
      CREATE INDEX statistics_lifecycle_expr_idx
        ON public.statistics_lifecycle ((length(payload)));
      CREATE MATERIALIZED VIEW public.statistics_lifecycle_mv (payload)
        AS SELECT payload FROM public.statistics_lifecycle;
      CREATE INDEX statistics_lifecycle_mv_expr_idx
        ON public.statistics_lifecycle_mv ((length(payload)));
    `;
    const service = createTestSchemaService();

    expect((await service.apply(initialSchema, ["public"], true)).hasChanges)
      .toBe(true);
    expect((await service.apply(initialSchema, ["public"], true)).hasChanges)
      .toBe(false);
    await client.query(
      "INSERT INTO public.statistics_lifecycle VALUES (1, 'preserved')"
    );
    const beforeOids = (
      await client.query(`
        SELECT relname, oid::integer
        FROM pg_class
        WHERE relname IN (
          'statistics_lifecycle',
          'statistics_lifecycle_expr_idx',
          'statistics_lifecycle_mv',
          'statistics_lifecycle_mv_expr_idx'
        )
        ORDER BY relname
      `)
    ).rows;

    expect((await service.apply(changedSchema, ["public"], true)).hasChanges)
      .toBe(true);
    expect((await service.apply(changedSchema, ["public"], true)).hasChanges)
      .toBe(false);
    const changedTables = await inspector.getCurrentSchema(client);
    const changedTable = changedTables.find(function findTable(table) {
      return table.name === "statistics_lifecycle";
    });
    expect(changedTable?.columnStatistics).toEqual([
      { column: "generated_length", statisticsTarget: 125 },
      {
        column: "payload",
        statisticsTarget: 251,
        nDistinct: -0.25,
        nDistinctInherited: 42,
      },
    ]);
    expect(
      changedTable?.indexes?.find(function findIndex(index) {
        return index.name === "statistics_lifecycle_expr_idx";
      })?.expressionStatisticsTarget
    ).toBe(501);
    const changedViews = await inspector.getCurrentViews(client);
    const changedView = changedViews.find(function findView(view) {
        return view.name === "statistics_lifecycle_mv";
      });
    expect(changedView?.columnStatistics).toEqual([
      {
        column: "payload",
        statisticsTarget: 301,
        nDistinct: 0,
        nDistinctInherited: -1,
      },
    ]);
    expect(
      changedView?.indexes?.find(function findIndex(index) {
        return index.name === "statistics_lifecycle_mv_expr_idx";
      })?.expressionStatisticsTarget
    ).toBe(601);

    const resetPlan = await service.plan(resetSchema, ["public"]);
    expect(resetPlan.transactional.join("\n")).toContain("SET STATISTICS -1");
    expect(resetPlan.transactional.join("\n")).toContain(
      "RESET (n_distinct, n_distinct_inherited)"
    );
    expect((await service.apply(resetSchema, ["public"], true)).hasChanges)
      .toBe(true);
    expect((await service.apply(resetSchema, ["public"], true)).hasChanges)
      .toBe(false);

    const resetTables = await inspector.getCurrentSchema(client);
    const resetTable = resetTables.find(function findTable(table) {
      return table.name === "statistics_lifecycle";
    });
    expect(resetTable?.columnStatistics).toBeUndefined();
    expect(
      resetTable?.indexes?.find(function findIndex(index) {
        return index.name === "statistics_lifecycle_expr_idx";
      })?.expressionStatisticsTarget
    ).toBeUndefined();
    const resetView = (await inspector.getCurrentViews(client)).find(
      function findView(view) {
        return view.name === "statistics_lifecycle_mv";
      }
    );
    expect(resetView?.columnStatistics).toBeUndefined();
    expect(
      resetView?.indexes?.find(function findIndex(index) {
        return index.name === "statistics_lifecycle_mv_expr_idx";
      })?.expressionStatisticsTarget
    ).toBeUndefined();
    expect(
      (await client.query("SELECT id, payload FROM statistics_lifecycle"))
        .rows
    ).toEqual([{ id: 1, payload: "preserved" }]);
    expect(
      (
        await client.query(`
          SELECT relname, oid::integer
          FROM pg_class
          WHERE relname IN (
            'statistics_lifecycle',
            'statistics_lifecycle_expr_idx',
            'statistics_lifecycle_mv',
            'statistics_lifecycle_mv_expr_idx'
          )
          ORDER BY relname
        `)
      ).rows
    ).toEqual(beforeOids);
  });

  test("preserves PostgreSQL inheritance propagation and attribute-option locality", async function () {
    const inheritedSchema = `
      CREATE TABLE public.statistics_parent (payload text);
      CREATE TABLE public.statistics_child ()
        INHERITS (public.statistics_parent);
      ALTER TABLE public.statistics_parent
        ALTER payload SET STATISTICS 321,
        ALTER payload SET (
          n_distinct=-0.5,
          n_distinct_inherited=42
        );
    `;
    const onlyParentSchema = `
      CREATE TABLE public.statistics_parent (payload text);
      CREATE TABLE public.statistics_child ()
        INHERITS (public.statistics_parent);
      ALTER TABLE ONLY public.statistics_parent
        ALTER payload SET STATISTICS 654,
        ALTER payload SET (n_distinct=-0.25);
    `;
    const service = createTestSchemaService();

    await service.apply(inheritedSchema, ["public"], true);
    const inherited = await inspector.getCurrentSchema(client);
    expect(
      inherited.find(function findParent(table) {
        return table.name === "statistics_parent";
      })?.columnStatistics
    ).toEqual([
      {
        column: "payload",
        statisticsTarget: 321,
        nDistinct: -0.5,
        nDistinctInherited: 42,
      },
    ]);
    expect(
      inherited.find(function findChild(table) {
        return table.name === "statistics_child";
      })?.columnStatistics
    ).toEqual([{ column: "payload", statisticsTarget: 321 }]);

    const plan = await service.plan(onlyParentSchema, ["public"]);
    expect(plan.transactional.join("\n")).toContain(
      'ALTER TABLE ONLY "public"."statistics_child" ALTER COLUMN "payload" SET STATISTICS -1;'
    );
    await service.apply(onlyParentSchema, ["public"], true);
    expect((await service.plan(onlyParentSchema, ["public"])).hasChanges)
      .toBe(false);
    const localized = await inspector.getCurrentSchema(client);
    expect(
      localized.find(function findParent(table) {
        return table.name === "statistics_parent";
      })?.columnStatistics
    ).toEqual([
      { column: "payload", statisticsTarget: 654, nDistinct: -0.25 },
    ]);
    expect(
      localized.find(function findChild(table) {
        return table.name === "statistics_child";
      })?.columnStatistics
    ).toBeUndefined();
  });

  test("converges with externally created quoted statistics state", async function () {
    await client.query(`
      CREATE TABLE public."Statistics External" (
        "Mixed Column" text
      );
      ALTER TABLE public."Statistics External"
        ALTER COLUMN "Mixed Column" SET STATISTICS 777,
        ALTER COLUMN "Mixed Column" SET (
          n_distinct=-1,
          n_distinct_inherited=0
        );
      CREATE INDEX "Statistics External Expr"
        ON public."Statistics External" ((length("Mixed Column")));
      ALTER INDEX public."Statistics External Expr"
        ALTER COLUMN 1 SET STATISTICS 778;
      CREATE MATERIALIZED VIEW public."Statistics External MV" ("Output")
        AS SELECT "Mixed Column" FROM public."Statistics External";
      ALTER MATERIALIZED VIEW public."Statistics External MV"
        ALTER COLUMN "Output" SET STATISTICS 779;
    `);
    const desired = `
      CREATE TABLE public."Statistics External" (
        "Mixed Column" text
      );
      ALTER TABLE ONLY public."Statistics External"
        ALTER COLUMN "Mixed Column" SET STATISTICS 777,
        ALTER COLUMN "Mixed Column" SET (
          n_distinct=-1,
          n_distinct_inherited=0
        );
      CREATE INDEX "Statistics External Expr"
        ON public."Statistics External" ((length("Mixed Column")));
      ALTER INDEX public."Statistics External Expr"
        ALTER COLUMN 1 SET STATISTICS 778;
      CREATE MATERIALIZED VIEW public."Statistics External MV" ("Output")
        AS SELECT "Mixed Column" FROM public."Statistics External";
      ALTER MATERIALIZED VIEW public."Statistics External MV"
        ALTER COLUMN "Output" SET STATISTICS 779;
    `;

    expect((await createTestSchemaService().plan(desired, ["public"]))
      .hasChanges).toBe(false);
  });

  test("preserves settings through table type changes and materialized-view column renames", async function () {
    const initialSchema = `
      CREATE TABLE public.statistics_type_preserve (payload text);
      ALTER TABLE ONLY public.statistics_type_preserve
        ALTER payload SET STATISTICS 410,
        ALTER payload SET (n_distinct=-0.5);
      CREATE TABLE public.statistics_view_source (payload text);
      CREATE MATERIALIZED VIEW public.statistics_rename_mv ("Old Name")
        AS SELECT payload FROM public.statistics_view_source;
      ALTER MATERIALIZED VIEW public.statistics_rename_mv
        ALTER "Old Name" SET STATISTICS 420,
        ALTER "Old Name" SET (n_distinct_inherited=7);
    `;
    const changedSchema = `
      CREATE TABLE public.statistics_type_preserve (payload varchar(100));
      ALTER TABLE ONLY public.statistics_type_preserve
        ALTER payload SET STATISTICS 410,
        ALTER payload SET (n_distinct=-0.5);
      CREATE TABLE public.statistics_view_source (payload text);
      CREATE MATERIALIZED VIEW public.statistics_rename_mv ("New Name")
        AS SELECT payload FROM public.statistics_view_source;
      ALTER MATERIALIZED VIEW public.statistics_rename_mv
        ALTER "New Name" SET STATISTICS 420,
        ALTER "New Name" SET (n_distinct_inherited=7);
    `;
    const service = createTestSchemaService();

    await service.apply(initialSchema, ["public"], true);
    const plan = await service.plan(changedSchema, ["public"]);
    expect(plan.transactional.join("\n")).toContain(
      'ALTER COLUMN "payload" TYPE VARCHAR(100)'
    );
    expect(plan.transactional.join("\n")).toContain(
      'RENAME COLUMN "Old Name"'
    );
    expect(plan.transactional.join("\n")).not.toContain("SET STATISTICS");
    expect(plan.transactional.join("\n")).not.toContain("RESET (n_distinct");
    await service.apply(changedSchema, ["public"], true);
    expect((await service.plan(changedSchema, ["public"])).hasChanges)
      .toBe(false);

    const table = (await inspector.getCurrentSchema(client)).find(
      function findTable(candidate) {
        return candidate.name === "statistics_type_preserve";
      }
    );
    expect(table?.columnStatistics).toEqual([
      { column: "payload", statisticsTarget: 410, nDistinct: -0.5 },
    ]);
    const view = (await inspector.getCurrentViews(client)).find(
      function findView(candidate) {
        return candidate.name === "statistics_rename_mv";
      }
    );
    expect(view?.columnStatistics).toEqual([
      {
        column: "New Name",
        statisticsTarget: 420,
        nDistinctInherited: 7,
      },
    ]);
  });

  test("rolls back statistics changes when a later transactional statement fails", async function () {
    await client.query(`
      CREATE TABLE public.statistics_rollback (payload text);
      INSERT INTO public.statistics_rollback VALUES (NULL);
    `);
    const plan: MigrationPlan = {
      transactional: [
        'ALTER TABLE ONLY "public"."statistics_rollback" ALTER COLUMN "payload" SET STATISTICS 999;',
        'ALTER TABLE "public"."statistics_rollback" ALTER COLUMN "payload" SET NOT NULL;',
      ],
      concurrent: [],
      deferred: [],
      hasChanges: true,
    };

    await expect(
      createColumnTestServices().executor.executePlan(client, plan, true)
    ).rejects.toThrow();
    const target = await client.query(`
      SELECT attstattarget
      FROM pg_attribute
      WHERE attrelid = 'public.statistics_rollback'::regclass
        AND attname = 'payload'
    `);
    const value = target.rows[0]?.attstattarget;
    expect(value === null || Number(value) < 0).toBe(true);
  });

  test("rejects unsupported partition statistics catalog state", async function () {
    await client.query(`
      CREATE TABLE public.statistics_partitioned (payload integer)
        PARTITION BY RANGE (payload);
      CREATE TABLE public.statistics_partition
        PARTITION OF public.statistics_partitioned
        FOR VALUES FROM (0) TO (10);
      ALTER TABLE ONLY public.statistics_partitioned
        ALTER payload SET STATISTICS 444;
    `);

    await expect(
      new DatabaseInspector().getCurrentSqlObjects(client, ["public"])
    ).rejects.toThrow("statistics target or attribute options");
  });

  test("inspects statistics targets on mixed expression indexes", async function () {
    await client.query(`
      CREATE TABLE public.statistics_mixed_index (payload text);
      CREATE INDEX statistics_mixed_index_idx
        ON public.statistics_mixed_index (payload, (length(payload)));
      ALTER INDEX public.statistics_mixed_index_idx
        ALTER COLUMN 2 SET STATISTICS 555;
    `);

    const tables = await inspector.getCurrentSchema(client, ["public"]);
    expect(tables[0]?.indexes?.[0]?.terms?.[1]).toEqual(
      expect.objectContaining({
        expression: "length(payload)",
        statisticsTarget: 555,
      })
    );
  });
});
