import { describe, expect, test } from "bun:test";
import { SqlObjectHandler } from "../core/schema/handlers/sql-object-handler";
import type {
  PostgresGrantDefinition,
  PostgresRoleDefinition,
  SqlObject,
} from "../types/schema";

function makeSqlObject(overrides: Partial<SqlObject>): SqlObject {
  return {
    kind: "partition",
    key: "partition:public.accounts",
    name: "accounts",
    schema: "public",
    createStatement: 'CREATE TABLE "public"."accounts" (id integer) PARTITION BY RANGE (id);',
    dropStatement: 'DROP TABLE IF EXISTS "public"."accounts" RESTRICT;',
    ...overrides,
  };
}

function makePolicy(overrides: Partial<SqlObject> = {}): SqlObject {
  return makeSqlObject({
    kind: "policy",
    key: "policy:public.accounts.tenant_access",
    name: "tenant_access",
    createStatement:
      "CREATE POLICY tenant_access ON public.accounts FOR UPDATE " +
      "USING (tenant_id > 0);",
    dropStatement:
      'DROP POLICY IF EXISTS "tenant_access" ON "public"."accounts";',
    policyDefinition: {
      command: "update",
      permissive: true,
      roles: [{ kind: "public" }],
      using: "tenant_id > 0",
    },
    ...overrides,
  });
}

function makeRole(
  name: string,
  definition?: PostgresRoleDefinition
): SqlObject {
  return makeSqlObject({
    kind: "role",
    key: `role:${name}`,
    name,
    schema: undefined,
    createStatement: `CREATE ROLE "${name}";`,
    dropStatement: `DROP ROLE IF EXISTS "${name}";`,
    ...(definition ? { roleDefinition: definition } : {}),
  });
}

function makeGrant(
  grantable: boolean,
  overrides: Partial<SqlObject> = {}
): SqlObject {
  const definition: PostgresGrantDefinition = {
    objectType: "TABLE",
    objectName: "accounts",
    schema: "public",
    grantee: "reader",
    granteeIsPublic: false,
    privilege: "SELECT",
    grantable,
    implicitDefault: false,
  };
  return makeSqlObject({
    kind: "grant",
    key: 'grant:GRANT SELECT ON TABLE "public"."accounts" TO "reader";',
    name: 'GRANT SELECT ON TABLE "public"."accounts" TO "reader";',
    createStatement:
      'GRANT SELECT ON TABLE "public"."accounts" TO "reader"' +
      (grantable ? " WITH GRANT OPTION;" : ";"),
    dropStatement:
      'REVOKE SELECT ON TABLE "public"."accounts" FROM "reader" RESTRICT;',
    grantDefinition: definition,
    ...overrides,
  });
}

