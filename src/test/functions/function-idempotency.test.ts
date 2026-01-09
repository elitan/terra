import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestClient, cleanDatabase, createTestProvider } from "../utils";
import { Client } from "pg";
import { FunctionHandler } from "../../core/schema/handlers/function-handler";
import { DatabaseInspector } from "../../core/schema/inspector";

async function dropAllFunctions(client: Client): Promise<void> {
  await client.query(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN (
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
          AND p.prokind IN ('f', 'p')
      ) LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || quote_ident(r.proname) || '(' || r.args || ') CASCADE';
      END LOOP;
    END $$;
  `);
}

describe("Function idempotency", () => {
  let client: Client;
  let inspector: DatabaseInspector;
  let functionHandler: FunctionHandler;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    await dropAllFunctions(client);
    inspector = new DatabaseInspector();
    functionHandler = new FunctionHandler();
  });

  afterEach(async () => {
    await dropAllFunctions(client);
    await cleanDatabase(client);
    await client.end();
  });

  test("should not recreate plpgsql function due to whitespace differences", async () => {
    const provider = createTestProvider();

    const schema = `
      CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger
      LANGUAGE plpgsql AS $$
      begin
          new.updated_at = now();
          return new;
      end;
      $$;
    `;

    const parsed = await provider.parseSchema(schema);
    const desiredFunctions = parsed.functions;

    const createSQL = `
      CREATE FUNCTION update_updated_at_column() RETURNS trigger
      LANGUAGE plpgsql AS $$
      begin
          new.updated_at = now();
          return new;
      end;
      $$;
    `;
    await client.query(createSQL);

    const currentFunctions = await inspector.getCurrentFunctions(client, ['public']);

    console.log("Current (from DB):", JSON.stringify(currentFunctions[0], null, 2));
    console.log("Desired (from parser):", JSON.stringify(desiredFunctions[0], null, 2));

    const statements = functionHandler.generateStatements(desiredFunctions, currentFunctions);
    expect(statements).toHaveLength(0);
  });

  test("should not recreate SQL function due to whitespace differences", async () => {
    const provider = createTestProvider();

    const schema = `
      CREATE FUNCTION add_numbers(a INT, b INT)
      RETURNS INT
      AS $$
        SELECT a + b
      $$
      LANGUAGE SQL;
    `;

    const parsed = await provider.parseSchema(schema);
    const desiredFunctions = parsed.functions;

    const createSQL = `
      CREATE FUNCTION add_numbers(a INT, b INT)
      RETURNS INT
      AS $$
        SELECT a + b
      $$
      LANGUAGE SQL;
    `;
    await client.query(createSQL);

    const currentFunctions = await inspector.getCurrentFunctions(client, ['public']);

    console.log("Current (from DB):", JSON.stringify(currentFunctions[0], null, 2));
    console.log("Desired (from parser):", JSON.stringify(desiredFunctions[0], null, 2));

    const statements = functionHandler.generateStatements(desiredFunctions, currentFunctions);
    expect(statements).toHaveLength(0);
  });

  test("should detect actual function body changes", async () => {
    const provider = createTestProvider();

    const createSQL = `
      CREATE FUNCTION multiply(a INT, b INT)
      RETURNS INT
      AS $$
        SELECT a * b
      $$
      LANGUAGE SQL;
    `;
    await client.query(createSQL);

    const currentFunctions = await inspector.getCurrentFunctions(client, ['public']);

    const newSchema = `
      CREATE FUNCTION multiply(a INT, b INT)
      RETURNS INT
      AS $$
        SELECT a * b * 2
      $$
      LANGUAGE SQL;
    `;
    const parsed = await provider.parseSchema(newSchema);
    const desiredFunctions = parsed.functions;

    const statements = functionHandler.generateStatements(desiredFunctions, currentFunctions);
    expect(statements.length).toBeGreaterThan(0);
  });
});
