import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: procedure diff includes parameter defaults", function () {
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

  test("detects change when parameter default changes", async function () {
    const baseSchema = `
      CREATE OR REPLACE PROCEDURE proc_param_default(a integer DEFAULT 1)
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM 1;
      END;
      $$;
    `;

    const updatedSchema = `
      CREATE OR REPLACE PROCEDURE proc_param_default(a integer DEFAULT 2)
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM 1;
      END;
      $$;
    `;

    await service.apply(baseSchema, ["public"], true);

    const plan = await service.apply(updatedSchema, ["public"], true, undefined, true);

    expect(plan.hasChanges).toBe(true);
    expect(plan.transactional.length + plan.concurrent.length).toBeGreaterThan(0);
  });
});
