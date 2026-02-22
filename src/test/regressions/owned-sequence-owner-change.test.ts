import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: owned sequence ownership changes are detected", function () {
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

  test("updates sequence when OWNED BY target changes", async function () {
    const initialSchema = `
      CREATE TABLE users (id integer);
      CREATE TABLE accounts (id integer);
      CREATE SEQUENCE user_seq OWNED BY users.id;
    `;

    const updatedSchema = `
      CREATE TABLE users (id integer);
      CREATE TABLE accounts (id integer);
      CREATE SEQUENCE user_seq OWNED BY accounts.id;
    `;

    await service.apply(initialSchema, ["public"], true);

    const plan = await service.apply(updatedSchema, ["public"], true, undefined, true);

    expect(plan.hasChanges).toBe(true);
    const sql = plan.transactional.join("\n");
    expect(sql).toContain("DROP SEQUENCE IF EXISTS");
    expect(sql).toContain("OWNED BY accounts.id");
  });
});
