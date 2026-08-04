import { describe, expect, test } from "bun:test";
import { DatabaseInspector } from "../core/schema/inspector";

function createClient(handler: (sql: string, params?: unknown[]) => { rows: unknown[] }): any {
  return {
    query: async (sql: string, params?: unknown[]) => handler(sql, params),
  };
}

describe("DatabaseInspector coverage", () => {
  test("rejects inconsistent index-key catalog metadata", function () {
    const inspector = new DatabaseInspector() as any;
    const baseRow = {
      table_schema: "public",
      index_name: "search_idx",
      index_key_count: 2,
      key_opclasses: [
        { name: "text_ops", schema: "pg_catalog", default: true },
        { name: "text_ops", schema: "pg_catalog", default: true },
      ],
      key_statistics_targets: [undefined, 100],
      expression_positions: [2],
    };
    const createTerms = function () {
      return [{ column: "title" }, { expression: "lower(body)" }];
    };

    const scenarios = [
      {
        terms: [{ column: "title" }],
        row: baseRow,
        message: "catalog reports 2",
      },
      {
        terms: createTerms(),
        row: { ...baseRow, key_opclasses: [baseRow.key_opclasses[0]] },
        message: "incomplete operator-class metadata",
      },
      {
        terms: createTerms(),
        row: {
          ...baseRow,
          key_opclasses: [baseRow.key_opclasses[0], { name: undefined }],
        },
        message: "invalid operator class",
      },
      {
        terms: createTerms(),
        row: { ...baseRow, key_statistics_targets: [undefined] },
        message: "incomplete statistics metadata",
      },
      {
        terms: createTerms(),
        row: { ...baseRow, expression_positions: [1] },
        message: "do not match its catalog",
      },
      {
        terms: createTerms(),
        row: {
          ...baseRow,
          key_statistics_targets: [100, undefined],
        },
        message: "does not belong to an expression key",
      },
    ];

    for (const scenario of scenarios) {
      expect(function enrichTerms() {
        inspector.enrichIndexTermsFromCatalog(scenario.terms, scenario.row);
      }).toThrow(scenario.message);
    }
  });

  test("covers index type mapping", () => {
    const inspector = new DatabaseInspector() as any;
    expect(inspector.mapPostgreSQLIndexType("gist")).toBe("gist");
    expect(inspector.mapPostgreSQLIndexType("spgist")).toBe("spgist");
    expect(inspector.mapPostgreSQLIndexType("brin")).toBe("brin");
    expect(inspector.mapPostgreSQLIndexType("CUSTOM_TYPE")).toBe("custom_type");
  });

  test("parses check expressions and catalog metadata", function () {
    const inspector = new DatabaseInspector() as any;
    expect(
      inspector.parseCheckConstraintRows([
        {
          constraint_name: "positive_amount",
          expression: "amount > 0",
          no_inherit: true,
          validated: false,
        },
        { constraint_name: "missing_expression", expression: null },
      ])
    ).toEqual([
      {
        name: "positive_amount",
        expression: "amount > 0",
        noInherit: true,
        notValid: true,
      },
    ]);
  });

  test("rejects unmodeled PostgreSQL constraint catalog metadata", async function () {
    const inspector = new DatabaseInspector();
    const scenarios = [
      {
        constraint: {
          constraintName: "unenforced_check",
          constraintType: "c",
          enforced: false,
          period: false,
          validated: false,
          noInherit: false,
        },
        feature: "NOT ENFORCED",
      },
      {
        constraint: {
          constraintName: "temporal_unique",
          constraintType: "u",
          enforced: true,
          period: true,
          validated: true,
          noInherit: false,
        },
        feature: "WITHOUT OVERLAPS or PERIOD",
      },
      {
        constraint: {
          constraintName: "advanced_not_null",
          constraintType: "n",
          enforced: true,
          period: false,
          validated: false,
          noInherit: true,
        },
        feature: "NOT NULL NO INHERIT or NOT VALID",
      },
    ] as const;

    for (const scenario of scenarios) {
      const client = createClient(function handleQuery(sql, params) {
        expect(sql).toContain("conenforced");
        expect(sql).toContain("conperiod");
        expect(sql).toContain("constraint_catalog.contype = 'n'");
        expect(
          sql.match(
            /\(to_jsonb\(constraint_catalog\) ->> 'conenforced'\)::boolean,\s+true/g
          )
        ).toHaveLength(2);
        expect(sql).toContain(") unsupported_constraint ON true");
        expect(params).toEqual([["public"]]);
        return {
          rows: [
            {
              table_name: "catalog_state",
              table_schema: "public",
              unsupported_constraints: [scenario.constraint],
            },
          ],
        };
      });

      await expect(
        inspector.getCurrentSchema(client, ["public"])
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining(scenario.feature),
      });
    }
  });

  test("rejects unlogged partition hierarchy catalog state", async function () {
    const scenarios = [
      { parentPersistence: "u", childPersistence: undefined, name: "parent" },
      { parentPersistence: undefined, childPersistence: "u", name: "child" },
    ] as const;

    for (const scenario of scenarios) {
      const inspector = new DatabaseInspector() as any;
      const client = createClient(function handleQuery(sql, params) {
        expect(sql).toContain("c.relpersistence as relation_persistence");
        expect(params).toEqual([["public"]]);
        if (sql.includes("pg_get_partkeydef")) {
          return {
            rows: scenario.parentPersistence
              ? [{
                  table_name: "unlogged_parent",
                  schema_name: "audit",
                  relation_persistence: scenario.parentPersistence,
                }]
              : [],
          };
        }
        if (sql.includes("c.relispartition")) {
          return {
            rows: [{
              table_name: "unlogged_child",
              schema_name: "audit",
              relation_persistence: scenario.childPersistence,
            }],
          };
        }
        throw new Error(`Unhandled SQL: ${sql}`);
      });

      await expect(
        inspector.getCurrentPartitionObjects(client, ["public"])
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining(`audit.unlogged_${scenario.name}`),
      });
    }
  });

  test("rejects lossy partition catalog features", async function () {
    const scenarios = [
      { relation_kind: "p", is_partition: true, feature: "subpartitioning" },
      {
        relation_kind: "f",
        is_partition: true,
        feature: "foreign-table partition",
      },
      { relation_options: ["fillfactor=70"], feature: "storage parameters" },
      { relation_tablespace: "fast_tables", feature: "tablespace" },
      { relation_access_method: "custom_heap", feature: "access method" },
      {
        unsupported_partition_features: ["column payload STORAGE or COMPRESSION"],
        feature: "column payload STORAGE or COMPRESSION",
      },
    ] as const;

    for (const scenario of scenarios) {
      const inspector = new DatabaseInspector() as any;
      const client = createClient(function handleQuery(sql) {
        if (!sql.includes("pg_get_partkeydef")) {
          throw new Error(`Unhandled SQL: ${sql}`);
        }
        return {
          rows: [{
            table_name: "advanced_parent",
            schema_name: "audit",
            ...scenario,
          }],
        };
      });

      await expect(
        inspector.getCurrentPartitionObjects(client, ["audit"])
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining(scenario.feature),
      });
    }
  });

  test("maps unlogged table persistence", async function () {
    const inspector = new DatabaseInspector() as any;
    inspector.getPrimaryKeyConstraint = async function () { return undefined; };
    inspector.getForeignKeyConstraints = async function () { return []; };
    inspector.getCheckConstraints = async function () { return []; };
    inspector.getInheritedCheckConstraints = async function () {
      return [{ name: "parent_check", expression: "id > 0" }];
    };
    inspector.getUniqueConstraints = async function () { return []; };
    inspector.getExclusionConstraints = async function () { return []; };
    inspector.getTableIndexes = async function () { return []; };
    const client = createClient((sql) => {
      if (sql.includes("FROM information_schema.tables")) {
        expect(sql).toContain("inheritance ON true");
        return {
          rows: [
            {
              table_name: "event_buffer",
              table_schema: "public",
              relpersistence: "u",
              table_access_method: "custom_heap",
              table_tablespace_name: "fast_tables",
              inheritance_parents: [
                { name: "events", schema: "public" },
              ],
            },
          ],
        };
      }
      if (sql.includes("FROM pg_attribute")) {
        return {
          rows: [
            {
              column_name: "payload",
              pg_type: "text",
              is_nullable: true,
              column_default: null,
              attgenerated: "",
              attidentity: "",
              column_default_storage: "x",
              column_storage: null,
              column_compression: "",
              inheritance_count: 1,
            },
          ],
        };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const tables = await inspector.getCurrentSchema(client, ["public"]);

    expect(tables[0]?.unlogged).toBe(true);
    expect(tables[0]?.accessMethod).toBe("custom_heap");
    expect(tables[0]?.tablespace).toBe("fast_tables");
    expect(tables[0]?.inherits).toEqual([
      { name: "events", schema: "public" },
    ]);
    expect(tables[0]?.columns).toEqual([]);
    expect(tables[0]?.inheritedColumns?.[0]?.name).toBe("payload");
    expect(tables[0]?.inheritedCheckConstraints?.[0]?.name).toBe(
      "parent_check"
    );
  });

  test("parses views and materialized view indexes", async () => {
    const inspector = new DatabaseInspector();
    const client = createClient((sql, params) => {
      if (sql.includes("FROM information_schema.views")) {
        expect(params).toEqual([["public", "tenant_a"]]);
        return {
          rows: [
            {
              view_name: "v_users",
              schema_name: "public",
              view_definition: " SELECT id FROM users ",
              column_names: ["id"],
              check_option: "LOCAL",
              reloptions: [
                "security_barrier=true",
                "security_invoker=true",
              ],
              is_updatable: "YES",
              is_insertable_into: "YES",
            },
            {
              view_name: "v_orders",
              schema_name: "tenant_a",
              view_definition: " SELECT id FROM orders ",
              column_names: ["id"],
              check_option: "NONE",
              reloptions: null,
              is_updatable: "YES",
              is_insertable_into: "NO",
            },
          ],
        };
      }

      if (sql.includes("FROM pg_matviews")) {
        expect(params).toEqual([["public", "tenant_a"]]);
        return {
          rows: [
            {
              view_name: "mv_users",
              schema_name: "public",
              definition: " SELECT id FROM users ",
              ispopulated: true,
              column_names: ["id"],
              access_method: "custom_heap",
              table_storage_options: ["fillfactor=72", "autovacuum_enabled=false"],
              toast_storage_options: ["autovacuum_enabled=false"],
              tablespace_name: "fast_tables",
            },
            {
              view_name: "mv_orders",
              schema_name: "tenant_a",
              definition: " SELECT id FROM orders ",
              ispopulated: false,
              column_names: ["id"],
              access_method: "heap",
              table_storage_options: null,
              toast_storage_options: null,
              tablespace_name: null,
            },
          ],
        };
      }

      if (sql.includes("attribute.attstattarget as column_statistics_target")) {
        if (params?.[0] === "mv_users" && params?.[1] === "public") {
          return {
            rows: [{
              column_name: "id",
              column_statistics_target: 350,
              column_attribute_options: [
                "n_distinct=-0.5",
                "n_distinct_inherited=12",
              ],
            }],
          };
        }
        if (params?.[0] === "mv_orders" && params?.[1] === "tenant_a") {
          return {
            rows: [{
              column_name: "id",
              column_statistics_target: null,
              column_attribute_options: null,
            }],
          };
        }
        throw new Error(
          `Unexpected column statistics params: ${JSON.stringify(params)}`
        );
      }

      if (sql.includes("FROM pg_indexes")) {
        if (params?.[0] === "mv_users" && params?.[1] === "public") {
          return {
            rows: [{
              index_name: "mv_users_idx",
              table_name: "mv_users",
              table_schema: "public",
              index_definition:
                'CREATE UNIQUE INDEX mv_users_idx ON public.mv_users USING btree (id DESC NULLS LAST) INCLUDE (label) WITH (fillfactor=75)',
              is_unique: true,
              nulls_not_distinct: false,
              access_method: "btree",
              index_key_count: 1,
              has_expressions: false,
              tablespace_name: null,
              storage_options: ["fillfactor=75"],
              expression_def: null,
              column_names: ["id"],
              included_columns: ["label"],
              opclass_names: [null],
              expression_opclass_name: null,
              where_clause: null,
              sort_options: [1],
              key_statistics_targets: [null],
              expression_positions: [],
              key_opclasses: [
                { name: "int4_ops", schema: "pg_catalog", default: true },
              ],
            }],
          };
        }
        if (params?.[0] === "mv_orders" && params?.[1] === "tenant_a") {
          return {
            rows: [{
              index_name: "mv_orders_idx",
              table_name: "mv_orders",
              table_schema: "tenant_a",
              index_definition:
                'CREATE INDEX mv_orders_idx ON tenant_a.mv_orders USING btree ((lower(label)) COLLATE "C") WHERE active',
              is_unique: false,
              nulls_not_distinct: false,
              access_method: "btree",
              index_key_count: 1,
              has_expressions: true,
              tablespace_name: null,
              storage_options: null,
              expression_def: "lower(label)",
              column_names: [],
              included_columns: [],
              opclass_names: [],
              expression_opclass_name: null,
              where_clause: "active",
              sort_options: [0],
              key_statistics_targets: [601],
              expression_positions: [1],
              key_opclasses: [
                { name: "text_ops", schema: "pg_catalog", default: true },
              ],
            }],
          };
        }
        throw new Error(`Unexpected pg_indexes params: ${JSON.stringify(params)}`);
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const views = await inspector.getCurrentViews(client, ["public", "tenant_a"]);
    expect(views).toEqual([
      {
        name: "v_users",
        schema: "public",
        definition: "SELECT id FROM users",
        materialized: false,
        columnNames: ["id"],
        checkOption: "LOCAL",
        securityBarrier: true,
        securityInvoker: true,
      },
      {
        name: "v_orders",
        schema: "tenant_a",
        definition: "SELECT id FROM orders",
        materialized: false,
        columnNames: ["id"],
      },
      {
        name: "mv_users",
        schema: "public",
        definition: "SELECT id FROM users",
        materialized: true,
        columnNames: ["id"],
        populated: true,
        storageParameters: {
          fillfactor: "72",
          autovacuum_enabled: "false",
          "toast.autovacuum_enabled": "false",
        },
        accessMethod: "custom_heap",
        tablespace: "fast_tables",
        columnStatistics: [
          {
            column: "id",
            statisticsTarget: 350,
            nDistinct: -0.5,
            nDistinctInherited: 12,
          },
        ],
        indexes: [
          {
            name: "mv_users_idx",
            tableName: "mv_users",
            schema: "public",
            columns: ["id"],
            include: ["label"],
            sortOrders: ["DESC"],
            nullsOrders: ["LAST"],
            type: "btree",
            unique: true,
            concurrent: false,
            storageParameters: { fillfactor: "75" },
            terms: [
              {
                column: "id",
                opclass: {
                  name: "int4_ops",
                  schema: "pg_catalog",
                },
                opclassDefault: true,
                order: "DESC",
                nullsOrder: "LAST",
              },
            ],
          },
        ],
      },
      {
        name: "mv_orders",
        schema: "tenant_a",
        definition: "SELECT id FROM orders",
        materialized: true,
        columnNames: ["id"],
        populated: false,
        accessMethod: "heap",
        indexes: [
          {
            name: "mv_orders_idx",
            tableName: "mv_orders",
            schema: "tenant_a",
            columns: [],
            collations: [{ name: "C" }],
            type: "btree",
            unique: false,
            concurrent: false,
            where: "active",
            expression: "lower(label)",
            expressionStatisticsTarget: 601,
            terms: [
              {
                expression: "lower(label)",
                collation: { name: "C" },
                opclass: {
                  name: "text_ops",
                  schema: "pg_catalog",
                },
                opclassDefault: true,
                order: "ASC",
                nullsOrder: "LAST",
                statisticsTarget: 601,
              },
            ],
          },
        ],
      },
    ]);
  });

  test("parses procedures and comments mapping", async () => {
    const inspector = new DatabaseInspector();
    const client = createClient((sql) => {
      if (sql.includes("FROM pg_proc p") && sql.includes("p.prokind = 'p'")) {
        return {
          rows: [
            {
              procedure_name: "refresh_cache",
              schema_name: "public",
              arguments: "IN p_id integer",
              language: "plpgsql",
              source_code: "BEGIN NULL; END",
              security_definer: false,
            },
          ],
        };
      }

      if (sql.includes("FROM pg_class c") && sql.includes("UNION ALL")) {
        expect(sql).toContain("d.classoid = 'pg_class'::regclass");
        expect(sql).toContain("d.classoid = 'pg_type'::regclass");
        expect(sql).toContain("d.classoid = 'pg_namespace'::regclass");
        expect(sql).toContain("c.relkind IN ('r', 'p', 'v', 'm', 'i', 'S')");
        expect(sql).toContain("c.relkind IN ('r', 'p', 'v', 'm', 'c')");
        expect(sql).toContain("t.typtype IN ('e', 'd', 'r', 'm')");
        return {
          rows: [
            {
              object_type: "TABLE",
              object_name: "users",
              schema_name: null,
              column_name: null,
              comment: "table comment",
            },
            {
              object_type: "MATERIALIZED VIEW",
              object_name: "event_rollup",
              schema_name: "public",
              column_name: null,
              comment: "rollup comment",
            },
            {
              object_type: "SEQUENCE",
              object_name: "event_ids",
              schema_name: "public",
              column_name: null,
              comment: "sequence comment",
            },
          ],
        };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const procedures = await inspector.getCurrentProcedures(client, ["public"]);
    expect(procedures).toEqual([
      {
        name: "refresh_cache",
        schema: "public",
        parameters: [{ name: "p_id", type: "integer", mode: "IN" }],
        language: "plpgsql",
        body: "BEGIN NULL; END",
        securityDefiner: undefined,
        configuration: undefined,
      },
    ]);

    const comments = await inspector.getCurrentComments(client, ["public"]);
    expect(comments).toEqual([
      {
        objectType: "TABLE",
        objectName: "users",
        schemaName: undefined,
        columnName: undefined,
        comment: "table comment",
      },
      {
        objectType: "MATERIALIZED VIEW",
        objectName: "event_rollup",
        schemaName: "public",
        columnName: undefined,
        comment: "rollup comment",
      },
      {
        objectType: "SEQUENCE",
        objectName: "event_ids",
        schemaName: "public",
        columnName: undefined,
        comment: "sequence comment",
      },
    ]);
  });

  test("queries routines with schema-qualified deterministic ordering", async () => {
    const inspector = new DatabaseInspector();
    const client = createClient((sql, params) => {
      if (sql.includes("FROM pg_proc p") && sql.includes("p.prokind IN ('f', 'w', 'a')")) {
        expect(sql).toContain("ORDER BY n.nspname, p.proname");
        expect(params).toEqual([["public", "tenant_a"]]);
        return {
          rows: [
            {
              function_name: "sync_users",
              schema_name: "public",
              arguments: "",
              return_type: "integer",
              language: "sql",
              source_code: "SELECT 1",
              volatility: "VOLATILE",
              parallel: "UNSAFE",
              security_definer: false,
              is_strict: false,
              cost: 100,
              rows: 1000,
            },
          ],
        };
      }

      if (sql.includes("FROM pg_proc p") && sql.includes("p.prokind = 'p'")) {
        expect(sql).toContain("ORDER BY n.nspname, p.proname");
        expect(params).toEqual([["public", "tenant_a"]]);
        return {
          rows: [
            {
              procedure_name: "refresh_cache",
              schema_name: "tenant_a",
              arguments: "",
              language: "sql",
              source_code: "SELECT 1",
              security_definer: false,
            },
          ],
        };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const functions = await inspector.getCurrentFunctions(client, ["public", "tenant_a"]);
    expect(functions).toEqual([
      {
        name: "sync_users",
        schema: "public",
        parameters: [],
        returnType: "integer",
        language: "sql",
        body: "SELECT 1",
        volatility: "VOLATILE",
        parallel: "UNSAFE",
        leakproof: undefined,
        securityDefiner: undefined,
        strict: undefined,
        cost: undefined,
        rows: undefined,
        configuration: undefined,
      },
    ]);

    const procedures = await inspector.getCurrentProcedures(client, ["public", "tenant_a"]);
    expect(procedures).toEqual([
      {
        name: "refresh_cache",
        schema: "tenant_a",
        parameters: [],
        language: "sql",
        body: "SELECT 1",
        securityDefiner: undefined,
        configuration: undefined,
      },
    ]);
  });

  test("uses catalog type identities for routine parameters and returns", async function () {
    const inspector = new DatabaseInspector();
    const client = createClient(function query(sql) {
      expect(sql).toContain("COALESCE(p.proallargtypes, p.proargtypes::oid[])");
      expect(sql).toContain("p.proargmodes::text[] as argument_modes");

      if (sql.includes("p.prokind IN ('f', 'w', 'a')")) {
        expect(sql).toContain("as canonical_return_type");
        return {
          rows: [
            {
              function_name: "external_table_function",
              schema_name: "public",
              arguments: "input \"StateType\" DEFAULT 'a'::\"StateType\"",
              argument_types: ['public."StateType"', "integer", "text"],
              argument_modes: ["i", "t", "t"],
              argument_names: ["input", "value", "label"],
              return_type: "TABLE(value integer, label text)",
              canonical_return_type: "SETOF record",
              language: "sql",
              source_code: "SELECT 1, 'one'",
              volatility: "VOLATILE",
              parallel: "UNSAFE",
              cost: 100,
              rows: 1000,
            },
          ],
        };
      }

      if (sql.includes("p.prokind = 'p'")) {
        return {
          rows: [
            {
              procedure_name: "typed_procedure",
              schema_name: "public",
              arguments:
                "IN source \"StateType\", INOUT changed \"StateType\"[], OUT result text, VARIADIC extras integer[]",
              argument_types: [
                'public."StateType"',
                'public."StateType"[]',
                "text",
                "integer[]",
              ],
              argument_modes: ["i", "b", "o", "v"],
              argument_names: ["source", "changed", "result", "extras"],
              language: "sql",
              source_code: "SELECT 1",
              security_definer: false,
            },
          ],
        };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const functions = await inspector.getCurrentFunctions(client, ["public"]);
    expect(functions[0]?.parameters).toEqual([
      {
        name: "input",
        type: 'public."StateType"',
        mode: "IN",
        default: `'a'::"StateType"`,
      },
      { name: "value", type: "integer", mode: "OUT" },
      { name: "label", type: "text", mode: "OUT" },
    ]);
    expect(functions[0]?.returnType).toBe("SETOF record");

    const procedures = await inspector.getCurrentProcedures(client, ["public"]);
    expect(procedures[0]?.parameters).toEqual([
      { name: "source", type: 'public."StateType"', mode: "IN" },
      { name: "changed", type: 'public."StateType"[]', mode: "INOUT" },
      { name: "result", type: "text", mode: "OUT" },
      { name: "extras", type: "integer[]", mode: "VARIADIC" },
    ]);
  });

  test("normalizes catalog function costs using the language default", async function () {
    const inspector = new DatabaseInspector();
    const client = createClient(function query(sql) {
      expect(sql).toContain("FROM pg_proc p");
      return {
        rows: [
          {
            function_name: "default_internal_cost",
            schema_name: "public",
            arguments: "",
            return_type: "integer",
            language: "internal",
            source_code: "int4abs",
            volatility: "VOLATILE",
            parallel: "UNSAFE",
            cost: 1,
            rows: 0,
          },
          {
            function_name: "explicit_internal_cost",
            schema_name: "public",
            arguments: "",
            return_type: "integer",
            language: "internal",
            source_code: "int4abs",
            volatility: "VOLATILE",
            parallel: "UNSAFE",
            cost: 100,
            rows: 0,
          },
        ],
      };
    });

    const functions = await inspector.getCurrentFunctions(client, ["public"]);
    expect(functions[0]?.cost).toBeUndefined();
    expect(functions[1]?.cost).toBe(100);
  });

  test("inspects routine dependent objects deterministically", async function () {
    const inspector = new DatabaseInspector();
    const client = createClient(function query(sql) {
      expect(sql).toContain("pg_describe_object");
      return {
        rows: [
          {
            function_name: "dependent_function",
            schema_name: "public",
            arguments: "integer",
            return_type: "integer",
            language: "sql",
            source_code: "SELECT $1",
            volatility: "VOLATILE",
            parallel: "UNSAFE",
            cost: 100,
            rows: 0,
            dependent_objects: [
              "index dependent_function_index",
              "rule _RETURN on view dependent_function_view",
            ],
          },
        ],
      };
    });

    const functions = await inspector.getCurrentFunctions(client, ["public"]);
    expect(functions[0]?.dependentObjects).toEqual([
      "index dependent_function_index",
      "rule _RETURN on view dependent_function_view",
    ]);
  });

  test("rejects unmodeled routine catalog forms", async function () {
    const inspector = new DatabaseInspector();
    const baseFunction = {
      function_name: "advanced_function",
      routine_identity: "public.advanced_function(integer)",
      schema_name: "public",
      arguments: "integer",
      return_type: "integer",
      language: "c",
      source_code: "advanced_function",
      routine_kind: "f",
      volatility: "VOLATILE",
      parallel: "UNSAFE",
      cost: 1,
      rows: 0,
    };
    const scenarios = [
      {
        feature: "linked-object AS",
        row: { ...baseFunction, object_file: "$libdir/advanced" },
      },
      {
        feature: "TRANSFORM",
        row: { ...baseFunction, transform_types: [23] },
      },
      {
        feature: "SUPPORT",
        row: { ...baseFunction, has_support: true },
      },
    ];

    for (const scenario of scenarios) {
      const client = createClient(function query(sql) {
        expect(sql).toContain("p.probin as object_file");
        expect(sql).toContain("p.protrftypes as transform_types");
        return { rows: [scenario.row] };
      });
      await expect(
        inspector.getCurrentFunctions(client, ["public"])
      ).rejects.toThrow(scenario.feature);
    }

    const procedureClient = createClient(function query(sql) {
      expect(sql).toContain("p.prosqlbody IS NOT NULL as has_sql_body");
      return {
        rows: [
          {
            procedure_name: "advanced_procedure",
            routine_identity: "public.advanced_procedure(integer)",
            schema_name: "public",
            arguments: "integer",
            language: "sql",
            source_code: "",
            has_sql_body: true,
          },
        ],
      };
    });
    await expect(
      inspector.getCurrentProcedures(procedureClient, ["public"])
    ).rejects.toThrow("SQL-standard body");
  });

  test("parses trigger when clause and function args from trigger definition", async () => {
    const inspector = new DatabaseInspector();
    const client = createClient((sql, params) => {
      if (sql.includes("FROM pg_trigger t")) {
        expect(params).toEqual([["public"]]);
        return {
          rows: [
            {
              trigger_name: "trg_orders",
              table_name: "orders",
              schema_name: "public",
              for_each: "ROW",
              timing: "BEFORE",
              on_insert: true,
              on_delete: false,
              on_update: false,
              on_truncate: false,
              function_name: "sync_order",
              function_schema: "public",
              update_columns: ["status", "priority"],
              old_transition_table: "old_rows",
              new_transition_table: "new_rows",
              trigger_enabled: "A",
              trigger_def: "CREATE TRIGGER trg_orders BEFORE INSERT ON public.orders FOR EACH ROW WHEN ((new.id > 0 AND new.status <> 'x')) EXECUTE FUNCTION public.sync_order('1', 'a,b', 'it''s')",
            },
          ],
        };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const triggers = await inspector.getCurrentTriggers(client, ["public"]);
    expect(triggers).toEqual([
      {
        name: "trg_orders",
        tableName: "orders",
        schema: "public",
        timing: "BEFORE",
        events: ["INSERT"],
        forEach: "ROW",
        when: "new.id > 0 AND new.status <> 'x'",
        functionName: "sync_order",
        functionSchema: "public",
        functionArgs: ["'1'", "'a,b'", "'it''s'"],
        updateColumns: ["status", "priority"],
        oldTransitionTable: "old_rows",
        newTransitionTable: "new_rows",
        enabled: "always",
      },
    ]);
  });

  test("parses deferrable metadata for foreign keys and unique constraints", async () => {
    const inspector = new DatabaseInspector();
    const client = createClient((sql) => {
      if (sql.includes("WHERE c.contype = 'f'")) {
        expect(sql).toContain("to_jsonb(c) -> 'confdelsetcols'");
        return {
          rows: [
            {
              constraint_name: "fk_parent",
              columns: ["parent_id"],
              referenced_schema: "public",
              referenced_table: "parents",
              referenced_columns: ["id"],
              delete_set_columns: ["parent_id"],
              delete_rule: "n",
              update_rule: "a",
              match_type: "f",
              deferrable: true,
              initially_deferred: true,
              validated: false,
            },
          ],
        };
      }

      if (sql.includes("WHERE c.contype = 'u'")) {
        expect(sql).toContain("to_jsonb(index_catalog)");
        return {
          rows: [
            {
              constraint_name: "uq_external",
              columns: ["external_id"],
              included_columns: ["display_name", "updated_at"],
              storage_options: ["fillfactor=75"],
              tablespace_name: "fastspace",
              nulls_not_distinct: true,
              deferrable: true,
              initially_deferred: true,
            },
          ],
        };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const foreignKeys = await inspector.getForeignKeyConstraints(client, "child", "public");
    expect(foreignKeys).toEqual([
      {
        name: "fk_parent",
        columns: ["parent_id"],
        referencedTable: "parents",
        referencedColumns: ["id"],
        onDeleteColumns: ["parent_id"],
        matchType: "FULL",
        onDelete: "SET NULL",
        onUpdate: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
        notValid: true,
      },
    ]);

    const uniqueConstraints = await inspector.getUniqueConstraints(client, "child", "public");
    expect(uniqueConstraints).toEqual([
      {
        name: "uq_external",
        columns: ["external_id"],
        include: ["display_name", "updated_at"],
        storageParameters: { fillfactor: "75" },
        tablespace: "fastspace",
        nullsNotDistinct: true,
        deferrable: true,
        initiallyDeferred: true,
      },
    ]);
  });

  test("parses primary key index and timing metadata", async function () {
    const inspector = new DatabaseInspector();
    const client = createClient(function handleQuery(sql, params) {
      expect(sql).toContain("constraint_catalog.contype = 'p'");
      expect(params).toEqual(["accounts", "public"]);
      return {
        rows: [{
          constraint_name: "accounts_pkey",
          columns: ["tenant_id", "id"],
          included_columns: ["display_name"],
          storage_options: ["fillfactor=75"],
          tablespace_name: "fastspace",
          deferrable: true,
          initially_deferred: true,
        }],
      };
    });

    expect(
      await (inspector as any).getPrimaryKeyConstraint(
        client,
        "accounts",
        "public"
      )
    ).toEqual({
      name: "accounts_pkey",
      columns: ["tenant_id", "id"],
      include: ["display_name"],
      storageParameters: { fillfactor: "75" },
      tablespace: "fastspace",
      deferrable: true,
      initiallyDeferred: true,
    });
  });

  test("parses table index opclass and storage metadata", async () => {
    const inspector = new DatabaseInspector();
    const client = createClient((sql, params) => {
      if (sql.includes("FROM pg_indexes i")) {
        expect(params).toEqual(["users", "public"]);
        expect(sql).toContain("con.contype IN ('u', 'x')");
        expect(sql).toContain("to_jsonb(ix)");
        return {
          rows: [
            {
              index_name: "idx_users_email",
              table_name: "users",
              table_schema: "public",
              index_definition: "CREATE INDEX idx_users_email ON users USING btree (email text_pattern_ops DESC NULLS LAST, created_at) INCLUDE (display_name, updated_at)",
              is_unique: true,
              nulls_not_distinct: true,
              access_method: "btree",
              has_expressions: false,
              tablespace_name: "fastspace",
              storage_options: ["fillfactor=70", "note='abc'"],
              expression_def: null,
              column_names: ["email", "created_at"],
              included_columns: ["display_name", "updated_at"],
              opclass_names: ["text_pattern_ops", null],
              where_clause: "active = true",
              sort_options: [1, 0],
              index_key_count: 2,
              key_statistics_targets: [null, null],
              expression_positions: [],
              key_opclasses: [
                {
                  name: "text_pattern_ops",
                  schema: "pg_catalog",
                  default: false,
                },
                {
                  name: "timestamp_ops",
                  schema: "pg_catalog",
                  default: true,
                },
              ],
            },
          ],
        };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const indexes = await inspector.getTableIndexes(client, "users", "public");
    expect(indexes).toEqual([
      {
        name: "idx_users_email",
        tableName: "users",
        schema: "public",
        columns: ["email", "created_at"],
        include: ["display_name", "updated_at"],
        sortOrders: ["DESC", "ASC"],
        nullsOrders: ["LAST", "LAST"],
        opclasses: { email: "text_pattern_ops" },
        terms: [
          {
            column: "email",
            opclass: { name: "text_pattern_ops" },
            opclassDefault: false,
            order: "DESC",
            nullsOrder: "LAST",
          },
          {
            column: "created_at",
            opclass: {
              name: "timestamp_ops",
              schema: "pg_catalog",
            },
            opclassDefault: true,
            order: "ASC",
            nullsOrder: "LAST",
          },
        ],
        type: "btree",
        unique: true,
        nullsNotDistinct: true,
        concurrent: false,
        where: "active = true",
        expression: undefined,
        storageParameters: { fillfactor: "70", note: "abc" },
        tablespace: "fastspace",
      },
    ]);
  });

  test("parses exclusion constraints and supporting index metadata", async function () {
    const inspector = new DatabaseInspector();
    const client = createClient(function handleQuery(sql, params) {
      expect(sql).toContain("WHERE c.contype = 'x'");
      expect(sql).toContain("exclusion ON true");
      expect(params).toEqual(["bookings", "public"]);
      return {
        rows: [
          {
            constraint_name: "bookings_no_overlap",
            deferrable: true,
            initially_deferred: true,
            access_method: "gist",
            storage_options: ["fillfactor=80"],
            tablespace_name: "fast_indexes",
            where_clause: "NOT isempty(during)",
            included_columns: ["id"],
            elements: [
              {
                definition: "during",
                operator_name: "&&",
                operator_schema: "pg_catalog",
              },
              {
                definition: "tenant_id",
                operator_name: "=",
                operator_schema: "custom_ops",
              },
            ],
          },
        ],
      };
    });

    const constraints = await inspector.getExclusionConstraints(
      client,
      "bookings",
      "public"
    );
    expect(constraints).toEqual([
      {
        name: "bookings_no_overlap",
        method: "gist",
        elements: [
          { definition: "during", operator: { name: "&&" } },
          {
            definition: "tenant_id",
            operator: { name: "=", schema: "custom_ops" },
          },
        ],
        include: ["id"],
        storageParameters: { fillfactor: "80" },
        tablespace: "fast_indexes",
        where: "NOT isempty(during)",
        deferrable: true,
        initiallyDeferred: true,
      },
    ]);
  });

  test("parses expression index opclass metadata", async () => {
    const inspector = new DatabaseInspector();
    const client = createClient((sql, params) => {
      if (sql.includes("FROM pg_indexes i")) {
        expect(params).toEqual(["users", "public"]);
        return {
          rows: [
            {
              index_name: "idx_users_lower_email",
              table_name: "users",
              table_schema: "public",
              index_definition: "CREATE INDEX idx_users_lower_email ON users USING gin (lower(email) gin_trgm_ops)",
              is_unique: false,
              access_method: "gin",
              has_expressions: true,
              tablespace_name: null,
              storage_options: null,
              expression_def: "lower(email)",
              column_names: [],
              opclass_names: [],
              expression_opclass_name: "gin_trgm_ops",
              where_clause: null,
              sort_options: [0],
              index_key_count: 1,
              key_statistics_targets: [null],
              expression_positions: [1],
              key_opclasses: [
                {
                  name: "gin_trgm_ops",
                  schema: "public",
                  default: false,
                },
              ],
            },
          ],
        };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const indexes = await inspector.getTableIndexes(client, "users", "public");
    expect(indexes).toEqual([
      {
        name: "idx_users_lower_email",
        tableName: "users",
        schema: "public",
        columns: [],
        opclasses: undefined,
        expressionOpclass: "gin_trgm_ops",
        type: "gin",
        unique: false,
        concurrent: false,
        where: undefined,
        expression: "lower(email)",
        terms: [
          {
            expression: "lower(email)",
            opclass: { name: "gin_trgm_ops" },
            opclassDefault: false,
            order: "ASC",
            nullsOrder: "LAST",
          },
        ],
        storageParameters: undefined,
        tablespace: undefined,
      },
    ]);
  });

  test("builds complete schema from delegated methods", async () => {
    const inspector = new DatabaseInspector() as any;
    inspector.getCurrentSchema = async () => [{ name: "users" }];
    inspector.getCurrentViews = async () => [{ name: "v_users" }];
    inspector.getCurrentEnums = async () => [{ name: "status" }];
    inspector.getCurrentCompositeTypes = async () => [];
    inspector.getCurrentFunctions = async () => [{ name: "f" }];
    inspector.getCurrentProcedures = async () => [{ name: "p" }];
    inspector.getCurrentTriggers = async () => [{ name: "t" }];
    inspector.getCurrentSequences = async () => [{ name: "s" }];
    inspector.getCurrentExtensions = async () => [{ name: "x" }];
    inspector.getCurrentSchemas = async () => [{ name: "public" }];
    inspector.getCurrentComments = async () => [{ comment: "c" }];
    inspector.getCurrentSqlObjects = async () => [];

    const complete = await inspector.getCompleteSchema({} as any, ["public"]);
    expect(complete).toEqual({
      tables: [{ name: "users" }],
      views: [{ name: "v_users" }],
      enumTypes: [{ name: "status" }],
      functions: [{ name: "f" }],
      procedures: [{ name: "p" }],
      triggers: [{ name: "t" }],
      sequences: [{ name: "s" }],
      extensions: [{ name: "x" }],
      schemas: [{ name: "public" }],
      comments: [{ comment: "c" }],
    });
  });

  test("handles view dependency success and failure", async () => {
    const inspector = new DatabaseInspector();
    const okClient = createClient((sql, params) => {
      if (sql.includes("FROM information_schema.view_table_usage")) {
        expect(params).toEqual(["public", "v_users"]);
        return {
          rows: [{ dependency: "users" }, { dependency: "audit.logs" }],
        };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    });

    expect(await inspector.getViewDependencies(okClient, "v_users")).toEqual([
      "users",
      "audit.logs",
    ]);

    const tenantClient = createClient((sql, params) => {
      if (sql.includes("FROM information_schema.view_table_usage")) {
        expect(params).toEqual(["tenant_a", "v_users"]);
        return {
          rows: [{ dependency: "tenant_a.users" }],
        };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    });

    expect(await inspector.getViewDependencies(tenantClient, "v_users", "tenant_a")).toEqual([
      "tenant_a.users",
    ]);

    const badClient = {
      query: async () => {
        throw new Error("permission denied");
      },
    } as any;
    expect(await inspector.getViewDependencies(badClient, "v_users")).toEqual([]);
  });

  test("handles function dependency success and failure", async () => {
    const inspector = new DatabaseInspector();
    const okClient = createClient((sql, params) => {
      if (sql.includes("FROM pg_proc p") && sql.includes("JOIN pg_depend d")) {
        expect(params).toEqual(["public", "sync_users"]);
        return {
          rows: [{ dependency: "users" }, { dependency: "audit.logs" }],
        };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    });

    expect(await inspector.getFunctionDependencies(okClient, "sync_users")).toEqual([
      "users",
      "audit.logs",
    ]);

    const tenantClient = createClient((sql, params) => {
      if (sql.includes("FROM pg_proc p") && sql.includes("JOIN pg_depend d")) {
        expect(params).toEqual(["tenant_a", "sync_users"]);
        return {
          rows: [{ dependency: "tenant_a.users" }],
        };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    });

    expect(
      await inspector.getFunctionDependencies(tenantClient, "sync_users", "tenant_a")
    ).toEqual(["tenant_a.users"]);

    const badClient = {
      query: async () => {
        throw new Error("permission denied");
      },
    } as any;
    expect(await inspector.getFunctionDependencies(badClient, "sync_users")).toEqual([]);
  });

  test("covers trigger and function argument parser edge branches", function () {
    const inspector = new DatabaseInspector() as any;

    expect(inspector.parseTriggerWhenClause(null)).toBeUndefined();
    expect(inspector.parseTriggerFunctionArgs(null)).toBeUndefined();
    expect(
      inspector.parseTriggerFunctionArgs(
        "CREATE TRIGGER trg BEFORE INSERT ON public.users EXECUTE FUNCTION public.fn"
      )
    ).toBeUndefined();

    expect(inspector.parseFunctionArgument("   ")).toBeNull();
    const noTypeInspector = new DatabaseInspector() as any;
    noTypeInspector.extractArgumentNameAndType = function () {
      return { name: undefined, type: "" };
    };
    expect(noTypeInspector.parseFunctionArgument("IN p integer")).toBeNull();

    expect(inspector.extractArgumentDefault("a text DEFAULT 'it''s'")).toEqual({
      signaturePart: "a text",
      defaultValue: "'it''s'",
    });
    expect(inspector.extractArgumentDefault('"na""me" text DEFAULT 1')).toEqual({
      signaturePart: '"na""me" text',
      defaultValue: "1",
    });

    expect(inspector.extractArgumentNameAndType("   ")).toEqual({
      name: undefined,
      type: "",
    });
    expect(inspector.extractArgumentNameAndType('"OnlyName"')).toEqual({
      name: undefined,
      type: '"OnlyName"',
    });
    expect(inspector.extractArgumentNameAndType("integer")).toEqual({
      name: undefined,
      type: "integer",
    });

    expect(inspector.readQuotedIdentifier("plain")).toBeNull();
    expect(inspector.readQuotedIdentifier('"a""b"')).toBe('"a""b"');
    expect(inspector.readQuotedIdentifier('"unterminated')).toBeNull();

    expect(inspector.unquoteIdentifier("plain")).toBe("plain");

    expect(
      inspector.splitFunctionArguments(`a text DEFAULT 'it''s', "na""me" text, c integer`)
    ).toEqual([
      `a text DEFAULT 'it''s'`,
      `"na""me" text`,
      "c integer",
    ]);
  });

  test("covers sql object inspector helper branches", function () {
    const inspector = new DatabaseInspector() as any;

    expect(
      inspector.buildColumnDefinition({
        column_name: "slug",
        pg_type: "text",
        is_nullable: false,
        column_default: null,
        attgenerated: "s",
        generation_expression: "lower(name)",
      })
    ).toBe('"slug" text GENERATED ALWAYS AS (lower(name)) STORED');

    expect(
      inspector.buildColumnDefinition({
        column_name: "normalized_slug",
        pg_type: "text",
        is_nullable: true,
        column_default: null,
        attgenerated: "v",
        generation_expression: "lower(slug)",
      })
    ).toBe(
      '"normalized_slug" text GENERATED ALWAYS AS (lower(slug)) VIRTUAL'
    );

    expect(
      inspector.buildColumnDefinition({
        column_name: "count",
        pg_type: "integer",
        is_nullable: false,
        column_default: "0",
        attgenerated: "",
        generation_expression: null,
      })
    ).toBe('"count" integer NOT NULL DEFAULT 0');

    expect(inspector.formatGrantTarget("SCHEMA", "public", "public")).toBe('"public"');
    expect(inspector.formatGrantTarget("FOREIGN SERVER", "analytics_server")).toBe('"analytics_server"');
    expect(inspector.formatOptions(null)).toBe("");
    expect(inspector.formatOptions(["just_flag", "host=127.0.0.1"])).toBe("just_flag, host '127.0.0.1'");
  });
});
