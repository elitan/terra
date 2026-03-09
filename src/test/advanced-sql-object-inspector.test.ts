import { describe, expect, test } from "bun:test";
import { DatabaseInspector } from "../core/schema/inspector";

function createClient(handler: (sql: string, params?: unknown[]) => { rows: unknown[] }): any {
  return {
    query: async function (sql: string, params?: unknown[]) {
      return handler(sql, params);
    },
  };
}

describe("Advanced SQL object inspector", function () {
  test("inspects issue 112 object families from a live database", async function () {
    const inspector = new DatabaseInspector();
    const client = createClient(function (sql, params) {
      if (sql.includes("pg_get_partkeydef")) {
        expect(params).toEqual([["public"]]);
        return {
          rows: [
            {
              oid: 101,
              table_name: "accounts",
              schema_name: "public",
              partition_key: "RANGE (region_id)",
            },
          ],
        };
      }

      if (sql.includes("pg_attribute a") && params?.[0] === "accounts") {
        return {
          rows: [
            {
              column_name: "id",
              pg_type: "integer",
              is_nullable: false,
              column_default: null,
              attgenerated: "",
              generation_expression: null,
            },
            {
              column_name: "region_id",
              pg_type: "integer",
              is_nullable: false,
              column_default: null,
              attgenerated: "",
              generation_expression: null,
            },
          ],
        };
      }

      if (sql.includes("WHERE conrelid = $1")) {
        expect(params).toEqual([101]);
        return {
          rows: [
            {
              conname: "accounts_pkey",
              definition: "PRIMARY KEY (id)",
            },
          ],
        };
      }

      if (sql.includes("c.relispartition")) {
        expect(params).toEqual([["public"]]);
        return {
          rows: [
            {
              table_name: "accounts_eu",
              schema_name: "public",
              parent_name: "accounts",
              parent_schema: "public",
              partition_bound: "FOR VALUES FROM (0) TO (100)",
            },
          ],
        };
      }

      if (sql.includes("relrowsecurity")) {
        expect(params).toEqual([["public"]]);
        return {
          rows: [
            {
              table_name: "users",
              schema_name: "public",
              row_security_enabled: true,
              row_security_forced: false,
            },
          ],
        };
      }

      if (sql.includes("FROM pg_policy")) {
        expect(params).toEqual([["public"]]);
        return {
          rows: [
            {
              policy_name: "tenant_policy",
              table_name: "users",
              schema_name: "public",
              policy_command: "r",
              is_permissive: true,
              using_expression: "(tenant_id = current_setting('app.tenant_id'::text)::integer)",
              with_check_expression: null,
              policy_roles: ["app_reader"],
            },
          ],
        };
      }

      if (sql.includes("t.typtype = 'd'")) {
        expect(params).toEqual([["public"]]);
        return {
          rows: [
            {
              oid: 201,
              type_name: "email_address",
              schema_name: "public",
              base_type: "text",
              is_not_null: false,
              default_value: null,
            },
          ],
        };
      }

      if (sql.includes("WHERE contypid = $1")) {
        expect(params).toEqual([201]);
        return {
          rows: [
            {
              conname: "email_address_check",
              definition: "CHECK ((position(('@'::text), VALUE) > 1))",
            },
          ],
        };
      }

      if (sql.includes("FROM pg_range")) {
        expect(params).toEqual([["public"]]);
        return {
          rows: [
            {
              type_name: "price_window",
              schema_name: "public",
              subtype_name: "numeric",
              subtype_opclass_name: null,
              collation_name: null,
              canonical_name: null,
              diff_name: null,
            },
          ],
        };
      }

      if (sql.includes("srvoptions as server_options")) {
        return {
          rows: [
            {
              server_name: "analytics_server",
              fdw_name: "postgres_fdw",
              server_options: ["host=127.0.0.1", "dbname=analytics", "port=5432"],
            },
          ],
        };
      }

      if (sql.includes("t.tgconstraint <> 0")) {
        expect(params).toEqual([["public"]]);
        return {
          rows: [
            {
              trigger_name: "audit_users_trigger",
              table_name: "users",
              schema_name: "public",
              trigger_definition: "CREATE CONSTRAINT TRIGGER audit_users_trigger AFTER INSERT ON public.users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.audit_users_trigger()",
            },
          ],
        };
      }

      if (sql.includes("FROM pg_event_trigger")) {
        return {
          rows: [
            {
              trigger_name: "audit_ddl",
              event_name: "ddl_command_end",
              trigger_tags: ["CREATE TABLE"],
              function_name: "audit_ddl",
              function_schema: "public",
            },
          ],
        };
      }

      if (sql.includes("FROM pg_roles")) {
        return {
          rows: [
            {
              role_name: "app_reader",
              can_login: false,
              is_superuser: false,
              can_create_db: false,
              can_create_role: false,
              can_inherit: true,
              can_replicate: false,
              can_bypass_rls: false,
              connection_limit: -1,
            },
            {
              role_name: "app_user",
              can_login: true,
              is_superuser: false,
              can_create_db: false,
              can_create_role: false,
              can_inherit: true,
              can_replicate: false,
              can_bypass_rls: false,
              connection_limit: -1,
            },
          ],
        };
      }

      if (sql.includes("aclexplode(c.relacl)")) {
        expect(params).toEqual([["public"]]);
        return {
          rows: [
            {
              schema_name: "public",
              object_name: "users",
              object_type: "TABLE",
              grantee_name: "app_reader",
              privilege_type: "SELECT",
              is_grantable: false,
            },
          ],
        };
      }

      if (sql.includes("aclexplode(n.nspacl)")) {
        expect(params).toEqual([["public"]]);
        return { rows: [] };
      }

      if (sql.includes("aclexplode(s.srvacl)")) {
        return { rows: [] };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    });

    const sqlObjects = await inspector.getCurrentSqlObjects(client, ["public"]);
    const kinds = sqlObjects.map(function (item) {
      return item.kind;
    }).sort();

    expect(kinds).toEqual([
      "constraint-trigger",
      "domain-type",
      "event-trigger",
      "foreign-server",
      "grant",
      "partition",
      "partition",
      "policy",
      "range-type",
      "role",
      "row-level-security",
      "user",
    ]);

    expect(sqlObjects.find(function (item) {
      return item.key === "partition:public.accounts";
    })).toEqual({
      kind: "partition",
      key: "partition:public.accounts",
      name: "accounts",
      schema: "public",
      createStatement: 'CREATE TABLE "public"."accounts" (\n  "id" integer NOT NULL,\n  "region_id" integer NOT NULL,\n  CONSTRAINT "accounts_pkey" PRIMARY KEY (id)\n) PARTITION BY RANGE (region_id);',
      dropStatement: 'DROP TABLE IF EXISTS "public"."accounts" CASCADE;',
    });

    expect(sqlObjects.find(function (item) {
      return item.key === "grant:GRANT SELECT ON TABLE \"public\".\"users\" TO \"app_reader\";";
    })).toEqual({
      kind: "grant",
      key: 'grant:GRANT SELECT ON TABLE "public"."users" TO "app_reader";',
      name: 'GRANT SELECT ON TABLE "public"."users" TO "app_reader";',
      schema: "public",
      createStatement: 'GRANT SELECT ON TABLE "public"."users" TO "app_reader";',
      dropStatement: 'REVOKE SELECT ON TABLE "public"."users" FROM "app_reader";',
    });
  });
});
