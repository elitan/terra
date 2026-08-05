import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: owned sequence creation handles table default dependency", function () {
  let client: Client;
  let service: SchemaService;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
    service = createTestSchemaService();
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client?.end();
  });

  test("applies schema when table default references owned sequence", async function () {
    const schema = `
      CREATE TABLE users (
        id integer DEFAULT nextval('user_seq')
      );

      CREATE SEQUENCE user_seq OWNED BY users.id;
    `;

    await service.apply(schema, ["public"], true);

    const seq = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'user_seq' AND c.relkind = 'S'
    `);

    expect(seq.rows[0].count).toBe(1);
  });

  test("creates quoted sequences containing OWNED BY before dependent tables", async function () {
    const schema = `
      CREATE SEQUENCE "OWNED BY";

      CREATE TABLE users (
        id bigint DEFAULT nextval('"OWNED BY"'::regclass)
      );
    `;

    const first = await service.apply(schema, ["public"], true);
    const sequencePosition = first.transactional.findIndex(
      function findSequenceCreate(statement) {
        return statement.startsWith('CREATE SEQUENCE "OWNED BY"');
      }
    );
    const tablePosition = first.transactional.findIndex(
      function findTableCreate(statement) {
        return statement.startsWith('CREATE TABLE "users"');
      }
    );

    expect(sequencePosition).toBeGreaterThanOrEqual(0);
    expect(tablePosition).toBeGreaterThan(sequencePosition);
    await client.query("INSERT INTO users DEFAULT VALUES");
    const rows = await client.query("SELECT id FROM users");
    expect(rows.rows).toEqual([{ id: "1" }]);
    expect(
      (await service.apply(schema, ["public"], true, undefined, true))
        .hasChanges
    ).toBe(false);
  });

  test("removes dependent defaults before dropping standalone sequences", async function () {
    const initialSchema = `
      CREATE SEQUENCE user_seq;
      CREATE TABLE users (
        id bigint DEFAULT nextval('user_seq')
      );
    `;
    const updatedSchema = `
      CREATE TABLE users (
        id bigint
      );
    `;

    await service.apply(initialSchema, ["public"], true);
    await client.query("INSERT INTO users DEFAULT VALUES");

    const plan = await service.apply(updatedSchema, ["public"], true);
    const defaultRemovalPosition = plan.transactional.findIndex(
      function findDefaultRemoval(statement) {
        return statement.includes("DROP DEFAULT");
      }
    );
    const sequenceDropPosition = plan.transactional.findIndex(
      function findSequenceDrop(statement) {
        return statement.startsWith(
          'DROP SEQUENCE IF EXISTS "public"."user_seq"'
        );
      }
    );

    expect(defaultRemovalPosition).toBeGreaterThanOrEqual(0);
    expect(sequenceDropPosition).toBeGreaterThan(defaultRemovalPosition);
    expect((await client.query("SELECT id FROM users")).rows).toEqual([
      { id: "1" },
    ]);
    expect(
      (await service.apply(updatedSchema, ["public"], true, undefined, true))
        .hasChanges
    ).toBe(false);
  });
});
