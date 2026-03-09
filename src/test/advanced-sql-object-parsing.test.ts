import { describe, expect, test } from "bun:test";
import { SchemaParser } from "../core/schema/parser";

describe("Advanced SQL object parsing", function () {
  test("tracks issue 112 object families from sql files", async function () {
    const parser = new SchemaParser();
    const sql = `
      CREATE TABLE public.accounts (
        id integer NOT NULL,
        region_id integer NOT NULL
      ) PARTITION BY RANGE (region_id);

      CREATE TABLE public.accounts_eu
        PARTITION OF public.accounts
        FOR VALUES FROM (0) TO (100);

      CREATE TABLE public.users (
        id integer PRIMARY KEY,
        tenant_id integer NOT NULL
      );

      ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

      CREATE POLICY tenant_policy
        ON public.users
        FOR SELECT
        USING (tenant_id = current_setting('app.tenant_id')::integer);

      ALTER POLICY tenant_policy
        ON public.users
        USING (tenant_id = current_setting('app.tenant_id')::integer)
        WITH CHECK (tenant_id = current_setting('app.tenant_id')::integer);

      CREATE DOMAIN public.email_address AS text
        CHECK (POSITION('@' IN VALUE) > 1);

      CREATE TYPE public.price_window AS RANGE (
        subtype = numeric
      );

      CREATE SERVER analytics_server
        FOREIGN DATA WRAPPER postgres_fdw
        OPTIONS (host '127.0.0.1', dbname 'analytics', port '5432');

      CREATE FUNCTION public.audit_users_trigger()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN NEW;
      END;
      $$;

      CREATE PROCEDURE public.touch_users()
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NULL;
      END;
      $$;

      CREATE CONSTRAINT TRIGGER audit_users_trigger
        AFTER INSERT ON public.users
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION public.audit_users_trigger();

      CREATE FUNCTION public.audit_ddl()
      RETURNS event_trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN;
      END;
      $$;

      CREATE EVENT TRIGGER audit_ddl
        ON ddl_command_end
        EXECUTE FUNCTION public.audit_ddl();

      CREATE ROLE app_reader NOLOGIN;
      CREATE USER app_user WITH LOGIN PASSWORD 'secret';
      GRANT SELECT ON TABLE public.users TO app_reader;
      ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT SELECT ON TABLES TO app_reader;
    `;

    const parsed = await parser.parseSchema(sql);
    const sqlObjects = ((parsed as any).sqlObjects || []).map(function (item: any) {
      return item.kind;
    });

    expect(parsed.tables.map(function (table) {
      return table.name;
    })).toEqual(["users"]);
    expect(parsed.procedures?.map(function (item) {
      return item.name;
    })).toEqual(["touch_users"]);
    expect(sqlObjects.sort()).toEqual([
      "constraint-trigger",
      "domain-type",
      "event-trigger",
      "foreign-server",
      "grant",
      "grant",
      "partition",
      "partition",
      "policy",
      "policy",
      "range-type",
      "role",
      "row-level-security",
      "user",
    ]);
  });
});
