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
  test("orders partition creates before dependents and drops in reverse", function () {
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

    const plan = handler.generateStatements(desired, current);

    expect(plan.preTableCreate).toEqual([
      'CREATE TABLE "public"."accounts_eu" PARTITION OF "public"."accounts" FOR VALUES FROM (0) TO (100);',
    ]);
    expect(plan.earlyDrop).toEqual([
      'DROP TABLE IF EXISTS "public"."accounts_eu" CASCADE;',
    ]);
  });
});
