import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: explicit owned sequences are created", function () {
  let client: Client;
  let service: SchemaService;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client, ["public", "tenant_a"]);
    service = createTestSchemaService();
  });

  afterEach(async function () {
    await cleanDatabase(client, ["public", "tenant_a"]);
    await client?.end();
  });

  test("creates sequence declared with OWNED BY", async function () {
    const schema = `
      CREATE TABLE users (
        id integer
      );

      CREATE SEQUENCE users_id_seq
        OWNED BY users.id;
    `;

    await service.apply(schema, ["public"], true);

    const result = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'S'
        AND c.relname = 'users_id_seq'
    `);

    expect(result.rows[0].count).toBe(1);
  });

  test("qualifies shorthand OWNED BY targets in the sequence schema", async function () {
    await client.query("CREATE SCHEMA tenant_a");
    const schema = `
      CREATE TABLE tenant_a.users (
        id integer
      );

      CREATE SEQUENCE tenant_a.users_id_seq
        OWNED BY users.id;
    `;

    const first = await service.apply(schema, ["tenant_a"], true);
    expect(first.transactional.join("\n")).toContain(
      "OWNED BY tenant_a.users.id"
    );

    const ownership = await client.query(`
      SELECT owner_namespace.nspname AS owner_schema,
             owner_table.relname AS owner_table,
             owner_column.attname AS owner_column
      FROM pg_class sequence
      JOIN pg_namespace sequence_namespace
        ON sequence_namespace.oid = sequence.relnamespace
      JOIN pg_depend dependency
        ON dependency.objid = sequence.oid
       AND dependency.deptype = 'a'
      JOIN pg_class owner_table ON owner_table.oid = dependency.refobjid
      JOIN pg_namespace owner_namespace
        ON owner_namespace.oid = owner_table.relnamespace
      JOIN pg_attribute owner_column
        ON owner_column.attrelid = owner_table.oid
       AND owner_column.attnum = dependency.refobjsubid
      WHERE sequence_namespace.nspname = 'tenant_a'
        AND sequence.relname = 'users_id_seq'
    `);
    expect(ownership.rows).toEqual([
      {
        owner_schema: "tenant_a",
        owner_table: "users",
        owner_column: "id",
      },
    ]);
    expect(
      (await service.apply(schema, ["tenant_a"], true, undefined, true))
        .hasChanges
    ).toBe(false);
  });
});
