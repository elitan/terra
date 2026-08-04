import { describe, expect, test } from "bun:test";
import { DatabaseInspector } from "../core/schema/inspector";

function createClient(handler: (sql: string, params?: unknown[]) => { rows: unknown[] }): any {
  return {
    query: async (sql: string, params?: unknown[]) => handler(sql, params),
  };
}

describe("DatabaseInspector coverage", () => {
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
              reloptions: ["security_barrier=true"],
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
            },
            {
              view_name: "mv_orders",
              schema_name: "tenant_a",
              definition: " SELECT id FROM orders ",
              ispopulated: false,
              column_names: ["id"],
            },
          ],
        };
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
        return {
          rows: [
            {
              object_type: "TABLE",
              object_name: "users",
              schema_name: null,
              column_name: null,
              comment: "table comment",
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
    ]);
  });

  test("queries routines with schema-qualified deterministic ordering", async () => {
    const inspector = new DatabaseInspector();
    const client = createClient((sql, params) => {
      if (sql.includes("FROM pg_proc p") && sql.includes("p.prokind = 'f'")) {
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
        securityDefiner: undefined,
        strict: undefined,
        cost: undefined,
        rows: undefined,
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
      },
    ]);
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
              index_definition: "CREATE INDEX idx_users_email ON users USING btree (email DESC, created_at)",
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
