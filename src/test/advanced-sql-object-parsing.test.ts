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
      "range-type",
      "role",
      "row-level-security",
      "user",
    ]);
  });

  test("splits combined row security declarations into stable desired objects", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      ALTER TABLE "security"."Order"
        ENABLE ROW LEVEL SECURITY,
        FORCE ROW LEVEL SECURITY;
    `);

    expect(parsed.sqlObjects).toEqual([
      expect.objectContaining({
        key: "row-level-security:security.Order:enabled",
        createStatement: expect.stringMatching(
          /ALTER TABLE security\."Order"\s+ENABLE ROW LEVEL SECURITY;/
        ),
      }),
      expect.objectContaining({
        key: "row-level-security:security.Order:force",
        createStatement: expect.stringMatching(
          /ALTER TABLE security\."Order"\s+FORCE ROW LEVEL SECURITY;/
        ),
      }),
    ]);
  });

  test("preserves trigger definition fields and declarative firing modes", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE TRIGGER update_audit
        BEFORE UPDATE OF name, "Status" ON "audit"."Orders"
        FOR EACH ROW
        EXECUTE FUNCTION public.audit_row();
      ALTER TABLE "audit"."Orders"
        ENABLE ALWAYS TRIGGER update_audit;

      CREATE TRIGGER transition_audit
        AFTER UPDATE ON "audit"."Orders"
        REFERENCING OLD TABLE AS old_rows NEW TABLE AS "New Rows"
        FOR EACH STATEMENT
        EXECUTE FUNCTION public.audit_statement();

      CREATE CONSTRAINT TRIGGER constraint_audit
        AFTER INSERT ON "audit"."Orders"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION public.audit_row();
      ALTER TABLE "audit"."Orders"
        DISABLE TRIGGER constraint_audit;

      CREATE EVENT TRIGGER ddl_audit
        ON ddl_command_end
        EXECUTE FUNCTION public.audit_ddl();
      ALTER EVENT TRIGGER ddl_audit ENABLE REPLICA;
    `);

    expect(parsed.triggers).toEqual([
      expect.objectContaining({
        name: "update_audit",
        updateColumns: ["name", "Status"],
        enabled: "always",
      }),
      expect.objectContaining({
        name: "transition_audit",
        oldTransitionTable: "old_rows",
        newTransitionTable: "New Rows",
      }),
    ]);
    expect(parsed.sqlObjects?.find(function findConstraintTrigger(object) {
      return object.key ===
        "constraint-trigger:audit.Orders.constraint_audit";
    })).toMatchObject({
      triggerTable: { name: "Orders", schema: "audit" },
      triggerEnabled: "disabled",
    });
    expect(parsed.sqlObjects?.find(function findEventTrigger(object) {
      return object.key === "event-trigger:ddl_audit";
    })).toMatchObject({
      triggerEnabled: "replica",
    });
  });

  test("rejects ambiguous or unbound trigger firing mutations", async function () {
    const parser = new SchemaParser();

    await expect(
      parser.parseSchema(
        "ALTER TABLE public.orders DISABLE TRIGGER USER;"
      )
    ).rejects.toThrow(/bulk trigger firing mutations.*not supported/i);
    await expect(
      parser.parseSchema(
        "ALTER TABLE public.orders DISABLE TRIGGER missing_trigger;"
      )
    ).rejects.toThrow(/target trigger.*not declared/i);
    await expect(
      parser.parseSchema(`
        CREATE TRIGGER audit
          AFTER INSERT ON public.orders
          EXECUTE FUNCTION public.audit_row();
        ALTER TABLE ONLY public.orders DISABLE TRIGGER audit;
      `)
    ).rejects.toThrow(/ALTER TABLE ONLY.*unmodeled state/i);
    await expect(
      parser.parseSchema(`
        CREATE TRIGGER audit
          AFTER INSERT ON public.orders
          EXECUTE FUNCTION public.audit_row();
        ALTER TABLE public.orders DISABLE TRIGGER audit;
        ALTER TABLE public.orders ENABLE TRIGGER audit;
      `)
    ).rejects.toThrow(/firing mode.*more than once/i);
  });

  test("rejects duplicate declarations across every trigger family", async function () {
    const parser = new SchemaParser();

    await expect(parser.parseSchema(`
      CREATE TRIGGER audit
        AFTER INSERT ON public.orders
        EXECUTE FUNCTION public.audit_row();
      CREATE TRIGGER audit
        AFTER INSERT ON public.orders
        EXECUTE FUNCTION public.audit_row();
    `)).rejects.toThrow(/trigger.*orders\.audit.*declared more than once/i);

    await expect(parser.parseSchema(`
      CREATE CONSTRAINT TRIGGER audit
        AFTER INSERT ON public.orders
        FOR EACH ROW
        EXECUTE FUNCTION public.audit_row();
      CREATE CONSTRAINT TRIGGER audit
        AFTER INSERT ON public.orders
        FOR EACH ROW
        EXECUTE FUNCTION public.audit_row();
    `)).rejects.toThrow(/trigger.*orders\.audit.*declared more than once/i);

    await expect(parser.parseSchema(`
      CREATE EVENT TRIGGER audit_ddl
        ON ddl_command_end
        EXECUTE FUNCTION public.audit_ddl();
      CREATE EVENT TRIGGER audit_ddl
        ON ddl_command_end
        EXECUTE FUNCTION public.audit_ddl();
    `)).rejects.toThrow(/trigger.*audit_ddl.*declared more than once/i);
  });

  test("preserves declarative replica identity for tables and partitions", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE TABLE public.default_identity (id integer PRIMARY KEY);
      ALTER TABLE public.default_identity REPLICA IDENTITY DEFAULT;

      CREATE TABLE public.full_identity (id integer, value text);
      ALTER TABLE public.full_identity REPLICA IDENTITY FULL;

      CREATE TABLE public.nothing_identity (id integer, value text);
      ALTER TABLE public.nothing_identity REPLICA IDENTITY NOTHING;

      CREATE TABLE public.index_identity (
        id integer NOT NULL,
        value text
      );
      CREATE UNIQUE INDEX index_identity_key
        ON public.index_identity (id);
      ALTER TABLE public.index_identity
        REPLICA IDENTITY USING INDEX index_identity_key;

      CREATE TABLE public.partition_identity (
        id integer NOT NULL,
        CONSTRAINT partition_identity_pkey PRIMARY KEY (id)
      ) PARTITION BY RANGE (id);
      ALTER TABLE public.partition_identity
        REPLICA IDENTITY USING INDEX partition_identity_pkey;

      CREATE TABLE public.partition_unique_identity (
        id integer NOT NULL,
        CONSTRAINT partition_unique_identity_key UNIQUE (id)
      ) PARTITION BY RANGE (id);
      ALTER TABLE public.partition_unique_identity
        REPLICA IDENTITY USING INDEX partition_unique_identity_key;
    `);

    expect(parsed.tables.find(function findDefault(table) {
      return table.name === "default_identity";
    })).not.toHaveProperty("replicaIdentity");
    expect(parsed.tables.find(function findFull(table) {
      return table.name === "full_identity";
    })).toHaveProperty("replicaIdentity", { mode: "full" });
    expect(parsed.tables.find(function findNothing(table) {
      return table.name === "nothing_identity";
    })).toHaveProperty("replicaIdentity", { mode: "nothing" });
    expect(parsed.tables.find(function findIndex(table) {
      return table.name === "index_identity";
    })).toHaveProperty("replicaIdentity", {
      mode: "index",
      indexName: "index_identity_key",
    });
    expect(parsed.sqlObjects?.find(function findPartition(object) {
      return object.key === "partition:public.partition_identity";
    })).toHaveProperty("replicaIdentity", {
      mode: "index",
      indexName: "partition_identity_pkey",
    });
    expect(parsed.sqlObjects?.find(function findUniquePartition(object) {
      return object.key === "partition:public.partition_unique_identity";
    })).toHaveProperty("replicaIdentity", {
      mode: "index",
      indexName: "partition_unique_identity_key",
    });
  });

  test("rejects duplicate or unbound replica identity declarations", async function () {
    const parser = new SchemaParser();

    await expect(parser.parseSchema(`
      CREATE TABLE public.accounts (id integer);
      ALTER TABLE public.accounts REPLICA IDENTITY FULL;
      ALTER TABLE public.accounts REPLICA IDENTITY NOTHING;
    `)).rejects.toThrow(/replica identity.*declared more than once/i);
    await expect(
      parser.parseSchema(
        "ALTER TABLE public.missing REPLICA IDENTITY FULL;"
      )
    ).rejects.toThrow(/replica identity target.*not found/i);
  });

  test("rejects imperative policy and negative row security mutations", async function () {
    const parser = new SchemaParser();

    await expect(
      parser.parseSchema("ALTER POLICY tenant_policy ON public.users USING (true);")
    ).rejects.toThrow(/ALTER POLICY.*imperative partial mutation/i);
    await expect(
      parser.parseSchema("ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;")
    ).rejects.toThrow(/omit ENABLE ROW LEVEL SECURITY/i);
    await expect(
      parser.parseSchema("ALTER TABLE public.users NO FORCE ROW LEVEL SECURITY;")
    ).rejects.toThrow(/omit FORCE ROW LEVEL SECURITY/i);
  });

  test("preserves complete CREATE POLICY semantics", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE POLICY insert_policy ON public.users
        FOR INSERT TO CURRENT_USER WITH CHECK (tenant_id > 0);
      CREATE POLICY all_policy ON public.users
        AS RESTRICTIVE FOR ALL TO PUBLIC
        USING (tenant_id > 0) WITH CHECK (tenant_id >= 10);
    `);

    expect(parsed.sqlObjects?.map(function mapPolicy(object) {
      return object.policyDefinition;
    })).toEqual([
      {
        command: "insert",
        permissive: true,
        roles: [{ kind: "current_user" }],
        withCheck: "tenant_id > 0",
      },
      {
        command: "all",
        permissive: false,
        roles: [{ kind: "public" }],
        using: "tenant_id > 0",
        withCheck: "tenant_id >= 10",
      },
    ]);
  });

  test("rejects duplicate and command-invalid policy declarations", async function () {
    const parser = new SchemaParser();

    await expect(parser.parseSchema(`
      CREATE POLICY tenant_policy ON public.users USING (true);
      CREATE POLICY tenant_policy ON public.users USING (false);
    `)).rejects.toThrow(/policy .* declared more than once/i);
    await expect(
      parser.parseSchema(
        "CREATE POLICY insert_policy ON public.users FOR INSERT USING (true);"
      )
    ).rejects.toThrow(/INSERT policy.*cannot declare USING/i);
    await expect(
      parser.parseSchema(
        "CREATE POLICY select_policy ON public.users FOR SELECT WITH CHECK (true);"
      )
    ).rejects.toThrow(/SELECT policy.*cannot declare WITH CHECK/i);
    await expect(
      parser.parseSchema(
        "ALTER TABLE public.users ENABLE ROW LEVEL SECURITY, ENABLE ROW LEVEL SECURITY;"
      )
    ).rejects.toThrow(/ENABLE.*declared more than once/i);
    await expect(parser.parseSchema(`
      ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
    `)).rejects.toThrow(/row-level security state.*declared more than once/i);
  });

  test("preserves domain and range semantics in the canonical model", async function () {
    const parser = new SchemaParser();
    const parsed = await parser.parseSchema(`
      CREATE DOMAIN audit.score AS pg_catalog.numeric(10, 2)
        COLLATE pg_catalog."C"
        DEFAULT 1.5
        CONSTRAINT positive CHECK (VALUE > 0)
        NOT NULL;

      CREATE TYPE audit.price_window AS RANGE (
        subtype = pg_catalog.numeric,
        subtype_opclass = pg_catalog.numeric_ops,
        collation = pg_catalog."C",
        canonical = audit.canonical_price,
        subtype_diff = audit.price_diff,
        multirange_type_name = audit.price_windows
      );
    `);

    expect(parsed.sqlObjects).toHaveLength(2);
    expect(parsed.sqlObjects?.[0]).toMatchObject({
      kind: "domain-type",
      key: "domain-type:audit.score",
      typeDefinition: {
        kind: "domain",
        baseType: "NUMERIC(10,2)",
        collation: { schema: "pg_catalog", name: "C" },
        default: "1.5",
        notNull: true,
        constraints: [
          {
            name: "positive",
            expression: "value > 0",
            validated: true,
          },
        ],
      },
    });
    expect(parsed.sqlObjects?.[1]).toMatchObject({
      kind: "range-type",
      key: "range-type:audit.price_window",
      typeDefinition: {
        kind: "range",
        subtype: "NUMERIC",
        subtypeOperatorClass: {
          schema: "pg_catalog",
          name: "numeric_ops",
        },
        collation: { schema: "pg_catalog", name: "C" },
        canonicalFunction: { schema: "audit", name: "canonical_price" },
        subtypeDiffFunction: { schema: "audit", name: "price_diff" },
        multirangeTypeName: { schema: "audit", name: "price_windows" },
      },
    });
  });

  test("rejects duplicate and unsupported domain or range clauses", async function () {
    const parser = new SchemaParser();

    await expect(
      parser.parseSchema(`
        CREATE DOMAIN audit.score AS integer
          CONSTRAINT positive CHECK (VALUE > 0)
          CONSTRAINT positive CHECK (VALUE >= 0);
      `)
    ).rejects.toThrow(/constraint 'positive' more than once/i);
    await expect(
      parser.parseSchema(
        "CREATE DOMAIN audit.score AS integer DEFAULT 1 DEFAULT 2;"
      )
    ).rejects.toThrow(/more than one default/i);
    await expect(
      parser.parseSchema(
        "CREATE TYPE audit.window AS RANGE (subtype = integer, subtype = bigint);"
      )
    ).rejects.toThrow(/option 'subtype' more than once/i);
    await expect(
      parser.parseSchema(
        "CREATE TYPE audit.window AS RANGE (subtype = integer, unknown_option = integer);"
      )
    ).rejects.toThrow(/unsupported option 'unknown_option'/i);
    await expect(
      parser.parseSchema("CREATE TYPE audit.window AS RANGE ();")
    ).rejects.toThrow(/syntax error/i);
  });
});
