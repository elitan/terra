import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { cleanDatabase, createTestClient, createTestSchemaService } from "../utils";
import type { SchemaService } from "../../core/schema/service";
import { DatabaseInspector } from "../../core/schema/inspector";

describe("Composite Types", () => {
  let client: Client;
  let schemaService: SchemaService;
  let inspector: DatabaseInspector;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    schemaService = createTestSchemaService();
    inspector = new DatabaseInspector();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client?.end();
  });

  test("should apply composite type schema twice with no changes on second run", async () => {
    const schema = `
      CREATE TYPE priority_data AS (
        priority integer,
        scheduled_date date,
        reason text
      );

      COMMENT ON TYPE priority_data IS 'priority data';

      CREATE FUNCTION get_priority_data()
      RETURNS priority_data
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN ROW(1, CURRENT_DATE, 'manual')::priority_data;
      END;
      $$;
    `;

    const firstPlan = await schemaService.apply(schema, ["public"], true);
    expect(firstPlan.hasChanges).toBe(true);

    const compositeTypes = await inspector.getCurrentCompositeTypes(client, ["public"]);
    expect(compositeTypes).toEqual([
      {
        name: "priority_data",
        schema: "public",
        attributes: [
          { name: "priority", type: "integer" },
          { name: "scheduled_date", type: "date" },
          { name: "reason", type: "text" },
        ],
        routineDependents: [
          {
            schema: "public",
            name: "get_priority_data",
            kind: "function",
            identityArguments: "",
          },
        ],
      },
    ]);

    const secondPlan = await schemaService.apply(schema, ["public"], true);
    expect(secondPlan.hasChanges).toBe(false);
  });
});
