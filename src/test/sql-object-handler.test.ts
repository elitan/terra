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
