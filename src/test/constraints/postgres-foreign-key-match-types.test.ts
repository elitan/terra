import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { ParserError } from "../../types/errors";
import type { MigrationPlan } from "../../types/migration";
import { createColumnTestServices } from "../columns/column-test-utils";
import { cleanDatabase, createTestClient } from "../utils";

describe("PostgreSQL foreign key match types", function () {
  let client: Client;
  const services = createColumnTestServices();

  beforeEach(async function () {
    client = await createTestClient();
    await cleanDatabase(client);
  });

  afterEach(async function () {
    await cleanDatabase(client);
    await client.end();
  });

  async function planSchema(schema: string): Promise<MigrationPlan> {
    const current = await services.inspector.getCurrentSchema(client);
    const desired = await services.parser.parseSchema(schema);
    return services.differ.generateMigrationPlan(desired.tables, current);
  }

  test("creates, inspects, enforces, changes, and reapplies MATCH FULL", async function () {
    const fullSchema = `
      CREATE TABLE public.match_parent (
        tenant_id integer NOT NULL,
        id integer NOT NULL,
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE public.match_child (
        id integer PRIMARY KEY,
        tenant_id integer,
        parent_id integer,
        CONSTRAINT match_child_parent_fkey
          FOREIGN KEY (tenant_id, parent_id)
          REFERENCES public.match_parent (tenant_id, id)
          MATCH FULL
      );
    `;

    const parsed = await services.parser.parseSchema(fullSchema);
    const parsedChild = parsed.tables.find(function findChild(table) {
      return table.name === "match_child";
    });
    expect(parsedChild?.foreignKeys?.[0]?.matchType).toBe("FULL");

    await services.executor.executePlan(client, await planSchema(fullSchema), true);
    const inspectedChild = (await services.inspector.getCurrentSchema(client)).find(
      function findChild(table) {
        return table.name === "match_child";
      }
    );
    expect(inspectedChild?.foreignKeys?.[0]?.matchType).toBe("FULL");
    expect((await planSchema(fullSchema)).hasChanges).toBe(false);

    await client.query("INSERT INTO public.match_parent VALUES (1, 10)");
    await expect(
      client.query("INSERT INTO public.match_child VALUES (1, 1, NULL)")
    ).rejects.toThrow(/match_child_parent_fkey/);
    await client.query("INSERT INTO public.match_child VALUES (2, NULL, NULL)");

    const simpleSchema = fullSchema.replace("MATCH FULL", "MATCH SIMPLE");
    const simplePlan = await planSchema(simpleSchema);
    const sql = [...simplePlan.transactional, ...simplePlan.concurrent].join("\n");
    expect(sql).toContain('DROP CONSTRAINT "match_child_parent_fkey"');
    expect(sql).not.toContain("MATCH FULL");
    await services.executor.executePlan(client, simplePlan, true);
    await client.query("INSERT INTO public.match_child VALUES (3, 1, NULL)");
    expect((await planSchema(simpleSchema)).hasChanges).toBe(false);
  });

  test("rejects PostgreSQL's unimplemented MATCH PARTIAL before planning", async function () {
    const schema = `
      CREATE TABLE match_parent (
        tenant_id integer NOT NULL,
        id integer NOT NULL,
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE match_child (
        tenant_id integer,
        parent_id integer,
        FOREIGN KEY (tenant_id, parent_id)
          REFERENCES match_parent (tenant_id, id)
          MATCH PARTIAL
      );
    `;

    try {
      await services.parser.parseSchema(schema);
      throw new Error("expected MATCH PARTIAL to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ParserError);
      expect((error as ParserError).code).toBe("PARSER_ERROR");
      expect((error as ParserError).message).toContain(
        "PostgreSQL does not implement MATCH PARTIAL"
      );
    }
  });
});
