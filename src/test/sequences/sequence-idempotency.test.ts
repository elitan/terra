import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { SchemaService } from "../../core/schema/service";
import { cleanDatabase, createTestClient, createTestSchemaService } from "../utils";

describe("Sequence idempotency", () => {
  let client: Client;
  let schemaService: SchemaService;

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client, ["public"]);
    schemaService = createTestSchemaService();
  });

  afterEach(async function () {
    await cleanDatabase(client, ["public"]);
    await client.end();
  });

  test("keeps explicit default sequence options idempotent", async function () {
    const schema = `
      CREATE SEQUENCE public.invoice_seq
      AS INTEGER
      INCREMENT BY 1
      MINVALUE 1
      MAXVALUE 2147483647
      START WITH 1
      CACHE 1
      NO CYCLE;
    `;

    const first = await schemaService.apply(schema, ["public"], true);
    const second = await schemaService.apply(schema, ["public"], true);

    expect(first.hasChanges).toBe(true);
    expect(second.hasChanges).toBe(false);
    expect(second.transactional).toHaveLength(0);
    expect(second.concurrent).toHaveLength(0);
    expect(second.deferred).toHaveLength(0);
  });

  test("keeps implicit default sequence options idempotent", async function () {
    const schema = `
      CREATE SEQUENCE public.audit_seq;
    `;

    const first = await schemaService.apply(schema, ["public"], true);
    const second = await schemaService.apply(schema, ["public"], true);

    expect(first.hasChanges).toBe(true);
    expect(second.hasChanges).toBe(false);
    expect(second.transactional).toHaveLength(0);
    expect(second.concurrent).toHaveLength(0);
    expect(second.deferred).toHaveLength(0);
  });

  test("updates sequence when managed options actually change", async function () {
    const initialSchema = `
      CREATE SEQUENCE public.metrics_seq
      INCREMENT BY 5
      CACHE 10;
    `;
    const updatedSchema = `
      CREATE SEQUENCE public.metrics_seq
      INCREMENT BY 10
      CACHE 20;
    `;

    await schemaService.apply(initialSchema, ["public"], true);
    const plan = await schemaService.apply(updatedSchema, ["public"], true);

    expect(plan.hasChanges).toBe(true);
    expect(
      plan.transactional.some(function (statement) {
        return statement.includes("ALTER SEQUENCE");
      })
    ).toBe(true);
    expect(
      plan.transactional.some(
        function (statement) {
          return (
            statement.includes("ALTER SEQUENCE") &&
            statement.includes("INCREMENT BY 10") &&
            statement.includes("CACHE 20")
          );
        }
      )
    ).toBe(true);
    expect(plan.transactional.join("\n")).not.toContain("DROP SEQUENCE");
    expect(plan.transactional.join("\n")).not.toContain("CREATE SEQUENCE");
  });
});
