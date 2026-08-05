import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "../utils";

describe("PostgreSQL table persistence", function () {
  let client: Client;
  const services = createColumnTestServices();

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  async function planSchema(schema: string): Promise<MigrationPlan> {
    const current = await services.inspector.getCurrentSchema(client);
    const desired = await services.parser.parseSchema(schema);
    return services.differ.generateMigrationPlan(desired.tables, current);
  }

  async function getRelationPersistence(
    relationNames: string[]
  ): Promise<Record<string, string>> {
    const result = await client.query(
      `
        SELECT c.relname, c.relpersistence
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ANY($1::text[])
        ORDER BY c.relname
      `,
      [relationNames]
    );
    return Object.fromEntries(
      result.rows.map(function mapPersistence(row) {
        return [row.relname, row.relpersistence];
      })
    );
  }

  test("parses and renders unlogged persistence", async function () {
    const desired = await services.parser.parseSchema(`
      CREATE TABLE public.permanent_table (id integer);
      CREATE UNLOGGED TABLE public.unlogged_table (id integer);
    `);

    expect(
      desired.tables.find(function findPermanent(table) {
        return table.name === "permanent_table";
      })?.unlogged
    ).toBeUndefined();
    expect(
      desired.tables.find(function findUnlogged(table) {
        return table.name === "unlogged_table";
      })?.unlogged
    ).toBe(true);

    const sql = services.differ
      .generateMigrationPlan(desired.tables, [])
      .transactional.join("\n");
    expect(sql).toContain('CREATE TABLE "public"."permanent_table"');
    expect(sql).toContain('CREATE UNLOGGED TABLE "public"."unlogged_table"');
  });

  test("rejects unlogged partition hierarchy definitions before planning", async function () {
    const cases = [
      `
        CREATE UNLOGGED TABLE public.unlogged_partition_parent (
          id integer
        ) PARTITION BY RANGE (id);
      `,
      `
        CREATE TABLE public.logged_partition_parent (
          id integer
        ) PARTITION BY RANGE (id);
        CREATE UNLOGGED TABLE public.unlogged_partition_child
          PARTITION OF public.logged_partition_parent
          FOR VALUES FROM (0) TO (100);
      `,
    ];

    for (const schema of cases) {
      await expect(
        services.parser.parseSchema(schema, "unlogged-partition.sql")
      ).rejects.toMatchObject({
        code: "PARSER_ERROR",
        filePath: "unlogged-partition.sql",
        message: expect.stringContaining("UNLOGGED partition hierarchies"),
      });
    }
  });

  test("rejects unlogged partitions before applying surrounding DDL", async function () {
    const schema = `
      CREATE TABLE public.persistence_before (id integer PRIMARY KEY);
      CREATE UNLOGGED TABLE public.persistence_partitioned (
        id integer
      ) PARTITION BY RANGE (id);
      CREATE TABLE public.persistence_after (id integer PRIMARY KEY);
    `;

    await expect(
      createTestSchemaService().apply(schema, ["public"], true)
    ).rejects.toMatchObject({
      code: "PARSER_ERROR",
      message: expect.stringContaining("UNLOGGED partition hierarchies"),
    });

    const relations = await client.query(`
      SELECT
        to_regclass('public.persistence_before') AS before,
        to_regclass('public.persistence_partitioned') AS partitioned,
        to_regclass('public.persistence_after') AS after
    `);
    expect(relations.rows[0]).toEqual({
      before: null,
      partitioned: null,
      after: null,
    });
  });

  test("rejects external unlogged partition hierarchy state", async function () {
    const versionResult = await client.query(
      "SELECT current_setting('server_version_num')::integer AS version"
    );
    if (Number(versionResult.rows[0]?.version) >= 180000) {
      return;
    }

    const schemaService = createTestSchemaService();
    await client.query(`
      CREATE UNLOGGED TABLE public.external_unlogged_parent (id integer)
        PARTITION BY RANGE (id);
      CREATE TABLE public.external_logged_child
        PARTITION OF public.external_unlogged_parent
        FOR VALUES FROM (0) TO (100);
    `);
    await expect(
      schemaService.plan("", ["public"])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("external_unlogged_parent"),
    });

    expect(
      (
        await client.query(`
          SELECT relpersistence
          FROM pg_class
          WHERE oid = 'public.external_unlogged_parent'::regclass
        `)
      ).rows[0]?.relpersistence
    ).toBe("u");

    await client.query(`
      DROP TABLE public.external_unlogged_parent;
      CREATE TABLE public.external_logged_parent (id integer)
        PARTITION BY RANGE (id);
      CREATE UNLOGGED TABLE public.external_unlogged_child
        PARTITION OF public.external_logged_parent
        FOR VALUES FROM (0) TO (100);
    `);
    await expect(
      schemaService.plan("", ["public"])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("external_unlogged_child"),
    });
  });

  test("converges partition syntax and preserves rows when changing a bound", async function () {
    const schemaService = createTestSchemaService();
    const initialSchema = `
      CREATE TABLE partition_accounts (
        id integer NOT NULL,
        region_id integer NOT NULL
      ) PARTITION BY RANGE (region_id);
      CREATE TABLE partition_accounts_eu
        PARTITION OF partition_accounts
        FOR VALUES FROM (0) TO (100);
    `;

    await schemaService.apply(initialSchema, ["public"], true);
    await client.query(
      "INSERT INTO public.partition_accounts (id, region_id) VALUES (1, 80)"
    );

    expect((await schemaService.plan(initialSchema, ["public"])).hasChanges).toBe(false);

    const expandedSchema = initialSchema.replace("TO (100)", "TO (200)");
    const expandedPlan = await schemaService.plan(expandedSchema, ["public"]);
    const detachIndex = expandedPlan.transactional.findIndex(function (statement) {
      return statement.includes("DETACH PARTITION");
    });
    const attachIndex = expandedPlan.transactional.findIndex(function (statement) {
      return statement.includes("ATTACH PARTITION");
    });

    expect(detachIndex).toBeGreaterThanOrEqual(0);
    expect(attachIndex).toBeGreaterThan(detachIndex);
    expect(expandedPlan.transactional.join("\n")).not.toContain("DROP TABLE");
    await schemaService.apply(
      expandedSchema,
      ["public"],
      true,
      undefined,
      false,
      true
    );

    expect(
      (await client.query("SELECT * FROM public.partition_accounts")).rows
    ).toEqual([{ id: 1, region_id: 80 }]);
    expect((await schemaService.plan(expandedSchema, ["public"])).hasChanges).toBe(false);

    const unsupportedParentChange = expandedSchema.replace(
      "PARTITION BY RANGE",
      "PARTITION BY LIST"
    );
    await expect(
      schemaService.apply(unsupportedParentChange, ["public"], true)
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("could lose data"),
    });
    expect((await schemaService.plan(expandedSchema, ["public"])).hasChanges).toBe(false);

    const invalidNarrowing = expandedSchema.replace("TO (200)", "TO (50)");
    await expect(
      schemaService.apply(invalidNarrowing, ["public"], true)
    ).rejects.toThrow();

    expect(
      (await client.query("SELECT * FROM public.partition_accounts")).rows
    ).toEqual([{ id: 1, region_id: 80 }]);
    expect((await schemaService.plan(expandedSchema, ["public"])).hasChanges).toBe(false);
  });

  test("converges supported parent columns and inherited constraints", async function () {
    const schemaService = createTestSchemaService();
    const schema = `
      CREATE TABLE public.constrained_partition_parent (
        id integer NOT NULL DEFAULT 7,
        bucket integer NOT NULL,
        payload text,
        CONSTRAINT constrained_partition_parent_positive CHECK (id > 0),
        CONSTRAINT constrained_partition_parent_pkey PRIMARY KEY (id, bucket)
      ) PARTITION BY RANGE (bucket);
      CREATE TABLE public.constrained_partition_child
        PARTITION OF public.constrained_partition_parent
        FOR VALUES FROM (0) TO (100);
    `;

    await schemaService.apply(schema, ["public"], true);
    await client.query(`
      INSERT INTO public.constrained_partition_child (bucket, payload)
      VALUES (1, 'preserved')
    `);

    expect((await schemaService.plan(schema, ["public"])).hasChanges).toBe(false);
    expect(
      (
        await client.query(`
          SELECT id, bucket, payload
          FROM public.constrained_partition_child
        `)
      ).rows
    ).toEqual([{ id: 7, bucket: 1, payload: "preserved" }]);
  });

  test("converges PostgreSQL-normalized partition parent columns", async function () {
    const schemaService = createTestSchemaService();
    const schema = `
      CREATE TABLE public.semantic_partition_parent (
        id integer GENERATED BY DEFAULT AS IDENTITY
          (START WITH 7 INCREMENT BY 3 CACHE 5),
        bucket integer NULL,
        payload text COLLATE "C" DEFAULT 'hello',
        created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
        doubled integer GENERATED ALWAYS AS (bucket * 2) STORED,
        CONSTRAINT semantic_partition_positive CHECK (bucket >= 0),
        CONSTRAINT semantic_partition_unique UNIQUE (id, bucket)
      ) PARTITION BY RANGE (bucket);
      CREATE TABLE public.semantic_partition_child
        PARTITION OF public.semantic_partition_parent
        FOR VALUES FROM (0) TO (100);
    `;

    await schemaService.apply(schema, ["public"], true);
    await client.query(`
      INSERT INTO public.semantic_partition_parent (bucket)
      VALUES (4)
    `);

    expect((await schemaService.plan(schema, ["public"])).hasChanges).toBe(false);
    expect(
      (
        await client.query(`
          SELECT id, bucket, payload, doubled, created_at IS NOT NULL AS has_created_at
          FROM public.semantic_partition_parent
        `)
      ).rows
    ).toEqual([
      {
        id: 7,
        bucket: 4,
        payload: "hello",
        doubled: 8,
        has_created_at: true,
      },
    ]);
  });

  test("converges reconstructed partition key semantics", async function () {
    const schemaService = createTestSchemaService();
    const schema = `
      CREATE TABLE public.expression_partition_parent (
        payload text NOT NULL
      ) PARTITION BY RANGE ((pg_catalog.lower(payload)));
      CREATE TABLE public.expression_partition_child
        PARTITION OF public.expression_partition_parent
        FOR VALUES FROM ('a') TO ('m');

      CREATE TABLE public.function_cast_partition_parent (
        payload text NOT NULL
      ) PARTITION BY RANGE (((pg_catalog.lower(payload))::text));
      CREATE TABLE public.function_cast_partition_child
        PARTITION OF public.function_cast_partition_parent
        FOR VALUES FROM ('a') TO ('m');

      CREATE TABLE public.cast_partition_parent (
        payload text NOT NULL
      ) PARTITION BY RANGE ((payload::text));
      CREATE TABLE public.cast_partition_child
        PARTITION OF public.cast_partition_parent
        FOR VALUES FROM ('a') TO ('m');

      CREATE TABLE public.opclass_partition_parent (
        payload text NOT NULL
      ) PARTITION BY RANGE (payload pg_catalog.text_ops);
      CREATE TABLE public.opclass_partition_child
        PARTITION OF public.opclass_partition_parent
        FOR VALUES FROM ('a') TO ('m');
    `;

    await schemaService.apply(schema, ["public"], true);
    await client.query(`
      INSERT INTO public.expression_partition_parent VALUES ('Bravo');
      INSERT INTO public.function_cast_partition_parent VALUES ('Bravo');
      INSERT INTO public.cast_partition_parent VALUES ('bravo');
      INSERT INTO public.opclass_partition_parent VALUES ('bravo');
    `);

    expect((await schemaService.plan(schema, ["public"])).hasChanges).toBe(false);
    expect(
      (
        await client.query(`
          SELECT relname, pg_get_partkeydef(oid) AS key
          FROM pg_class
          WHERE relname IN (
            'expression_partition_parent',
            'function_cast_partition_parent',
            'cast_partition_parent',
            'opclass_partition_parent'
          )
          ORDER BY relname
        `)
      ).rows
    ).toEqual([
      { relname: "cast_partition_parent", key: "RANGE (payload)" },
      {
        relname: "expression_partition_parent",
        key: "RANGE (lower(payload))",
      },
      {
        relname: "function_cast_partition_parent",
        key: "RANGE (lower(payload))",
      },
      { relname: "opclass_partition_parent", key: "RANGE (payload)" },
    ]);
  });

  test("detects external partition operator class changes", async function () {
    const schemaService = createTestSchemaService();
    await client.query(`
      CREATE TABLE public.external_opclass_partition (
        payload text NOT NULL
      ) PARTITION BY RANGE (payload text_pattern_ops)
    `);

    const matchingSchema = `
      CREATE TABLE public.external_opclass_partition (
        payload text NOT NULL
      ) PARTITION BY RANGE (payload pg_catalog.text_pattern_ops);
    `;
    expect(
      (await schemaService.plan(matchingSchema, ["public"])).hasChanges
    ).toBe(false);

    const defaultSchema = matchingSchema.replace(
      "payload pg_catalog.text_pattern_ops",
      "payload"
    );
    await expect(
      schemaService.plan(defaultSchema, ["public"])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("could lose data"),
    });
    expect(
      (
        await client.query(
          "SELECT pg_get_partkeydef('public.external_opclass_partition'::regclass) AS key"
        )
      ).rows[0]?.key
    ).toBe("RANGE (payload text_pattern_ops)");
  });

  test("converges canonical literal partition bounds", async function () {
    const schemaService = createTestSchemaService();
    const cases = [
      ["date", "'2024-01-01'", "'2024-02-01'"],
      ["timestamp", "'2024-01-01 00:00:00'", "'2024-02-01 00:00:00'"],
      ["timestamptz", "'2024-01-01 00:00:00+00'", "'2024-02-01 00:00:00+00'"],
      ["numeric", "1.25", "2.50"],
      [
        "uuid",
        "'00000000-0000-0000-0000-000000000001'",
        "'00000000-0000-0000-0000-000000000010'",
      ],
      ["inet", "'192.168.1.1'", "'192.168.1.10'"],
      ["interval", "'1 day'", "'2 days'"],
    ] as const;

    for (const [type, lower, upper] of cases) {
      await cleanDatabase(client);
      const schema = `
        CREATE TABLE public.literal_bound_parent (
          value ${type}
        ) PARTITION BY RANGE (value);
        CREATE TABLE public.literal_bound_child
          PARTITION OF public.literal_bound_parent
          FOR VALUES FROM (${lower}) TO (${upper});
      `;

      await schemaService.apply(schema, ["public"], true);
      expect((await schemaService.plan(schema, ["public"])).hasChanges).toBe(false);
    }
  });

  test("converges sentinel, null, hash, and default partition bounds", async function () {
    const schema = `
      CREATE TABLE public.range_bound_parent (value integer)
        PARTITION BY RANGE (value);
      CREATE TABLE public.range_bound_lower
        PARTITION OF public.range_bound_parent
        FOR VALUES FROM (MINVALUE) TO (-1);
      CREATE TABLE public.range_bound_upper
        PARTITION OF public.range_bound_parent
        FOR VALUES FROM (-1) TO (MAXVALUE);

      CREATE TABLE public.list_bound_parent (value text)
        PARTITION BY LIST (value);
      CREATE TABLE public.list_bound_child
        PARTITION OF public.list_bound_parent
        FOR VALUES IN (NULL, 'a', 'b');

      CREATE TABLE public.hash_bound_parent (value integer)
        PARTITION BY HASH (value);
      CREATE TABLE public.hash_bound_child
        PARTITION OF public.hash_bound_parent
        FOR VALUES WITH (MODULUS 4, REMAINDER 0);

      CREATE TABLE public.default_bound_parent (value integer)
        PARTITION BY RANGE (value);
      CREATE TABLE public.default_bound_child
        PARTITION OF public.default_bound_parent DEFAULT;
    `;
    const schemaService = createTestSchemaService();

    await schemaService.apply(schema, ["public"], true);

    expect((await schemaService.plan(schema, ["public"])).hasChanges).toBe(false);
  });

  test("creates, inspects, and reapplies an unlogged table", async function () {
    const schema = `
      CREATE UNLOGGED TABLE public.persistence_create (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        payload text NOT NULL UNIQUE
      );
    `;

    const first = await planSchema(schema);
    expect(first.transactional.join("\n")).toContain(
      'CREATE UNLOGGED TABLE "public"."persistence_create"'
    );
    await services.executor.executePlan(client, first, true);

    const current = await services.inspector.getCurrentSchema(client);
    expect(
      current.find(function findTable(table) {
        return table.name === "persistence_create";
      })?.unlogged
    ).toBe(true);
    expect(
      await getRelationPersistence([
        "persistence_create",
        "persistence_create_pkey",
        "persistence_create_payload_unique",
      ])
    ).toEqual({
      persistence_create: "u",
      persistence_create_payload_unique: "u",
      persistence_create_pkey: "u",
    });
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("converts a populated logged table with other alterations", async function () {
    await client.query(`
      CREATE TABLE public.persistence_change (
        id integer PRIMARY KEY,
        payload text NOT NULL
      );
      INSERT INTO public.persistence_change VALUES (1, 'preserved');
    `);
    const schema = `
      CREATE UNLOGGED TABLE public.persistence_change (
        id integer PRIMARY KEY,
        payload text NOT NULL,
        added integer DEFAULT 7
      );
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain("SET UNLOGGED");
    expect(sql).toContain('ADD COLUMN "added" INT4 DEFAULT 7');
    expect(sql).not.toMatch(/DROP (?:TABLE|COLUMN)/);
    await services.executor.executePlan(client, plan, true);

    expect(
      (
        await client.query(
          "SELECT id, payload, added FROM public.persistence_change"
        )
      ).rows
    ).toEqual([{ id: 1, payload: "preserved", added: 7 }]);
    expect(
      await getRelationPersistence([
        "persistence_change",
        "persistence_change_pkey",
      ])
    ).toEqual({
      persistence_change: "u",
      persistence_change_pkey: "u",
    });
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("blocks weakening table durability in strict mode", async function () {
    const service = createTestSchemaService();
    const logged = `
      CREATE TABLE public.persistence_strict (
        id integer PRIMARY KEY,
        payload text NOT NULL
      );
    `;
    const unlogged = logged.replace("CREATE TABLE", "CREATE UNLOGGED TABLE");

    await service.apply(logged, ["public"], true);
    await client.query(
      "INSERT INTO public.persistence_strict VALUES (1, 'preserved')"
    );
    const plan = await service.plan(unlogged, ["public"]);
    expect(plan.transactional).toEqual([
      'ALTER TABLE "public"."persistence_strict" SET UNLOGGED;',
    ]);

    await expect(
      service.apply(unlogged, ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: plan.transactional,
    });

    expect(await getRelationPersistence(["persistence_strict"])).toEqual({
      persistence_strict: "p",
    });
    expect(
      (await client.query("SELECT * FROM public.persistence_strict")).rows
    ).toEqual([{ id: 1, payload: "preserved" }]);
    expect((await service.plan(logged, ["public"])).hasChanges).toBe(false);
  });

  test("converts an unlogged table back to logged without losing data", async function () {
    await client.query(`
      CREATE UNLOGGED TABLE public.persistence_reset (
        id integer PRIMARY KEY,
        payload text NOT NULL
      );
      INSERT INTO public.persistence_reset VALUES (1, 'preserved');
    `);
    const schema = `
      CREATE TABLE public.persistence_reset (
        id integer PRIMARY KEY,
        payload text NOT NULL
      );
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain("SET LOGGED");
    expect(sql).not.toMatch(/DROP (?:TABLE|COLUMN)/);
    await services.executor.executePlan(client, plan, true);

    expect(
      (await client.query("SELECT * FROM public.persistence_reset")).rows
    ).toEqual([{ id: 1, payload: "preserved" }]);
    expect(
      await getRelationPersistence([
        "persistence_reset",
        "persistence_reset_pkey",
      ])
    ).toEqual({
      persistence_reset: "p",
      persistence_reset_pkey: "p",
    });
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("orders foreign-key dependencies for persistence changes", async function () {
    await client.query(`
      CREATE TABLE public.persistence_parent (id integer PRIMARY KEY);
      CREATE TABLE public.persistence_child (
        id integer PRIMARY KEY,
        parent_id integer NOT NULL,
        CONSTRAINT persistence_child_parent_fk
          FOREIGN KEY (parent_id) REFERENCES public.persistence_parent(id)
      );
      INSERT INTO public.persistence_parent VALUES (1);
      INSERT INTO public.persistence_child VALUES (1, 1);
    `);
    const unloggedSchema = `
      CREATE UNLOGGED TABLE public.persistence_parent (
        id integer PRIMARY KEY
      );
      CREATE UNLOGGED TABLE public.persistence_child (
        id integer PRIMARY KEY,
        parent_id integer NOT NULL,
        CONSTRAINT persistence_child_parent_fk
          FOREIGN KEY (parent_id) REFERENCES public.persistence_parent(id)
      );
    `;

    const unloggedPlan = await planSchema(unloggedSchema);
    const unloggedSql = unloggedPlan.transactional.join("\n");
    expect(
      unloggedSql.indexOf('ALTER TABLE "public"."persistence_child"')
    ).toBeLessThan(
      unloggedSql.indexOf('ALTER TABLE "public"."persistence_parent"')
    );
    await services.executor.executePlan(client, unloggedPlan, true);
    expect((await planSchema(unloggedSchema)).hasChanges).toBe(false);

    const loggedSchema = unloggedSchema.replaceAll(
      "CREATE UNLOGGED TABLE",
      "CREATE TABLE"
    );
    const loggedPlan = await planSchema(loggedSchema);
    const loggedSql = loggedPlan.transactional.join("\n");
    expect(
      loggedSql.indexOf('ALTER TABLE "public"."persistence_parent"')
    ).toBeLessThan(
      loggedSql.indexOf('ALTER TABLE "public"."persistence_child"')
    );
    await services.executor.executePlan(client, loggedPlan, true);

    expect(
      (await client.query("SELECT parent_id FROM public.persistence_child")).rows
    ).toEqual([{ parent_id: 1 }]);
    expect((await planSchema(loggedSchema)).hasChanges).toBe(false);
  });

  test("drops removed referencing tables before changing persistence", async function () {
    await client.query(`
      CREATE TABLE public.persistence_drop_parent (id integer PRIMARY KEY);
      CREATE TABLE public.persistence_drop_child (
        id integer PRIMARY KEY,
        parent_id integer REFERENCES public.persistence_drop_parent(id)
      );
    `);
    const schema = `
      CREATE UNLOGGED TABLE public.persistence_drop_parent (
        id integer PRIMARY KEY
      );
    `;

    const plan = await planSchema(schema);
    const sql = plan.transactional.join("\n");
    expect(
      sql.indexOf('DROP TABLE "public"."persistence_drop_child"')
    ).toBeLessThan(
      sql.indexOf('ALTER TABLE "public"."persistence_drop_parent"')
    );
    await services.executor.executePlan(client, plan, true);

    expect(
      await getRelationPersistence(["persistence_drop_parent"])
    ).toEqual({ persistence_drop_parent: "u" });
    expect((await planSchema(schema)).hasChanges).toBe(false);
  });

  test("temporarily detaches circular foreign keys during conversion", async function () {
    await client.query(`
      CREATE TABLE public.persistence_cycle_a (
        id integer PRIMARY KEY,
        b_id integer
      );
      CREATE TABLE public.persistence_cycle_b (
        id integer PRIMARY KEY,
        a_id integer
      );
      ALTER TABLE public.persistence_cycle_a
        ADD CONSTRAINT persistence_cycle_a_b_fk
        FOREIGN KEY (b_id) REFERENCES public.persistence_cycle_b(id);
      ALTER TABLE public.persistence_cycle_b
        ADD CONSTRAINT persistence_cycle_b_a_fk
        FOREIGN KEY (a_id) REFERENCES public.persistence_cycle_a(id);
    `);
    const schema = `
      CREATE UNLOGGED TABLE public.persistence_cycle_a (
        id integer PRIMARY KEY,
        b_id integer,
        CONSTRAINT persistence_cycle_a_b_fk
          FOREIGN KEY (b_id) REFERENCES public.persistence_cycle_b(id)
      );
      CREATE UNLOGGED TABLE public.persistence_cycle_b (
        id integer PRIMARY KEY,
        a_id integer,
        CONSTRAINT persistence_cycle_b_a_fk
          FOREIGN KEY (a_id) REFERENCES public.persistence_cycle_a(id)
      );
    `;

    const plan = await planSchema(schema);
    const statements = plan.transactional;
    const firstPersistence = statements.findIndex(function findPersistence(sql) {
      return sql.includes("SET UNLOGGED");
    });
    const lastPersistence = statements.findLastIndex(function findPersistence(sql) {
      return sql.includes("SET UNLOGGED");
    });
    expect(statements.slice(0, firstPersistence).join("\n")).toContain(
      "DROP CONSTRAINT"
    );
    expect(statements.slice(lastPersistence + 1).join("\n")).toContain(
      "ADD CONSTRAINT"
    );
    await services.executor.executePlan(client, plan, true);

    expect(
      await getRelationPersistence([
        "persistence_cycle_a",
        "persistence_cycle_b",
      ])
    ).toEqual({
      persistence_cycle_a: "u",
      persistence_cycle_b: "u",
    });
    expect((await planSchema(schema)).hasChanges).toBe(false);

    const loggedSchema = schema.replaceAll(
      "CREATE UNLOGGED TABLE",
      "CREATE TABLE"
    );
    await services.executor.executePlan(
      client,
      await planSchema(loggedSchema),
      true
    );
    expect(
      await getRelationPersistence([
        "persistence_cycle_a",
        "persistence_cycle_b",
      ])
    ).toEqual({
      persistence_cycle_a: "p",
      persistence_cycle_b: "p",
    });
    expect((await planSchema(loggedSchema)).hasChanges).toBe(false);
  });
});
