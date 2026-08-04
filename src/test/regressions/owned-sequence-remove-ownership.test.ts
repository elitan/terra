import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: owned sequence can be made unowned", function () {
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

  test("updates sequence when OWNED BY is removed", async function () {
    const initialSchema = `
      CREATE TABLE users (id integer);
      CREATE SEQUENCE user_seq OWNED BY users.id;
    `;

    const updatedSchema = `
      CREATE TABLE users (id integer);
      CREATE SEQUENCE user_seq;
    `;

    await service.apply(initialSchema, ["public"], true);
    const before = await client.query(
      "SELECT 'public.user_seq'::regclass::oid::integer AS oid"
    );

    const plan = await service.apply(updatedSchema, ["public"], true, undefined, true);

    expect(plan.hasChanges).toBe(true);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain("ALTER SEQUENCE");
    expect(sql).toContain("OWNED BY NONE");
    expect(sql).not.toContain("DROP SEQUENCE");
    expect(sql).not.toContain("CREATE SEQUENCE");

    await service.apply(updatedSchema, ["public"], true);
    const after = await client.query(
      "SELECT 'public.user_seq'::regclass::oid::integer AS oid"
    );
    expect(after.rows[0]?.oid).toBe(before.rows[0]?.oid);
    expect(
      (await service.apply(updatedSchema, ["public"], true, undefined, true))
        .hasChanges
    ).toBe(false);
  });
});
