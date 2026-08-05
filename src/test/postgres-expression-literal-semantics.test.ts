import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import {
  cleanDatabase,
  createTestClient,
  createTestSchemaService,
} from "./utils";

const SCHEMA = "expression_literal_semantics";

function replaceLiteralWhitespace(schema: string): string {
  return schema.replaceAll("alpha beta", "alpha  beta");
}

describe("PostgreSQL expression literal semantics", function () {
  let client: Client;

  beforeEach(async function prepareDatabase() {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function cleanUpDatabase() {
    await cleanDatabase(client);
    await client.end();
  });

  test("replaces every managed expression whose literal whitespace changes", async function () {
    const service = createTestSchemaService();
    const initialSchema = `
      CREATE SCHEMA ${SCHEMA};

      CREATE DOMAIN ${SCHEMA}.literal_domain AS text
        DEFAULT 'alpha beta'::text
        CONSTRAINT literal_domain_check
        CHECK (starts_with('alpha beta'::text, 'alpha'::text));

      CREATE TABLE ${SCHEMA}.expression_state (
        id integer PRIMARY KEY,
        label text NOT NULL,
        generated_length integer GENERATED ALWAYS AS (
          length('alpha beta'::text)
        ) STORED,
        CONSTRAINT literal_table_check
          CHECK (starts_with('alpha beta'::text, 'alpha'::text))
      );

      ALTER TABLE ${SCHEMA}.expression_state ENABLE ROW LEVEL SECURITY;
      CREATE POLICY literal_policy ON ${SCHEMA}.expression_state
        FOR SELECT TO PUBLIC
        USING (starts_with('alpha beta'::text, 'alpha'::text));

      CREATE INDEX literal_expression_index
        ON ${SCHEMA}.expression_state (length('alpha beta'::text))
        WHERE starts_with('alpha beta'::text, 'alpha'::text);
    `;
    const changedSchema = replaceLiteralWhitespace(initialSchema);

    await service.apply(initialSchema, [SCHEMA], true);
    await client.query(`
      INSERT INTO ${SCHEMA}.expression_state (id, label)
      VALUES (1, 'preserved')
    `);
    const before = await client.query(`
      SELECT table_relation.oid::text AS table_oid,
             domain_type.oid::text AS domain_oid,
             generated_length
      FROM ${SCHEMA}.expression_state
      CROSS JOIN pg_class table_relation
      CROSS JOIN pg_type domain_type
      WHERE table_relation.oid = '${SCHEMA}.expression_state'::regclass
        AND domain_type.oid = '${SCHEMA}.literal_domain'::regtype
    `);
    expect(before.rows).toEqual([{
      table_oid: expect.any(String),
      domain_oid: expect.any(String),
      generated_length: 10,
    }]);

    const plan = await service.plan(changedSchema, [SCHEMA]);
    const planSql = [
      ...plan.transactional,
      ...(plan.nonTransactional || []),
    ].join("\n");
    expect(planSql).toContain('DROP CONSTRAINT "literal_domain_check"');
    expect(planSql).toContain("SET DEFAULT 'alpha  beta'::text");
    expect(planSql).toContain('DROP CONSTRAINT "literal_table_check"');
    expect(planSql).toContain(
      'DROP INDEX "expression_literal_semantics"."literal_expression_index"'
    );
    expect(planSql).toContain('DROP POLICY IF EXISTS "literal_policy"');

    await service.apply(changedSchema, [SCHEMA], true);

    const after = await client.query(`
      SELECT table_relation.oid::text AS table_oid,
             domain_type.oid::text AS domain_oid,
             generated_length
      FROM ${SCHEMA}.expression_state
      CROSS JOIN pg_class table_relation
      CROSS JOIN pg_type domain_type
      WHERE table_relation.oid = '${SCHEMA}.expression_state'::regclass
        AND domain_type.oid = '${SCHEMA}.literal_domain'::regtype
    `);
    expect(after.rows).toEqual([{
      table_oid: before.rows[0].table_oid,
      domain_oid: before.rows[0].domain_oid,
      generated_length: 11,
    }]);

    const expressions = await client.query(`
      SELECT pg_get_expr(constraint_catalog.conbin, constraint_catalog.conrelid)
               AS expression
      FROM pg_constraint constraint_catalog
      WHERE constraint_catalog.conname IN (
        'literal_domain_check',
        'literal_table_check'
      )

      UNION ALL

      SELECT pg_get_expr(index_catalog.indpred, index_catalog.indrelid)
      FROM pg_index index_catalog
      WHERE index_catalog.indexrelid =
        '${SCHEMA}.literal_expression_index'::regclass

      UNION ALL

      SELECT pg_get_indexdef(
        '${SCHEMA}.literal_expression_index'::regclass
      )

      UNION ALL

      SELECT pg_get_expr(policy_catalog.polqual, policy_catalog.polrelid)
      FROM pg_policy policy_catalog
      WHERE policy_catalog.polname = 'literal_policy'
        AND policy_catalog.polrelid = '${SCHEMA}.expression_state'::regclass

      UNION ALL

      SELECT domain_type.typdefault
      FROM pg_type domain_type
      WHERE domain_type.oid = '${SCHEMA}.literal_domain'::regtype

      ORDER BY expression
    `);
    expect(expressions.rows).toHaveLength(6);
    for (const row of expressions.rows) {
      expect(row.expression).toContain("alpha  beta");
    }
    expect((await service.plan(changedSchema, [SCHEMA])).hasChanges).toBe(false);
  });

  test("rolls back a literal-sensitive CHECK replacement that rejects existing rows", async function () {
    const service = createTestSchemaService();
    const initialSchema = `
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.rollback_guard (
        id integer PRIMARY KEY,
        label text NOT NULL,
        CONSTRAINT required_prefix
          CHECK (starts_with(label, 'alpha beta'::text))
      );
    `;
    const changedSchema = replaceLiteralWhitespace(initialSchema);

    await service.apply(initialSchema, [SCHEMA], true);
    await client.query(`
      INSERT INTO ${SCHEMA}.rollback_guard (id, label)
      VALUES (1, 'alpha beta value')
    `);

    const plan = await service.plan(changedSchema, [SCHEMA]);
    expect(plan.transactional.join("\n")).toContain(
      'DROP CONSTRAINT "required_prefix"'
    );
    await expect(
      service.apply(changedSchema, [SCHEMA], true)
    ).rejects.toThrow(/required_prefix/);

    const preserved = await client.query(`
      SELECT row_value.id,
             row_value.label,
             table_relation.oid::text AS table_oid,
             pg_get_expr(
               constraint_catalog.conbin,
               constraint_catalog.conrelid
             ) AS expression
      FROM ${SCHEMA}.rollback_guard row_value
      CROSS JOIN pg_class table_relation
      JOIN pg_constraint constraint_catalog
        ON constraint_catalog.conrelid = table_relation.oid
       AND constraint_catalog.conname = 'required_prefix'
      WHERE table_relation.oid = '${SCHEMA}.rollback_guard'::regclass
    `);
    expect(preserved.rows).toHaveLength(1);
    expect(preserved.rows[0]).toMatchObject({
      id: 1,
      label: "alpha beta value",
      table_oid: expect.any(String),
    });
    expect(preserved.rows[0].expression).toContain("alpha beta");
    expect(preserved.rows[0].expression).not.toContain("alpha  beta");
    expect((await service.plan(initialSchema, [SCHEMA])).hasChanges).toBe(false);
  });
});
