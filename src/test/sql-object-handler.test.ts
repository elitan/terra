import { describe, expect, test } from "bun:test";
import { SqlObjectHandler } from "../core/schema/handlers/sql-object-handler";
import type { SqlObject } from "../types/schema";

function makeSqlObject(overrides: Partial<SqlObject>): SqlObject {
  return {
    kind: "partition",
    key: "partition:public.accounts",
    name: "accounts",
    schema: "public",
    createStatement: 'CREATE TABLE "public"."accounts" (id integer) PARTITION BY RANGE (id);',
    dropStatement: 'DROP TABLE IF EXISTS "public"."accounts" CASCADE;',
    ...overrides,
  };
}

describe("SqlObjectHandler", function () {
  test("changes partition bounds without dropping the partition", async function () {
    const handler = new SqlObjectHandler();
    const desired = [
      makeSqlObject({
        key: "partition:public.accounts_eu",
        name: "accounts_eu",
        createStatement: 'CREATE TABLE "public"."accounts_eu" PARTITION OF "public"."accounts" FOR VALUES FROM (0) TO (100);',
        dropStatement: 'DROP TABLE IF EXISTS "public"."accounts_eu" CASCADE;',
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
        dropStatement: 'DROP TABLE IF EXISTS "public"."accounts_eu" CASCADE;',
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
});