describe("SqlObjectHandler", function () {
  test("changes privilege grant options without revoking the privilege", async function () {
    const handler = new SqlObjectHandler();

    const upgrade = await handler.generateStatements(
      [makeGrant(true)],
      [makeGrant(false)]
    );
    expect(upgrade.finalCreate).toEqual([
      'GRANT SELECT ON TABLE "public"."accounts" TO "reader" WITH GRANT OPTION;',
    ]);
    expect(upgrade.earlyDrop).toEqual([]);

    const downgrade = await handler.generateStatements(
      [makeGrant(false)],
      [makeGrant(true)]
    );
    expect(downgrade.earlyDrop).toEqual([
      'REVOKE GRANT OPTION FOR SELECT ON TABLE "public"."accounts" FROM "reader" RESTRICT;',
    ]);
    expect(downgrade.finalCreate).toEqual([]);
  });

  test("rejects incomplete and colliding privilege definitions", async function () {
    const handler = new SqlObjectHandler();
    const incomplete = makeGrant(false, { grantDefinition: undefined });

    await expect(
      handler.generateStatements([incomplete], [makeGrant(false)])
    ).rejects.toThrow(/missing its lossless canonical definition/i);
    await expect(
      handler.generateStatements(
        [makePolicy({ key: makeGrant(false).key })],
        [makeGrant(false)]
      )
    ).rejects.toThrow(/collides between grant and policy/i);
  });

  test("orders native role alterations and rejects incomplete state", async function () {
    const handler = new SqlObjectHandler();
    const currentDefinition: PostgresRoleDefinition = {
      login: false,
      superuser: false,
      createDatabase: false,
      createRole: false,
      inherit: true,
      replication: false,
      bypassRowLevelSecurity: false,
      connectionLimit: -1,
    };
    const desiredDefinition = {
      ...currentDefinition,
      login: true,
    };
    const alpha = makeRole("alpha", currentDefinition);
    const zeta = makeRole("zeta", currentDefinition);

    const plan = await handler.generateStatements(
      [
        makeRole("zeta", desiredDefinition),
        makeRole("alpha", desiredDefinition),
      ],
      [zeta, alpha]
    );

    expect(plan.bootstrapCreate).toEqual([
      'ALTER ROLE "alpha" WITH LOGIN;',
      'ALTER ROLE "zeta" WITH LOGIN;',
    ]);
    expect(plan.lateDrop).toEqual([]);
    await expect(
      handler.generateStatements([makeRole("alpha")], [alpha])
    ).rejects.toThrow(/missing its lossless canonical definition/i);
  });

  test("rejects cross-kind SQL object key collisions involving roles", async function () {
    const handler = new SqlObjectHandler();
    const definition: PostgresRoleDefinition = {
      login: false,
      superuser: false,
      createDatabase: false,
      createRole: false,
      inherit: true,
      replication: false,
      bypassRowLevelSecurity: false,
      connectionLimit: -1,
    };
    const role = makeRole("collision", definition);
    const policy = makePolicy({ key: role.key });

    await expect(
      handler.generateStatements([policy], [role])
    ).rejects.toThrow(/collides between role and policy/i);
    await expect(
      handler.generateStatements([role], [policy])
    ).rejects.toThrow(/collides between policy and role/i);
  });

  test("separates partition removals from native foreign-server changes", async function () {
    const handler = new SqlObjectHandler();
    const parent = makeSqlObject({});
    const child = makeSqlObject({
      key: "partition:public.accounts_eu",
      name: "accounts_eu",
      createStatement:
        'CREATE TABLE "public"."accounts_eu" PARTITION OF "public"."accounts" ' +
        "FOR VALUES FROM (0) TO (100);",
      dropStatement:
        'DROP TABLE IF EXISTS "public"."accounts_eu" RESTRICT;',
      dependencies: [parent.key],
    });
    const currentServer = makeSqlObject({
      kind: "foreign-server",
      key: "foreign-server:analytics",
      name: "analytics",
      schema: undefined,
      createStatement:
        "CREATE SERVER analytics FOREIGN DATA WRAPPER postgres_fdw;",
      dropStatement: 'DROP SERVER IF EXISTS "analytics" RESTRICT;',
      dependencies: [],
      foreignServerDefinition: {
        foreignDataWrapper: "postgres_fdw",
        owner: "Current Owner",
        version: "14",
        options: [],
      },
    });
    const desiredServer = {
      ...currentServer,
      createStatement:
        "CREATE SERVER analytics FOREIGN DATA WRAPPER postgres_fdw " +
        "OPTIONS (host '127.0.0.1');",
      foreignServerDefinition: {
        foreignDataWrapper: "postgres_fdw",
        owner: "Desired Owner",
        version: "15'beta",
        options: [{ name: "host", value: "db'host" }],
      },
    };

    const plan = await handler.generateStatements(
      [desiredServer],
      [parent, child, currentServer]
    );

    expect(plan.earlyDrop).toEqual([]);
    expect(plan.partitionDrop).toEqual([
      child.dropStatement,
      parent.dropStatement,
    ]);
    expect(plan.preTableCreate).toEqual([
      'ALTER SERVER "analytics" VERSION \'15\'\'beta\' OPTIONS ' +
        '(ADD "host" \'db\'\'host\');',
      'ALTER SERVER "analytics" OWNER TO "Desired Owner";',
    ]);
    expect(plan.finalCreate).toEqual([]);
  });

  test("orders new foreign server owners after deterministic creation", async function () {
    const handler = new SqlObjectHandler();
    const zeta = makeSqlObject({
      kind: "foreign-server",
      key: "foreign-server:zeta",
      name: "zeta",
      createStatement:
        "CREATE SERVER zeta FOREIGN DATA WRAPPER postgres_fdw;",
      foreignServerDefinition: {
        foreignDataWrapper: "postgres_fdw",
        owner: "Zeta Owner",
        options: [],
      },
    });
    const alpha = makeSqlObject({
      kind: "foreign-server",
      key: "foreign-server:alpha",
      name: "alpha",
      createStatement:
        "CREATE SERVER alpha FOREIGN DATA WRAPPER postgres_fdw;",
      foreignServerDefinition: {
        foreignDataWrapper: "postgres_fdw",
        owner: "Alpha Owner",
        options: [],
      },
    });

    const plan = await handler.generateStatements([zeta, alpha], []);

    expect(plan.preTableCreate).toEqual([
      alpha.createStatement,
      zeta.createStatement,
      'ALTER SERVER "alpha" OWNER TO "Alpha Owner";',
      'ALTER SERVER "zeta" OWNER TO "Zeta Owner";',
    ]);
    expect(plan.finalCreate).toEqual([]);
  });

  test("orders explicit foreign server removals deterministically", async function () {
    const handler = new SqlObjectHandler();
    const alpha = makeSqlObject({
      kind: "foreign-server",
      key: "foreign-server:alpha",
      name: "alpha",
      createStatement:
        "CREATE SERVER alpha FOREIGN DATA WRAPPER postgres_fdw;",
      dropStatement: 'DROP SERVER IF EXISTS "alpha" RESTRICT;',
      foreignServerDefinition: {
        foreignDataWrapper: "postgres_fdw",
        options: [],
      },
    });
    const zeta = makeSqlObject({
      ...alpha,
      key: "foreign-server:zeta",
      name: "zeta",
      createStatement:
        "CREATE SERVER zeta FOREIGN DATA WRAPPER postgres_fdw;",
      dropStatement: 'DROP SERVER IF EXISTS "zeta" RESTRICT;',
    });
    const removeAlpha = {
      ...alpha,
      createStatement: 'DROP SERVER IF EXISTS "alpha" RESTRICT;',
      desiredAbsent: true,
      foreignServerDefinition: undefined,
    };
    const removeZeta = {
      ...zeta,
      createStatement: 'DROP SERVER IF EXISTS "zeta" RESTRICT;',
      desiredAbsent: true,
      foreignServerDefinition: undefined,
    };

    const plan = await handler.generateStatements(
      [removeZeta, removeAlpha],
      [alpha, zeta]
    );

    expect(plan.earlyDrop).toEqual([
      zeta.dropStatement,
      alpha.dropStatement,
    ]);
    expect(plan.preTableCreate).toEqual([]);
  });

  test("separates dependent type drops from unrelated late drops", async function () {
    const handler = new SqlObjectHandler();
    const current = [
      makeSqlObject({
        kind: "domain-type",
        key: "domain-type:public.payload_domain",
        name: "payload_domain",
        createStatement: "CREATE DOMAIN public.payload_domain AS public.payload;",
        dropStatement: "DROP DOMAIN public.payload_domain;",
      }),
      makeSqlObject({
        kind: "range-type",
        key: "range-type:public.payload_range",
        name: "payload_range",
        createStatement:
          "CREATE TYPE public.payload_range AS RANGE (subtype=public.payload);",
        dropStatement: "DROP TYPE public.payload_range;",
      }),
      makeSqlObject({
        kind: "role",
        key: "role:app_owner",
        name: "app_owner",
        schema: undefined,
        createStatement: "CREATE ROLE app_owner;",
        dropStatement: "DROP ROLE app_owner;",
      }),
    ];

    const plan = await handler.generateStatements([], current);

    expect(plan.typeDrop).toEqual([
      "DROP TYPE public.payload_range;",
      "DROP DOMAIN public.payload_domain;",
    ]);
    expect(plan.lateDrop).toEqual(["DROP ROLE app_owner;"]);
  });

  test("changes partition bounds without dropping the partition", async function () {
    const handler = new SqlObjectHandler();
    const desired = [
      makeSqlObject({
        key: "partition:public.accounts_eu",
        name: "accounts_eu",
        createStatement: 'CREATE TABLE "public"."accounts_eu" PARTITION OF "public"."accounts" FOR VALUES FROM (0) TO (100);',
        dropStatement: 'DROP TABLE IF EXISTS "public"."accounts_eu" RESTRICT;',
        dependencies: ["partition:public.accounts"],
      }),
      makeSqlObject({}),
    ];
    const current = [
      makeSqlObject({}),
      makeSqlObject({
        key: "partition:public.accounts_eu",
        name: "accounts_eu",
        createStatement: 'CREATE TABLE "public"."accounts_eu" PARTITION OF "public"."accounts" FOR VALUES FROM (0) TO (50);',
        dropStatement: 'DROP TABLE IF EXISTS "public"."accounts_eu" RESTRICT;',
        dependencies: ["partition:public.accounts"],
      }),
    ];

    const plan = await handler.generateStatements(desired, current);

    expect(plan.preTableCreate).toEqual([
      'ALTER TABLE "public"."accounts" ATTACH PARTITION "public"."accounts_eu" FOR VALUES FROM (0) TO (100);',
    ]);
    expect(plan.earlyDrop).toEqual([
      'ALTER TABLE "public"."accounts" DETACH PARTITION "public"."accounts_eu";',
    ]);
  });

  test("treats equivalent PostgreSQL partition syntax as unchanged", async function () {
    const handler = new SqlObjectHandler();
    const desired = [
      makeSqlObject({
        schema: undefined,
        createStatement: `
          CREATE TABLE accounts (
            id int NOT NULL,
            region_id int NOT NULL
          ) PARTITION BY RANGE (region_id);
        `,
      }),
      makeSqlObject({
        key: "partition:public.accounts_eu",
        name: "accounts_eu",
        schema: undefined,
        createStatement:
          "CREATE TABLE accounts_eu PARTITION OF accounts " +
          "FOR VALUES FROM (0) TO (100);",
        dependencies: ["partition:public.accounts"],
      }),
    ];
    const current = [
      makeSqlObject({
        createStatement: `
          CREATE TABLE "public"."accounts" (
            "id" integer NOT NULL,
            "region_id" integer NOT NULL
          ) PARTITION BY RANGE ("region_id");
        `,
      }),
      makeSqlObject({
        key: "partition:public.accounts_eu",
        name: "accounts_eu",
        createStatement:
          'CREATE TABLE "public"."accounts_eu" PARTITION OF "public"."accounts" ' +
          "FOR VALUES FROM (0) TO (100);",
        dependencies: ["partition:public.accounts"],
      }),
    ];

    const plan = await handler.generateStatements(desired, current);

    expect(plan.preTableCreate).toEqual([]);
    expect(plan.earlyDrop).toEqual([]);
  });

  test("treats reconstructed negative partition literals as unchanged", async function () {
    const handler = new SqlObjectHandler();
    const desired = makeSqlObject({
      key: "partition:public.accounts_negative",
      name: "accounts_negative",
      createStatement:
        "CREATE TABLE public.accounts_negative PARTITION OF public.accounts " +
        "FOR VALUES FROM (MINVALUE) TO (-1);",
      dependencies: ["partition:public.accounts"],
    });
    const current = makeSqlObject({
      key: "partition:public.accounts_negative",
      name: "accounts_negative",
      createStatement:
        'CREATE TABLE "public"."accounts_negative" PARTITION OF "public"."accounts" ' +
        "FOR VALUES FROM (MINVALUE) TO ('-1');",
      dependencies: ["partition:public.accounts"],
    });

    const plan = await handler.generateStatements([desired], [current]);

    expect(plan.preTableCreate).toEqual([]);
    expect(plan.earlyDrop).toEqual([]);
  });

  test("ignores parent table constraint order", async function () {
    const handler = new SqlObjectHandler();
    const desired = makeSqlObject({
      createStatement: `
        CREATE TABLE public.accounts (
          id integer NOT NULL,
          region_id integer NOT NULL,
          CONSTRAINT accounts_positive CHECK (id > 0),
          CONSTRAINT accounts_pkey PRIMARY KEY (id, region_id)
        ) PARTITION BY RANGE (region_id);
      `,
    });
    const current = makeSqlObject({
      createStatement: `
        CREATE TABLE "public"."accounts" (
          "id" integer NOT NULL,
          "region_id" integer NOT NULL,
          CONSTRAINT "accounts_pkey" PRIMARY KEY (id, region_id),
          CONSTRAINT "accounts_positive" CHECK ((id > 0))
        ) PARTITION BY RANGE (region_id);
      `,
    });

    const plan = await handler.generateStatements([desired], [current]);

    expect(plan.preTableCreate).toEqual([]);
    expect(plan.earlyDrop).toEqual([]);
  });

  test("treats database-normalized parent columns as unchanged", async function () {
    const handler = new SqlObjectHandler();
    const desired = makeSqlObject({
      createStatement: `
        CREATE TABLE public.accounts (
          id int GENERATED BY DEFAULT AS IDENTITY
            (START WITH 7 INCREMENT BY 3 CACHE 5),
          region_id int NULL,
          payload text COLLATE "C" DEFAULT 'hello',
          created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
          doubled integer GENERATED ALWAYS AS (region_id * 2) STORED,
          CONSTRAINT accounts_positive CHECK (region_id >= 0),
          CONSTRAINT accounts_unique UNIQUE (id, region_id)
        ) PARTITION BY RANGE (region_id);
      `,
    });
    const current = makeSqlObject({
      createStatement: `
        CREATE TABLE "public"."accounts" (
          "id" integer GENERATED BY DEFAULT AS IDENTITY
            (SEQUENCE NAME "public"."accounts_id_seq" START WITH 7
             INCREMENT BY 3 MINVALUE 1 MAXVALUE 2147483647 CACHE 5 NO CYCLE),
          "region_id" integer,
          "payload" text COLLATE "pg_catalog"."C" DEFAULT 'hello'::text,
          "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
          "doubled" integer GENERATED ALWAYS AS ((region_id * 2)) STORED,
          CONSTRAINT "accounts_unique" UNIQUE (id, region_id),
          CONSTRAINT "accounts_positive" CHECK ((region_id >= 0))
        ) PARTITION BY RANGE (region_id);
      `,
    });

    const plan = await handler.generateStatements([desired], [current]);

    expect(plan.preTableCreate).toEqual([]);
    expect(plan.earlyDrop).toEqual([]);
  });

  test("treats normalized partition key expressions as unchanged", async function () {
    const handler = new SqlObjectHandler();
    const cases = [
      {
        desired:
          "CREATE TABLE public.accounts (payload text) " +
          "PARTITION BY RANGE ((pg_catalog.lower(payload)));",
        current:
          "CREATE TABLE public.accounts (payload text) " +
          "PARTITION BY RANGE (lower(payload));",
      },
      {
        desired:
          "CREATE TABLE public.accounts (payload text) " +
          "PARTITION BY RANGE ((payload::text));",
        current:
          "CREATE TABLE public.accounts (payload text) " +
          "PARTITION BY RANGE (payload);",
      },
      {
        desired:
          "CREATE TABLE public.accounts (payload text) " +
          "PARTITION BY RANGE (((lower(payload))::text));",
        current:
          "CREATE TABLE public.accounts (payload text) " +
          "PARTITION BY RANGE (lower(payload));",
        operatorClasses: [
          {
            name: "text_ops",
            schema: "pg_catalog",
            inputType: { name: "text", schema: "pg_catalog" },
            isDefault: true,
          },
        ],
      },
    ];

    for (const scenario of cases) {
      const plan = await handler.generateStatements(
        [makeSqlObject({ createStatement: scenario.desired })],
        [
          makeSqlObject({
            createStatement: scenario.current,
            ...(scenario.operatorClasses
              ? { partitionKeyOperatorClasses: scenario.operatorClasses }
              : {}),
          }),
        ]
      );
      expect(plan.preTableCreate).toEqual([]);
      expect(plan.earlyDrop).toEqual([]);
    }
  });

  test("compares effective partition key operator classes", async function () {
    const handler = new SqlObjectHandler();
    const currentDefault = makeSqlObject({
      createStatement:
        "CREATE TABLE public.accounts (payload text) " +
        "PARTITION BY RANGE (payload);",
      partitionKeyOperatorClasses: [
        {
          name: "text_ops",
          schema: "pg_catalog",
          inputType: { name: "text", schema: "pg_catalog" },
          isDefault: true,
        },
      ],
    });
    const desiredDefault = makeSqlObject({
      createStatement:
        "CREATE TABLE public.accounts (payload text) " +
        "PARTITION BY RANGE (payload pg_catalog.text_ops);",
    });

    const defaultPlan = await handler.generateStatements(
      [desiredDefault],
      [currentDefault]
    );
    expect(defaultPlan.preTableCreate).toEqual([]);
    expect(defaultPlan.earlyDrop).toEqual([]);

    const currentPattern = makeSqlObject({
      createStatement:
        "CREATE TABLE public.accounts (payload text) " +
        "PARTITION BY RANGE (payload text_pattern_ops);",
      partitionKeyOperatorClasses: [
        {
          name: "text_pattern_ops",
          schema: "pg_catalog",
          inputType: { name: "text", schema: "pg_catalog" },
          isDefault: false,
        },
      ],
    });
    await expect(
      handler.generateStatements(
        [
          makeSqlObject({
            createStatement:
              "CREATE TABLE public.accounts (payload text) " +
              "PARTITION BY RANGE (payload);",
          }),
        ],
        [currentPattern]
      )
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("could lose data"),
    });
  });

  test("rejects meaningful partition key expression changes", async function () {
    const handler = new SqlObjectHandler();
    const current = makeSqlObject({
      createStatement:
        "CREATE TABLE public.accounts (payload text) " +
        "PARTITION BY RANGE (payload);",
      partitionKeyOperatorClasses: [
        {
          name: "text_ops",
          schema: "pg_catalog",
          inputType: { name: "text", schema: "pg_catalog" },
          isDefault: true,
        },
      ],
    });
    const desiredStatements = [
      "CREATE TABLE public.accounts (payload text) " +
        "PARTITION BY RANGE ((payload::varchar(5)));",
      "CREATE TABLE public.accounts (payload text) " +
        "PARTITION BY RANGE ((lower(payload)));",
      "CREATE TABLE public.accounts (payload text) " +
        'PARTITION BY RANGE (payload COLLATE "C");',
      "CREATE TABLE public.accounts (payload text) " +
        "PARTITION BY RANGE (payload text_pattern_ops);",
    ];

    for (const createStatement of desiredStatements) {
      await expect(
        handler.generateStatements(
          [makeSqlObject({ createStatement })],
          [current]
        )
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("could lose data"),
      });
    }
  });

  test("rejects meaningful parent column and constraint changes", async function () {
    const handler = new SqlObjectHandler();
    const current = makeSqlObject({
      createStatement: `
        CREATE TABLE public.accounts (
          id integer GENERATED BY DEFAULT AS IDENTITY (INCREMENT BY 3),
          region_id integer,
          payload text COLLATE "C" DEFAULT 'hello',
          doubled integer GENERATED ALWAYS AS (region_id * 2) STORED,
          CONSTRAINT accounts_positive CHECK (region_id >= 0)
        ) PARTITION BY RANGE (region_id);
      `,
    });
    const desiredStatements = [
      current.createStatement.replace("INCREMENT BY 3", "INCREMENT BY 4"),
      current.createStatement.replace("DEFAULT 'hello'", "DEFAULT 'goodbye'"),
      current.createStatement.replace('COLLATE "C"', 'COLLATE "POSIX"'),
      current.createStatement.replace("region_id * 2", "region_id * 3"),
      current.createStatement.replace("region_id >= 0", "region_id > 0"),
      current.createStatement.replace(
        "CHECK (region_id >= 0)",
        "CHECK (region_id >= 0), CONSTRAINT accounts_upper CHECK (region_id < 100)"
      ),
      current.createStatement.replace(
        "doubled integer",
        "extra integer, doubled integer"
      ),
      current.createStatement.replace("region_id integer", "region_id bigint"),
    ];

    for (const createStatement of desiredStatements) {
      await expect(
        handler.generateStatements(
          [makeSqlObject({ createStatement })],
          [current]
        )
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("could lose data"),
      });
    }
  });

  test("quotes unusual partition identifiers when changing a bound", async function () {
    const handler = new SqlObjectHandler();
    const current = makeSqlObject({
      key: 'partition:tenant "one".accounts "eu"',
      name: 'accounts "eu"',
      schema: 'tenant "one"',
      createStatement:
        'CREATE TABLE "tenant ""one"""."accounts ""eu""" ' +
        'PARTITION OF "tenant ""one"""."accounts parent" ' +
        "FOR VALUES FROM (0) TO (100);",
      dependencies: ['partition:tenant "one".accounts parent'],
    });
    const desired = makeSqlObject({
      key: 'partition:tenant "one".accounts "eu"',
      name: 'accounts "eu"',
      schema: 'tenant "one"',
      createStatement:
        'CREATE TABLE "tenant ""one"""."accounts ""eu""" ' +
        'PARTITION OF "tenant ""one"""."accounts parent" ' +
        "FOR VALUES FROM (0) TO (200);",
      dependencies: ['partition:tenant "one".accounts parent'],
    });

    const plan = await handler.generateStatements([desired], [current]);

    expect(plan.earlyDrop).toEqual([
      'ALTER TABLE "tenant ""one"""."accounts parent" DETACH PARTITION "tenant ""one"""."accounts ""eu""";',
    ]);
    expect(plan.preTableCreate).toEqual([
      'ALTER TABLE "tenant ""one"""."accounts parent" ATTACH PARTITION "tenant ""one"""."accounts ""eu""" FOR VALUES FROM (0) TO (200);',
    ]);
  });

  test("rejects partition replacements that could lose data", async function () {
    const handler = new SqlObjectHandler();
    const current = makeSqlObject({
      createStatement:
        "CREATE TABLE public.accounts (region_id integer NOT NULL) " +
        "PARTITION BY RANGE (region_id);",
    });
    const desired = makeSqlObject({
      createStatement:
        "CREATE TABLE public.accounts (region_id integer NOT NULL) " +
        "PARTITION BY LIST (region_id);",
    });

    await expect(
      handler.generateStatements([desired], [current])
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("could lose data"),
    });
  });

  test("compares policy roles and effective checks semantically", async function () {
    const handler = new SqlObjectHandler();
    const desired = makePolicy({
      createStatement:
        "CREATE POLICY tenant_access ON public.accounts FOR UPDATE " +
        "TO CURRENT_ROLE, SESSION_USER USING (tenant_id = " +
        "current_setting('app.tenant_id')::integer);",
      policyDefinition: {
        command: "update",
        permissive: true,
        roles: [{ kind: "current_role" }, { kind: "session_user" }],
        using:
          "tenant_id = (current_setting('app.tenant_id'))::int",
      },
    });
    const current = makePolicy({
      createStatement:
        'CREATE POLICY "tenant_access" ON "public"."accounts" AS PERMISSIVE ' +
        "FOR UPDATE TO \"test_user\" USING " +
        "((tenant_id = current_setting('app.tenant_id'::text)::integer)) " +
        "WITH CHECK ((tenant_id = " +
        "current_setting('app.tenant_id'::text)::integer));",
      policyDefinition: {
        command: "update",
        permissive: true,
        roles: [{ kind: "name", name: "test_user" }],
        using:
          "(tenant_id = (current_setting('app.tenant_id'::text))::integer)",
        withCheck:
          "(tenant_id = (current_setting('app.tenant_id'::text))::integer)",
      },
    });

    const plan = await handler.generateStatements([desired], [current], {
      currentUser: "test_user",
      sessionUser: "test_user",
    });

    expect(plan.earlyDrop).toEqual([]);
    expect(plan.postRoutineCreate).toEqual([]);
  });

  test("treats PUBLIC as the complete policy audience", async function () {
    const handler = new SqlObjectHandler();
    const desired = makePolicy({
      createStatement:
        "CREATE POLICY tenant_access ON public.accounts TO PUBLIC, app_user " +
        "USING (tenant_id > 0);",
      policyDefinition: {
        command: "update",
        permissive: true,
        roles: [{ kind: "public" }, { kind: "name", name: "app_user" }],
        using: "tenant_id > 0",
      },
    });

    const plan = await handler.generateStatements([desired], [makePolicy()]);

    expect(plan.earlyDrop).toEqual([]);
    expect(plan.postRoutineCreate).toEqual([]);
  });

  test("normalizes omitted policy predicates to true", async function () {
    const handler = new SqlObjectHandler();
    const desired = makePolicy({
      createStatement:
        "CREATE POLICY tenant_access ON public.accounts FOR UPDATE TO PUBLIC;",
      policyDefinition: {
        command: "update",
        permissive: true,
        roles: [{ kind: "public" }],
      },
    });
    const current = makePolicy({
      createStatement:
        'CREATE POLICY "tenant_access" ON "public"."accounts" AS PERMISSIVE ' +
        "FOR UPDATE TO PUBLIC USING (true) WITH CHECK (true);",
      policyDefinition: {
        command: "update",
        permissive: true,
        roles: [{ kind: "public" }],
        using: "true",
        withCheck: "true",
      },
    });

    const plan = await handler.generateStatements([desired], [current]);

    expect(plan.earlyDrop).toEqual([]);
    expect(plan.postRoutineCreate).toEqual([]);

    const desiredInsert = makePolicy({
      createStatement:
        "CREATE POLICY tenant_access ON public.accounts FOR INSERT TO PUBLIC;",
      policyDefinition: {
        command: "insert",
        permissive: true,
        roles: [{ kind: "public" }],
      },
    });
    const currentInsert = makePolicy({
      createStatement:
        'CREATE POLICY "tenant_access" ON "public"."accounts" AS PERMISSIVE ' +
        "FOR INSERT TO PUBLIC WITH CHECK (true);",
      policyDefinition: {
        command: "insert",
        permissive: true,
        roles: [{ kind: "public" }],
        withCheck: "true",
      },
    });
    const insertPlan = await handler.generateStatements(
      [desiredInsert],
      [currentInsert]
    );

    expect(insertPlan.earlyDrop).toEqual([]);
    expect(insertPlan.postRoutineCreate).toEqual([]);
  });

  test("replaces policies when declarative semantics change", async function () {
    const handler = new SqlObjectHandler();
    const current = makePolicy();
    const desired = makePolicy({
      createStatement:
        "CREATE POLICY tenant_access ON public.accounts AS RESTRICTIVE " +
        "FOR DELETE TO PUBLIC USING (tenant_id >= 10);",
      policyDefinition: {
        command: "delete",
        permissive: false,
        roles: [{ kind: "public" }],
        using: "tenant_id >= 10",
      },
    });

    const plan = await handler.generateStatements([desired], [current]);

    expect(plan.earlyDrop).toEqual([current.dropStatement]);
    expect(plan.postRoutineCreate).toEqual([desired.createStatement]);
  });

  test("compares row security flags by independent state key", async function () {
    const handler = new SqlObjectHandler();
    const desired = makeSqlObject({
      kind: "row-level-security",
      key: "row-level-security:public.accounts:enabled",
      createStatement:
        "ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;",
      dropStatement:
        "ALTER TABLE public.accounts DISABLE ROW LEVEL SECURITY;",
    });
    const current = makeSqlObject({
      kind: "row-level-security",
      key: "row-level-security:public.accounts:enabled",
      createStatement:
        'ALTER TABLE "public"."accounts" ENABLE ROW LEVEL SECURITY;',
      dropStatement:
        'ALTER TABLE "public"."accounts" DISABLE ROW LEVEL SECURITY;',
    });

    const plan = await handler.generateStatements([desired], [current]);

    expect(plan.earlyDrop).toEqual([]);
    expect(plan.postTableCreate).toEqual([]);
  });

  test("alters constraint and event trigger firing modes without replacement", async function () {
    const handler = new SqlObjectHandler();
    const constraint = makeSqlObject({
      kind: "constraint-trigger",
      key: "constraint-trigger:audit.Orders.constraint_audit",
      name: "constraint_audit",
      schema: "audit",
      createStatement:
        'CREATE CONSTRAINT TRIGGER constraint_audit AFTER INSERT ON audit."Orders" FOR EACH ROW EXECUTE FUNCTION public.audit_row();',
      dropStatement:
        'DROP TRIGGER IF EXISTS "constraint_audit" ON "audit"."Orders";',
      triggerTable: { name: "Orders", schema: "audit" },
      triggerEnabled: "disabled",
    });
    const event = makeSqlObject({
      kind: "event-trigger",
      key: "event-trigger:ddl_audit",
      name: "ddl_audit",
      schema: undefined,
      createStatement:
        "CREATE EVENT TRIGGER ddl_audit ON ddl_command_end EXECUTE FUNCTION public.audit_ddl();",
      dropStatement: 'DROP EVENT TRIGGER IF EXISTS "ddl_audit";',
      triggerEnabled: "replica",
    });

    const plan = await handler.generateStatements(
      [
        { ...constraint, triggerEnabled: "always" },
        { ...event, triggerEnabled: "disabled" },
      ],
      [constraint, event]
    );

    expect(plan.earlyDrop).toEqual([]);
    expect(plan.postRoutineCreate).toEqual([
      'ALTER TABLE "audit"."Orders" ENABLE ALWAYS TRIGGER "constraint_audit";',
      'ALTER EVENT TRIGGER "ddl_audit" DISABLE;',
    ]);
  });

  test("sets a non-default firing mode after creating a SQL trigger object", async function () {
    const handler = new SqlObjectHandler();
    const event = makeSqlObject({
      kind: "event-trigger",
      key: "event-trigger:ddl_audit",
      name: "ddl_audit",
      schema: undefined,
      createStatement:
        "CREATE EVENT TRIGGER ddl_audit ON ddl_command_end EXECUTE FUNCTION public.audit_ddl();",
      triggerEnabled: "always",
    });

    const plan = await handler.generateStatements([event], []);

    expect(plan.postRoutineCreate).toEqual([
      event.createStatement,
      'ALTER EVENT TRIGGER "ddl_audit" ENABLE ALWAYS;',
    ]);
  });
});
