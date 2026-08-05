import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { View } from "../../types/schema";
import { ViewHandler } from "../../core/schema/handlers/view-handler";
import { DatabaseInspector } from "../../core/schema/inspector";
import { SchemaParser } from "../../core/schema/parser";
import { generateCreateViewSQL } from "../../utils/sql";
import { getStatementRisk } from "../../utils/statement-classifier";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

const TEST_ROLE = "terradb_view_invoker_reader";

describe("PostgreSQL ordinary view options", function () {
  let client: Client;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    await client.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`);
    await client.query(`CREATE ROLE ${TEST_ROLE} NOLOGIN`);
  });

  afterEach(async function () {
    await client.query("RESET ROLE");
    await cleanDatabase(client);
    await client.query(`DROP OWNED BY ${TEST_ROLE}`);
    await client.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`);
    await client.end();
  });

  async function getServerVersion(): Promise<number> {
    const result = await client.query(
      "SELECT current_setting('server_version_num')::integer AS version"
    );
    return result.rows[0]?.version;
  }

  async function inspectView(name: string): Promise<View> {
    const views = await new DatabaseInspector().getCurrentViews(client, ["public"]);
    const view = views.find(function findView(candidate) {
      return candidate.name === name;
    });
    if (!view) {
      throw new Error(`Missing view public.${name}`);
    }
    return view;
  }

  async function getRelationOid(name: string): Promise<number> {
    const result = await client.query(
      "SELECT $1::regclass::oid::integer AS oid",
      [`public.${name}`]
    );
    return result.rows[0]?.oid;
  }

  async function queryViewAsReader(): Promise<Array<Record<string, unknown>>> {
    await client.query(`SET ROLE ${TEST_ROLE}`);
    try {
      const result = await client.query(
        "SELECT id, payload FROM public.secret_view ORDER BY id"
      );
      return result.rows;
    } finally {
      await client.query("RESET ROLE");
    }
  }

  async function expectReaderPermissionFailure(): Promise<void> {
    await client.query(`SET ROLE ${TEST_ROLE}`);
    try {
      await expect(
        client.query("SELECT id, payload FROM public.secret_view")
      ).rejects.toThrow("permission denied for table secrets");
    } finally {
      await client.query("RESET ROLE");
    }
  }

  test("parses and generates every supported view option", async function () {
    const parsed = await new SchemaParser().parseSchema(`
      CREATE VIEW public.secure_items
      WITH (
        check_option=local,
        security_barrier=off,
        security_invoker=on
      )
      AS SELECT 1 AS id;
    `);
    const view = parsed.views[0];

    expect(view).toMatchObject({
      checkOption: "LOCAL",
      securityBarrier: false,
      securityInvoker: true,
    });
    expect(generateCreateViewSQL(view!)).toBe(
      'CREATE VIEW "public"."secure_items" WITH (security_barrier = false, security_invoker = true) AS SELECT 1 AS id WITH LOCAL CHECK OPTION;'
    );
  });

  test("rejects unknown duplicate and invalid view options during parsing", async function () {
    const parser = new SchemaParser();

    await expect(
      parser.parseSchema(
        "CREATE VIEW public.invalid_view WITH (security_definer=true) AS SELECT 1 AS id;"
      )
    ).rejects.toMatchObject({ code: "PARSER_ERROR" });
    await expect(
      parser.parseSchema(
        "CREATE VIEW public.invalid_view WITH (security_invoker=maybe) AS SELECT 1 AS id;"
      )
    ).rejects.toThrow(
      'PostgreSQL view option "security_invoker" requires a boolean value'
    );
    await expect(
      parser.parseSchema(
        "CREATE VIEW public.invalid_view WITH (check_option=invalid) AS SELECT 1 AS id;"
      )
    ).rejects.toThrow(
      'PostgreSQL view option "check_option" must be LOCAL or CASCADED'
    );
    await expect(
      parser.parseSchema(
        "CREATE VIEW public.invalid_view WITH (security_barrier=true, security_barrier=false) AS SELECT 1 AS id;"
      )
    ).rejects.toThrow(
      'PostgreSQL view option "security_barrier" is specified more than once'
    );
  });

  test("rejects security_invoker without PostgreSQL 15 support", function () {
    const handler = new ViewHandler();
    const desired: View = {
      name: "secure_items",
      schema: "public",
      definition: "SELECT 1 AS id",
      securityInvoker: false,
    };

    function planWithoutVersion(): string[] {
      return handler.generateStatements([desired], []);
    }
    expect(planWithoutVersion).toThrow(
      "without the PostgreSQL server version"
    );

    function planOnPostgres14(): string[] {
      return handler.generateStatements([desired], [], {
        postgresVersionNum: 140000,
      });
    }
    expect(planOnPostgres14).toThrow(
      "PostgreSQL 14 does not support security_invoker views"
    );
  });

  test("changes and resets security_invoker in place", async function () {
    if ((await getServerVersion()) < 150000) {
      const service = createTestSchemaService();
      const unsupportedSchema = `
        CREATE TABLE public.secrets (id integer PRIMARY KEY, payload text);
        CREATE VIEW public.secret_view
        WITH (security_invoker=false)
        AS SELECT id, payload FROM public.secrets;
      `;
      await expect(
        service.plan(unsupportedSchema, ["public"])
      ).rejects.toThrow(
        "PostgreSQL 14 does not support security_invoker views"
      );
      expect(
        (await client.query("SELECT to_regclass('public.secrets') AS relation"))
          .rows[0]?.relation
      ).toBeNull();
      return;
    }

    const initialSchema = `
      CREATE TABLE public.secrets (id integer PRIMARY KEY, payload text);
      CREATE VIEW public.secret_view AS
        SELECT id, payload FROM public.secrets;
      CREATE VIEW public.secret_dependency AS
        SELECT id FROM public.secret_view;
    `;
    const invokerSchema = initialSchema.replace(
      "CREATE VIEW public.secret_view AS",
      "CREATE VIEW public.secret_view WITH (security_barrier=true, security_invoker=true) AS"
    );
    const service = createTestSchemaService();
    await service.apply(initialSchema, ["public"], true);
    await client.query(`
      INSERT INTO public.secrets VALUES (1, 'preserved');
    `);
    const originalOid = await getRelationOid("secret_view");

    const invokerPlan = await service.plan(invokerSchema, ["public"]);
    expect(invokerPlan.transactional).toHaveLength(1);
    expect(invokerPlan.transactional[0]).toBe(
      'ALTER VIEW "public"."secret_view" SET (security_barrier = true, security_invoker = true);'
    );
    await service.apply(invokerSchema, ["public"], true);
    expect(await inspectView("secret_view")).toMatchObject({
      securityBarrier: true,
      securityInvoker: true,
    });
    expect(await getRelationOid("secret_view")).toBe(originalOid);
    expect(
      await client.query("SELECT * FROM public.secret_dependency")
    ).toMatchObject({ rows: [{ id: 1 }] });
    expect((await service.plan(invokerSchema, ["public"])).hasChanges).toBe(false);

    const resetPlan = await service.plan(initialSchema, ["public"]);
    expect(resetPlan.transactional).toHaveLength(1);
    expect(resetPlan.transactional[0]).toBe(
      'ALTER VIEW "public"."secret_view" RESET (security_barrier, security_invoker);'
    );
    expect(
      getStatementRisk(resetPlan.transactional[0]!, "transactional")
    ).toBe("destructive");
    await expect(
      service.apply(initialSchema, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({ code: "STRICT_MODE_ERROR" });
    expect(await inspectView("secret_view")).toMatchObject({
      securityBarrier: true,
      securityInvoker: true,
    });
    expect(await getRelationOid("secret_view")).toBe(originalOid);

    await service.apply(initialSchema, ["public"], true);
    const resetView = await inspectView("secret_view");
    expect(resetView.securityBarrier).toBeUndefined();
    expect(resetView.securityInvoker).toBeUndefined();
    expect(await getRelationOid("secret_view")).toBe(originalOid);
    expect(await client.query("SELECT * FROM public.secret_view")).toMatchObject({
      rows: [{ id: 1, payload: "preserved" }],
    });
    expect((await service.plan(initialSchema, ["public"])).hasChanges).toBe(false);
  });

  test("blocks removal of view enforcement options before changing the query", async function () {
    const supportsSecurityInvoker = (await getServerVersion()) >= 150000;
    const securityInvokerOption = supportsSecurityInvoker
      ? ", security_invoker=true"
      : "";
    const initialSchema = `
      CREATE TABLE public.guarded_base (
        id integer PRIMARY KEY,
        active boolean NOT NULL
      );
      CREATE VIEW public.guarded_items
      WITH (security_barrier=true${securityInvokerOption})
      AS SELECT id, active FROM public.guarded_base WHERE active
      WITH CASCADED CHECK OPTION;
    `;
    const weakenedSchema = `
      CREATE TABLE public.guarded_base (
        id integer PRIMARY KEY,
        active boolean NOT NULL
      );
      CREATE VIEW public.guarded_items AS
        SELECT id, active
        FROM public.guarded_base
        WHERE active AND id > 0;
    `;
    const service = createTestSchemaService();
    await service.apply(initialSchema, ["public"], true);
    await client.query(
      "INSERT INTO public.guarded_items (id, active) VALUES (1, true)"
    );
    await expect(
      client.query(
        "INSERT INTO public.guarded_items (id, active) VALUES (2, false)"
      )
    ).rejects.toThrow();
    const oidBeforeWeakening = await getRelationOid("guarded_items");
    const viewBeforeWeakening = await inspectView("guarded_items");

    const weakeningPlan = await service.plan(weakenedSchema, ["public"]);
    const resetStatement = weakeningPlan.transactional.find(
      function findOptionReset(statement) {
        return statement.includes("ALTER VIEW") && statement.includes("RESET");
      }
    );
    expect(resetStatement).toBe(
      supportsSecurityInvoker
        ? 'ALTER VIEW "public"."guarded_items" RESET (check_option, security_barrier, security_invoker);'
        : 'ALTER VIEW "public"."guarded_items" RESET (check_option, security_barrier);'
    );
    expect(getStatementRisk(resetStatement!, "transactional")).toBe(
      "destructive"
    );
    await expect(
      service.apply(weakenedSchema, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({ code: "STRICT_MODE_ERROR" });
    expect(await getRelationOid("guarded_items")).toBe(oidBeforeWeakening);
    expect(await inspectView("guarded_items")).toEqual(viewBeforeWeakening);
    expect((await client.query(
      "SELECT id, active FROM public.guarded_base ORDER BY id"
    )).rows).toEqual([{ id: 1, active: true }]);
    await expect(
      client.query(
        "INSERT INTO public.guarded_items (id, active) VALUES (2, false)"
      )
    ).rejects.toThrow();

    await service.apply(weakenedSchema, ["public"], true);
    const weakenedView = await inspectView("guarded_items");
    expect(weakenedView.checkOption).toBeUndefined();
    expect(weakenedView.securityBarrier).toBeUndefined();
    expect(weakenedView.securityInvoker).toBeUndefined();
    expect(await getRelationOid("guarded_items")).toBe(oidBeforeWeakening);
    await client.query(
      "INSERT INTO public.guarded_items (id, active) VALUES (2, false)"
    );
    expect((await client.query(
      "SELECT id, active FROM public.guarded_base ORDER BY id"
    )).rows).toEqual([
      { id: 1, active: true },
      { id: 2, active: false },
    ]);
    expect((await service.plan(weakenedSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("blocks explicit security downgrades and cascaded-to-local checks", async function () {
    const supportsSecurityInvoker = (await getServerVersion()) >= 150000;
    const initialInvokerOption = supportsSecurityInvoker
      ? ", security_invoker=true"
      : "";
    const weakenedInvokerOption = supportsSecurityInvoker
      ? ", security_invoker=false"
      : "";
    const initialSchema = `
      CREATE TABLE public.option_guard (
        id integer PRIMARY KEY,
        active boolean NOT NULL
      );
      CREATE VIEW public.option_guard_view
      WITH (security_barrier=true${initialInvokerOption})
      AS SELECT id, active FROM public.option_guard WHERE active
      WITH CASCADED CHECK OPTION;
    `;
    const weakenedSchema = `
      CREATE TABLE public.option_guard (
        id integer PRIMARY KEY,
        active boolean NOT NULL
      );
      CREATE VIEW public.option_guard_view
      WITH (security_barrier=false${weakenedInvokerOption})
      AS SELECT id, active FROM public.option_guard WHERE active
      WITH LOCAL CHECK OPTION;
    `;
    const service = createTestSchemaService();
    await service.apply(initialSchema, ["public"], true);
    await client.query(
      "INSERT INTO public.option_guard VALUES (1, true)"
    );
    const oidBeforeWeakening = await getRelationOid("option_guard_view");
    const viewBeforeWeakening = await inspectView("option_guard_view");

    const weakeningPlan = await service.plan(weakenedSchema, ["public"]);
    expect(weakeningPlan.transactional).toEqual(
      supportsSecurityInvoker
        ? [
            'ALTER VIEW "public"."option_guard_view" RESET (check_option);',
            'ALTER VIEW "public"."option_guard_view" SET (check_option = local, security_barrier = false, security_invoker = false);',
          ]
        : [
            'ALTER VIEW "public"."option_guard_view" RESET (check_option);',
            'ALTER VIEW "public"."option_guard_view" SET (check_option = local, security_barrier = false);',
          ]
    );
    for (const statement of weakeningPlan.transactional) {
      expect(getStatementRisk(statement, "transactional")).toBe(
        "destructive"
      );
    }
    await expect(
      service.apply(weakenedSchema, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({ code: "STRICT_MODE_ERROR" });
    expect(await getRelationOid("option_guard_view")).toBe(oidBeforeWeakening);
    expect(await inspectView("option_guard_view")).toEqual(viewBeforeWeakening);
    expect((await client.query(
      "SELECT id, active FROM public.option_guard ORDER BY id"
    )).rows).toEqual([{ id: 1, active: true }]);

    await service.apply(weakenedSchema, ["public"], true);
    const weakenedView = await inspectView("option_guard_view");
    expect(weakenedView).toMatchObject({
      checkOption: "LOCAL",
      securityBarrier: false,
    });
    if (supportsSecurityInvoker) {
      expect(weakenedView.securityInvoker).toBe(false);
    } else {
      expect(weakenedView.securityInvoker).toBeUndefined();
    }
    expect(await getRelationOid("option_guard_view")).toBe(oidBeforeWeakening);
    expect((await client.query(
      "SELECT id, active FROM public.option_guard ORDER BY id"
    )).rows).toEqual([{ id: 1, active: true }]);
    expect((await service.plan(weakenedSchema, ["public"])).hasChanges).toBe(
      false
    );
  });

  test("enforces the security_invoker privilege model", async function () {
    if ((await getServerVersion()) < 150000) {
      return;
    }

    await client.query(`
      CREATE TABLE public.secrets (id integer PRIMARY KEY, payload text);
      INSERT INTO public.secrets VALUES (1, 'protected');
      CREATE VIEW public.secret_view AS
        SELECT id, payload FROM public.secrets;
      GRANT USAGE ON SCHEMA public TO ${TEST_ROLE};
      GRANT SELECT ON public.secret_view TO ${TEST_ROLE};
    `);
    expect(await queryViewAsReader()).toEqual([
      { id: 1, payload: "protected" },
    ]);

    await client.query(`
      CREATE OR REPLACE VIEW public.secret_view
      WITH (security_invoker=true)
      AS SELECT id, payload FROM public.secrets
    `);
    await expectReaderPermissionFailure();

    await client.query(`GRANT SELECT ON public.secrets TO ${TEST_ROLE}`);
    expect(await queryViewAsReader()).toEqual([
      { id: 1, payload: "protected" },
    ]);
  });

  test("converges option and trailing check-option syntax from an external view", async function () {
    if ((await getServerVersion()) < 150000) {
      return;
    }

    await client.query(`
      CREATE TABLE public.items (id integer PRIMARY KEY, active boolean NOT NULL);
      CREATE VIEW public.secure_items
      WITH (
        check_option=local,
        security_barrier=true,
        security_invoker=true
      )
      AS SELECT id, active FROM public.items WHERE active;
      CREATE VIEW public.explicit_default_items
      WITH (security_barrier=false, security_invoker=false)
      AS SELECT id FROM public.items;
    `);
    const schema = `
      CREATE TABLE public.items (id integer PRIMARY KEY, active boolean NOT NULL);
      CREATE VIEW public.secure_items
      WITH (security_invoker=on, security_barrier=on)
      AS SELECT id, active FROM public.items WHERE active
      WITH LOCAL CHECK OPTION;
      CREATE VIEW public.explicit_default_items AS
        SELECT id FROM public.items;
    `;
    const view = await inspectView("secure_items");
    expect(view).toMatchObject({
      checkOption: "LOCAL",
      securityBarrier: true,
      securityInvoker: true,
    });
    expect(await inspectView("explicit_default_items")).toMatchObject({
      securityBarrier: false,
      securityInvoker: false,
    });
    expect(
      (await createTestSchemaService().plan(schema, ["public"])).hasChanges
    ).toBe(false);
  });

  test("rolls back a security option change when a later view fails", async function () {
    if ((await getServerVersion()) < 150000) {
      return;
    }

    const initialSchema = `
      CREATE TABLE public.secrets (id integer PRIMARY KEY, payload text);
      CREATE VIEW public.secret_view AS
        SELECT id, payload FROM public.secrets;
    `;
    const failingSchema = `${initialSchema.replace(
      "CREATE VIEW public.secret_view AS",
      "CREATE VIEW public.secret_view WITH (security_invoker=true) AS"
    )}
      CREATE VIEW public.invalid_view AS
        SELECT missing_column FROM public.secrets;
    `;
    const service = createTestSchemaService();
    await service.apply(initialSchema, ["public"], true);

    await expect(
      service.apply(failingSchema, ["public"], true)
    ).rejects.toThrow('column "missing_column" does not exist');
    expect((await inspectView("secret_view")).securityInvoker).toBeUndefined();
    expect((await service.plan(initialSchema, ["public"])).hasChanges).toBe(false);
  });
});
