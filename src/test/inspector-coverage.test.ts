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

  test("parses views and materialized view indexes", async () => {
    const inspector = new DatabaseInspector();
    const client = createClient((sql, params) => {
      if (sql.includes("FROM information_schema.views")) {
        return {
          rows: [
            {
              view_name: "v_users",
              schema_name: "public",
              view_definition: " SELECT id FROM users ",
              check_option: "LOCAL",
              reloptions: ["security_barrier=true"],
              is_updatable: "YES",
              is_insertable_into: "YES",
            },
          ],
        };
      }

      if (sql.includes("FROM pg_matviews")) {
        return {
          rows: [
            {
              view_name: "mv_users",
              schema_name: "public",
              definition: " SELECT id FROM users ",
              ispopulated: true,
            },
          ],
        };
      }

      if (sql.includes("FROM pg_indexes")) {
        expect(params).toEqual(["public", "mv_users"]);
        return {
          rows: [{ indexname: "mv_users_idx", indexdef: "CREATE INDEX mv_users_idx ON mv_users(id)" }],
        };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const views = await inspector.getCurrentViews(client, ["public"]);
    expect(views).toEqual([
      {
        name: "v_users",
        schema: "public",
        definition: "SELECT id FROM users",
        materialized: false,
        checkOption: "LOCAL",
        securityBarrier: true,
      },
      {
        name: "mv_users",
        schema: "public",
        definition: "SELECT id FROM users",
        materialized: true,
        indexes: [
          {
            name: "mv_users_idx",
            tableName: "mv_users",
            columns: [],
            type: "btree",
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

  test("builds complete schema from delegated methods", async () => {
    const inspector = new DatabaseInspector() as any;
    inspector.getCurrentSchema = async () => [{ name: "users" }];
    inspector.getCurrentViews = async () => [{ name: "v_users" }];
    inspector.getCurrentEnums = async () => [{ name: "status" }];
    inspector.getCurrentFunctions = async () => [{ name: "f" }];
    inspector.getCurrentProcedures = async () => [{ name: "p" }];
    inspector.getCurrentTriggers = async () => [{ name: "t" }];
    inspector.getCurrentSequences = async () => [{ name: "s" }];
    inspector.getCurrentExtensions = async () => [{ name: "x" }];
    inspector.getCurrentSchemas = async () => [{ name: "public" }];
    inspector.getCurrentComments = async () => [{ comment: "c" }];

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
        expect(params).toEqual(["v_users"]);
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

    const badClient = {
      query: async () => {
        throw new Error("permission denied");
      },
    } as any;
    expect(await inspector.getViewDependencies(badClient, "v_users")).toEqual([]);
  });
});
