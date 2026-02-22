import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";

describe("Regression: issue 82 trigger idempotency", () => {
  let client: Client;
  let service: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    service = createTestSchemaService();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client?.end();
  });

  test("does not recreate unchanged trigger when event order differs", async () => {
    const schema = `
      CREATE TABLE candidate_activities (
        id SERIAL PRIMARY KEY,
        person_id INT
      );

      CREATE FUNCTION trigger_update_contact_history() RETURNS trigger AS $$
      BEGIN
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trigger_candidate_activities_contact_history
        AFTER INSERT OR DELETE OR UPDATE ON candidate_activities
        FOR EACH ROW EXECUTE FUNCTION trigger_update_contact_history();
    `;

    await service.apply(schema, ["public"], true);

    const plan = await service.apply(schema, ["public"], true, undefined, true);

    expect(plan.hasChanges).toBe(false);
    expect(plan.transactional).toHaveLength(0);
    expect(plan.concurrent).toHaveLength(0);
  });
});
