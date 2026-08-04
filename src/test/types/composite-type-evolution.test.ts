import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { attributeDependentIsRetained } from "../../core/schema/handlers/composite-type-dependencies";
import { DatabaseInspector } from "../../core/schema/inspector";
import { getStatementRisk } from "../../utils/statement-classifier";
import { createTestClient, createTestSchemaService } from "../utils";

const SCHEMA = "composite_lifecycle";

describe("PostgreSQL composite type evolution", function () {
  let client: Client;

  beforeEach(async function prepareSchema() {
    client = await createTestClient();
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  });

  afterEach(async function removeSchema() {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.end();
  });

  test("creates, inspects, and converges a zero-attribute composite type", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."empty_payload" AS ();
    `;

    await service.apply(desired, [SCHEMA], true);
    const inspected = await new DatabaseInspector().getCurrentCompositeTypes(
      client,
      [SCHEMA]
    );
    expect(inspected).toEqual([
      {
        name: "empty_payload",
        schema: SCHEMA,
        attributes: [],
      },
    ]);

    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("preserves attribute names, types, and explicit collations", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."localized_payload" AS (
        "Display Name" text COLLATE "C",
        amount numeric(10, 2),
        tags text[]
      );
    `;

    await service.apply(desired, [SCHEMA], true);
    const inspected = await new DatabaseInspector().getCurrentCompositeTypes(
      client,
      [SCHEMA]
    );
    expect(inspected).toEqual([
      {
        name: "localized_payload",
        schema: SCHEMA,
        attributes: [
          {
            name: "Display Name",
            type: "text",
            collation: { name: "C", schema: "pg_catalog" },
          },
          { name: "amount", type: "numeric(10,2)" },
          { name: "tags", type: "text[]" },
        ],
      },
    ]);

    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);

    const posix = desired.replace('COLLATE "C"', 'COLLATE "POSIX"');
    const posixPlan = await service.apply(
      posix,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(posixPlan.transactional).toContain(
      `ALTER TYPE "${SCHEMA}"."localized_payload" ALTER ATTRIBUTE "Display Name" TYPE TEXT COLLATE "POSIX" RESTRICT;`
    );
    await service.apply(posix, [SCHEMA], true);

    const defaultCollation = desired.replace(' COLLATE "C"', "");
    const defaultPlan = await service.apply(
      defaultCollation,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(defaultPlan.transactional).toContain(
      `ALTER TYPE "${SCHEMA}"."localized_payload" ALTER ATTRIBUTE "Display Name" TYPE TEXT COLLATE "default" RESTRICT;`
    );
    await service.apply(defaultCollation, [SCHEMA], true);
    const finalPlan = await service.apply(
      defaultCollation,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(finalPlan.hasChanges).toBe(false);
  });

  test("converges a composite type created outside TerraDB", async function () {
    const service = createTestSchemaService();
    await client.query(`
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."External Payload" AS (
        "Display Name" text COLLATE "C",
        tags text[]
      )
    `);
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."External Payload" AS (
        "Display Name" text COLLATE "C",
        tags text[]
      );
    `;

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(plan.hasChanges).toBe(false);
  });

  test("renames, changes, appends, and drops attributes while preserving rows", async function () {
    const service = createTestSchemaService();
    const initialType = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."profile" AS (
        label text COLLATE "C",
        quantity integer,
        legacy text
      );
    `;
    const retypedType = initialType.replace("quantity integer", "quantity bigint");
    const withTable = `${retypedType}
      CREATE TABLE "${SCHEMA}"."records" (
        id integer PRIMARY KEY,
        payload "${SCHEMA}"."profile" NOT NULL
      );
    `;
    const renamed = withTable.replace("label text", '"Display Label" text');
    const appended = renamed.replace(
      "legacy text",
      "legacy text,\n        note text"
    );
    const dropped = appended.replace("        legacy text,\n", "");

    await service.apply(initialType, [SCHEMA], true);
    const retypePlan = await service.apply(
      retypedType,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(retypePlan.transactional).toContain(
      `ALTER TYPE "${SCHEMA}"."profile" ALTER ATTRIBUTE "quantity" TYPE INT8 RESTRICT;`
    );
    await service.apply(retypedType, [SCHEMA], true);
    await service.apply(withTable, [SCHEMA], true);
    await client.query(`
      INSERT INTO "${SCHEMA}"."records" (id, payload)
      VALUES (
        1,
        ROW('alpha', 7, 'remove me')::"${SCHEMA}"."profile"
      )
    `);

    const renamePlan = await service.apply(
      renamed,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(renamePlan.transactional).toContain(
      `ALTER TYPE "${SCHEMA}"."profile" RENAME ATTRIBUTE "label" TO "Display Label" RESTRICT;`
    );
    await service.apply(renamed, [SCHEMA], true);

    let rows = await client.query(`
      SELECT
        (payload)."Display Label" AS label,
        (payload).quantity::text AS quantity,
        (payload).legacy AS legacy
      FROM "${SCHEMA}"."records"
    `);
    expect(rows.rows).toEqual([
      { label: "alpha", quantity: "7", legacy: "remove me" },
    ]);

    await service.apply(appended, [SCHEMA], true);
    rows = await client.query(`
      SELECT (payload)."Display Label" AS label, (payload).note AS note
      FROM "${SCHEMA}"."records"
    `);
    expect(rows.rows).toEqual([{ label: "alpha", note: null }]);

    const dropPlan = await service.apply(
      dropped,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const dropStatement =
      `ALTER TYPE "${SCHEMA}"."profile" DROP ATTRIBUTE "legacy" RESTRICT;`;
    expect(dropPlan.transactional).toContain(dropStatement);
    expect(getStatementRisk(dropStatement, "transactional")).toBe("destructive");
    await service.apply(dropped, [SCHEMA], true);

    const secondPlan = await service.apply(
      dropped,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("rejects attribute type changes that PostgreSQL blocks on dependent columns", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."measured" AS (
        quantity integer,
        label text COLLATE "C"
      );
      CREATE DOMAIN "${SCHEMA}"."measured_domain"
        AS "${SCHEMA}"."measured";
      CREATE TYPE "${SCHEMA}"."measured_range" AS RANGE (
        subtype = "${SCHEMA}"."measured"
      );
      CREATE TABLE "${SCHEMA}"."measurements" (
        id integer PRIMARY KEY,
        value "${SCHEMA}"."measured" NOT NULL,
        wrapped "${SCHEMA}"."measured_domain",
        span "${SCHEMA}"."measured_range",
        many "${SCHEMA}"."measured"[]
      );
    `;
    const desired = initial.replace("quantity integer", "quantity bigint");
    const changedCollation = initial.replace(
      'label text COLLATE "C"',
      'label text COLLATE "POSIX"'
    );

    await service.apply(initial, [SCHEMA], true);
    const inspected = await new DatabaseInspector().getCurrentCompositeTypes(
      client,
      [SCHEMA]
    );
    expect(inspected[0]?.attributeDependents).toEqual([
      {
        schema: SCHEMA,
        relation: "measurements",
        attribute: "value",
        relationKind: "r",
      },
      {
        schema: SCHEMA,
        relation: "measurements",
        attribute: "wrapped",
        relationKind: "r",
      },
      {
        schema: SCHEMA,
        relation: "measurements",
        attribute: "span",
        relationKind: "r",
      },
      {
        schema: SCHEMA,
        relation: "measurements",
        attribute: "many",
        relationKind: "r",
      },
    ]);
    expect(inspected[0]?.typeDependents).toEqual([
      { schema: SCHEMA, name: "measured_domain", kind: "domain" },
      { schema: SCHEMA, name: "measured_range", kind: "range" },
    ]);
    await expect(
      service.apply(desired, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/measurements\.value/);
    await expect(
      service.apply(changedCollation, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/measurements\.value/);

    const columns = await client.query(`
      SELECT format_type(attribute.atttypid, attribute.atttypmod) AS type
      FROM pg_type type
      JOIN pg_class relation ON relation.oid = type.typrelid
      JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
      JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = '${SCHEMA}'
        AND type.typname = 'measured'
        AND attribute.attname = 'quantity'
    `);
    expect(columns.rows).toEqual([{ type: "integer" }]);
  });

  test("combines a positional rename with an appended attribute", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."combined_change" AS (
        label text,
        stable integer
      );
    `;
    const desired = initial
      .replace("label text", '"Display Label" text')
      .replace("stable integer", "stable integer, note text");

    await service.apply(initial, [SCHEMA], true);
    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(plan.transactional).toEqual([
      `ALTER TYPE "${SCHEMA}"."combined_change" RENAME ATTRIBUTE "label" TO "Display Label" RESTRICT;`,
      `ALTER TYPE "${SCHEMA}"."combined_change" ADD ATTRIBUTE "note" TEXT RESTRICT;`,
    ]);

    await service.apply(desired, [SCHEMA], true);
    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("detects single-attribute rename and type changes", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."single_change" AS (value integer);
    `;
    const renamed = initial.replace("value integer", '"Renamed Value" integer');
    const retyped = renamed.replace("integer", "bigint");

    await service.apply(initial, [SCHEMA], true);
    const renamePlan = await service.apply(
      renamed,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(renamePlan.transactional).toEqual([
      `ALTER TYPE "${SCHEMA}"."single_change" RENAME ATTRIBUTE "value" TO "Renamed Value" RESTRICT;`,
    ]);
    await service.apply(renamed, [SCHEMA], true);

    const typePlan = await service.apply(
      retyped,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(typePlan.transactional).toEqual([
      `ALTER TYPE "${SCHEMA}"."single_change" ALTER ATTRIBUTE "Renamed Value" TYPE INT8 RESTRICT;`,
    ]);
    await service.apply(retyped, [SCHEMA], true);
  });

  test("fails closed for unmodeled relation dependency kinds", function () {
    expect(
      attributeDependentIsRetained(
        {
          schema: SCHEMA,
          relation: "unknown_relation",
          attribute: "payload",
          relationKind: "x",
        },
        { schema: SCHEMA, name: "payload", attributes: [] },
        [],
        [],
        [],
        [SCHEMA]
      )
    ).toBe(true);
  });

  test("orders composite type creation by attribute dependencies", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."Outer Payload" AS (
        "Nested Field" "${SCHEMA}"."Inner.Payload(1)"[]
      );
      CREATE TYPE "${SCHEMA}"."Inner.Payload(1)" AS (
        value integer
      );
    `;

    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(plan.transactional.findIndex(function findInner(statement) {
      return statement.startsWith(
        `CREATE TYPE "${SCHEMA}"."Inner.Payload(1)"`
      );
    })).toBeLessThan(
      plan.transactional.findIndex(function findOuter(statement) {
        return statement.startsWith(
          `CREATE TYPE "${SCHEMA}"."Outer Payload"`
        );
      })
    );

    await service.apply(desired, [SCHEMA], true);
    const secondPlan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(secondPlan.hasChanges).toBe(false);
  });

  test("drops dependent composite types before their attribute dependencies", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."inner_value" AS (value integer);
      CREATE TYPE "${SCHEMA}"."outer_value" AS (
        nested "${SCHEMA}"."inner_value"
      );
    `;
    const desired = `CREATE SCHEMA "${SCHEMA}";`;
    const retainedOuter = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."outer_value" AS (
        nested "${SCHEMA}"."inner_value"
      );
    `;

    await service.apply(initial, [SCHEMA], true);
    await expect(
      service.apply(retainedOuter, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/outer_value\.nested/);
    const plan = await service.apply(
      desired,
      [SCHEMA],
      true,
      undefined,
      true
    );
    expect(plan.transactional).toEqual([
      `DROP TYPE "${SCHEMA}"."outer_value";`,
      `DROP TYPE "${SCHEMA}"."inner_value";`,
    ]);

    await service.apply(desired, [SCHEMA], true);
    const inspected = await new DatabaseInspector().getCurrentCompositeTypes(
      client,
      [SCHEMA]
    );
    expect(inspected).toEqual([]);
  });

  test("rejects type removal while a managed table retains a dependent column", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."payload" AS (value integer);
      CREATE TABLE "${SCHEMA}"."records" (
        id integer PRIMARY KEY,
        payload "${SCHEMA}"."payload" NOT NULL
      );
    `;
    const retainedTable = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TABLE "${SCHEMA}"."records" (
        id integer PRIMARY KEY,
        payload "${SCHEMA}"."payload" NOT NULL
      );
    `;
    const removeAll = `CREATE SCHEMA "${SCHEMA}";`;

    await service.apply(initial, [SCHEMA], true);
    await expect(
      service.apply(retainedTable, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/records\.payload/);

    const plan = await service.apply(
      removeAll,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const tableDropIndex = plan.transactional.findIndex(function findTableDrop(
      statement
    ) {
      return statement.startsWith(`DROP TABLE "${SCHEMA}"."records"`);
    });
    const typeDropIndex = plan.transactional.findIndex(function findTypeDrop(
      statement
    ) {
      return statement.startsWith(`DROP TYPE "${SCHEMA}"."payload"`);
    });
    expect(tableDropIndex).toBeGreaterThanOrEqual(0);
    expect(typeDropIndex).toBeGreaterThan(tableDropIndex);

    await service.apply(removeAll, [SCHEMA], true);
    const types = await new DatabaseInspector().getCurrentCompositeTypes(
      client,
      [SCHEMA]
    );
    expect(types).toEqual([]);
  });

  test("protects unmanaged cross-schema dependents during type removal", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."shared_payload" AS (value integer);
    `;

    await service.apply(desired, [SCHEMA], true);
    await client.query(`
      CREATE TABLE public.external_composite_records (
        id integer PRIMARY KEY,
        payload "${SCHEMA}"."shared_payload" NOT NULL
      )
    `);

    try {
      await expect(
        service.apply(`CREATE SCHEMA "${SCHEMA}";`, [SCHEMA], true, undefined, true)
      ).rejects.toThrow(/public\.external_composite_records\.payload/);
    } finally {
      await client.query("DROP TABLE IF EXISTS public.external_composite_records");
    }
  });

  test("protects unmanaged domain dependents during type removal", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."shared_payload" AS (value integer);
    `;

    await service.apply(desired, [SCHEMA], true);
    await client.query(`
      CREATE DOMAIN public.external_payload_domain
        AS "${SCHEMA}"."shared_payload"
    `);

    try {
      await expect(
        service.apply(`CREATE SCHEMA "${SCHEMA}";`, [SCHEMA], true, undefined, true)
      ).rejects.toThrow(/domain public\.external_payload_domain/);
    } finally {
      await client.query("DROP DOMAIN IF EXISTS public.external_payload_domain");
    }
  });

  test("protects retained views and orders coordinated view removal", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."view_payload" AS (value integer);
      CREATE VIEW "${SCHEMA}"."payload_view" AS
        SELECT ROW(1)::"${SCHEMA}"."view_payload" AS payload;
    `;
    const retainedView = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE VIEW "${SCHEMA}"."payload_view" AS
        SELECT ROW(1)::"${SCHEMA}"."view_payload" AS payload;
    `;
    const removeAll = `CREATE SCHEMA "${SCHEMA}";`;

    await service.apply(initial, [SCHEMA], true);
    await expect(
      service.apply(retainedView, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/payload_view\.payload/);

    const plan = await service.apply(
      removeAll,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const viewDropIndex = plan.transactional.findIndex(function findViewDrop(
      statement
    ) {
      return statement.startsWith(
        `DROP VIEW IF EXISTS "${SCHEMA}"."payload_view"`
      );
    });
    const typeDropIndex = plan.transactional.findIndex(function findTypeDrop(
      statement
    ) {
      return statement.startsWith(`DROP TYPE "${SCHEMA}"."view_payload"`);
    });
    expect(viewDropIndex).toBeGreaterThanOrEqual(0);
    expect(typeDropIndex).toBeGreaterThan(viewDropIndex);
    await service.apply(removeAll, [SCHEMA], true);
  });

  test("orders managed domain and range removal before their composite subtype", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."payload" AS (value integer);
      CREATE DOMAIN "${SCHEMA}"."payload_domain"
        AS "${SCHEMA}"."payload";
      CREATE TYPE "${SCHEMA}"."payload_range" AS RANGE (
        subtype = "${SCHEMA}"."payload"
      );
    `;
    const retainedDependents = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE DOMAIN "${SCHEMA}"."payload_domain"
        AS "${SCHEMA}"."payload";
      CREATE TYPE "${SCHEMA}"."payload_range" AS RANGE (
        subtype = "${SCHEMA}"."payload"
      );
    `;
    const removeAll = `CREATE SCHEMA "${SCHEMA}";`;

    await service.apply(initial, [SCHEMA], true);
    await expect(
      service.apply(retainedDependents, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/domain composite_lifecycle\.payload_domain/);

    const plan = await service.apply(
      removeAll,
      [SCHEMA],
      true,
      undefined,
      true
    );
    const compositeDropIndex = plan.transactional.findIndex(
      function findCompositeDrop(statement) {
        return statement.startsWith(`DROP TYPE "${SCHEMA}"."payload"`);
      }
    );
    const domainDropIndex = plan.transactional.findIndex(
      function findDomainDrop(statement) {
        return statement.startsWith(`DROP DOMAIN IF EXISTS "${SCHEMA}"."payload_domain"`);
      }
    );
    const rangeDropIndex = plan.transactional.findIndex(
      function findRangeDrop(statement) {
        return statement.startsWith(`DROP TYPE IF EXISTS "${SCHEMA}"."payload_range"`);
      }
    );
    expect(domainDropIndex).toBeGreaterThanOrEqual(0);
    expect(rangeDropIndex).toBeGreaterThanOrEqual(0);
    expect(compositeDropIndex).toBeGreaterThan(domainDropIndex);
    expect(compositeDropIndex).toBeGreaterThan(rangeDropIndex);

    await service.apply(removeAll, [SCHEMA], true);
    const types = await new DatabaseInspector().getCurrentCompositeTypes(
      client,
      [SCHEMA]
    );
    expect(types).toEqual([]);
  });

  test("rejects duplicate type and attribute names before mutation", async function () {
    const service = createTestSchemaService();
    const duplicateAttributes = `
      CREATE TYPE duplicate_payload AS (value integer, value text);
    `;
    const duplicateTypes = `
      CREATE TYPE duplicate_payload AS (value integer);
      CREATE TYPE duplicate_payload AS (other text);
    `;

    await expect(
      service.apply(duplicateAttributes, ["public"], true, undefined, true)
    ).rejects.toThrow(/duplicate attribute names/);
    await expect(
      service.apply(duplicateTypes, ["public"], true, undefined, true)
    ).rejects.toThrow(/duplicate composite type names/);

    const types = await client.query(`
      SELECT count(*)::int AS count
      FROM pg_type
      WHERE typnamespace = 'public'::regnamespace
        AND typname = 'duplicate_payload'
    `);
    expect(types.rows).toEqual([{ count: 0 }]);
  });

  test("rejects recursive composite dependencies before mutation", async function () {
    const service = createTestSchemaService();
    const desired = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."first_payload" AS (
        second "${SCHEMA}"."second_payload"
      );
      CREATE TYPE "${SCHEMA}"."second_payload" AS (
        first "${SCHEMA}"."first_payload"
      );
    `;

    await expect(
      service.apply(desired, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/dependency cycle/);

    const schemas = await client.query(
      `SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = $1`,
      [SCHEMA]
    );
    expect(schemas.rows).toEqual([{ count: 0 }]);
  });

  test("rejects adding an attribute before an existing attribute", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."ordered_payload" AS (
        first integer,
        last integer
      );
    `;
    const desired = initial.replace(
      "last integer",
      "middle integer,\n        last integer"
    );

    await service.apply(initial, [SCHEMA], true);
    await expect(
      service.apply(desired, [SCHEMA], true, undefined, true)
    ).rejects.toThrow(/only append new attributes/);

    const inspected = await new DatabaseInspector().getCurrentCompositeTypes(
      client,
      [SCHEMA]
    );
    expect(inspected[0]?.attributes.map(function getName(attribute) {
      return attribute.name;
    })).toEqual(["first", "last"]);
  });

  test("rolls back earlier attribute changes when a later alteration fails", async function () {
    const service = createTestSchemaService();
    const initial = `
      CREATE SCHEMA "${SCHEMA}";
      CREATE TYPE "${SCHEMA}"."rollback_payload" AS (
        label text,
        quantity integer
      );
    `;
    const invalid = initial
      .replace("label text", '"Display Label" text')
      .replace("quantity integer", 'quantity integer COLLATE "C"');

    await service.apply(initial, [SCHEMA], true);
    await expect(service.apply(invalid, [SCHEMA], true)).rejects.toThrow();

    const inspected = await new DatabaseInspector().getCurrentCompositeTypes(
      client,
      [SCHEMA]
    );
    expect(inspected[0]?.attributes.map(function getName(attribute) {
      return attribute.name;
    })).toEqual(["label", "quantity"]);
  });
});
