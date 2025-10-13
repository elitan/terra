import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { SchemaService } from "../../core/schema/service";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestDatabaseService } from "../utils";
import {
  tableName,
  columnName
} from "./arbitraries";

/**
 * Property-Based Tests for View Management
 *
 * These tests verify that Terra correctly handles views and materialized views
 * with proper change detection and idempotency.
 */

describe("Property-Based: View Management", () => {
  let client: Client;
  let service: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    const databaseService = createTestDatabaseService();
    service = new SchemaService(databaseService);
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  test("property: simple view creation is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableName,
        columnName,
        fc.constantFrom('test_view', 'sample_view', 'active_view'),
        async (tbl, col, viewName) => {
          try {
            await cleanDatabase(client);

            const schema = `
              CREATE TABLE ${tbl} (
                id SERIAL PRIMARY KEY,
                ${col} TEXT
              );

              CREATE VIEW ${viewName} AS SELECT * FROM ${tbl};
            `.trim();

            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
            expect(plan.transactional.length).toBe(0);
          } catch (error) {
            console.error('Failed simple view:', { tbl, col, viewName });
            throw error;
          }
        }
      ),
      {
        numRuns: 20,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: simple materialized view creation is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableName,
        columnName,
        fc.constantFrom('test_mv', 'sample_mv', 'active_mv'),
        async (tbl, col, mvName) => {
          try {
            await cleanDatabase(client);

            const schema = `
              CREATE TABLE ${tbl} (
                id SERIAL PRIMARY KEY,
                ${col} TEXT
              );

              CREATE MATERIALIZED VIEW ${mvName} AS SELECT * FROM ${tbl};
            `.trim();

            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error('Failed simple materialized view:', { tbl, col, mvName });
            throw error;
          }
        }
      ),
      {
        numRuns: 20,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: view with single column selection is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableName,
        columnName,
        fc.constantFrom('filtered_view'),
        async (tbl, col, viewName) => {
          try {
            await cleanDatabase(client);

            const schema = `
              CREATE TABLE ${tbl} (
                id SERIAL PRIMARY KEY,
                ${col} TEXT,
                active BOOLEAN DEFAULT true
              );

              CREATE VIEW ${viewName} AS
              SELECT id, ${col} FROM ${tbl};
            `.trim();

            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error('Failed filtered view idempotency');
            throw error;
          }
        }
      ),
      {
        numRuns: 20,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: view data reflects base table count", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableName,
        columnName,
        fc.constantFrom('data_view'),
        fc.array(fc.stringMatching(/^[a-zA-Z0-9]{3,10}$/), { minLength: 3, maxLength: 10 }),
        async (tbl, col, viewName, testData) => {
          try {
            await cleanDatabase(client);

            const schema = `
              CREATE TABLE ${tbl} (
                id SERIAL PRIMARY KEY,
                ${col} TEXT
              );

              CREATE VIEW ${viewName} AS SELECT * FROM ${tbl};
            `.trim();

            await service.apply(schema, ['public'], true);

            // Insert test data
            for (const value of testData) {
              await client.query(`INSERT INTO ${tbl} (${col}) VALUES ($1)`, [value]);
            }

            // Query view
            const viewResult = await client.query(`SELECT COUNT(*) FROM ${viewName}`);
            const tableResult = await client.query(`SELECT COUNT(*) FROM ${tbl}`);

            // View should reflect table data
            expect(viewResult.rows[0].count).toBe(tableResult.rows[0].count);
            expect(viewResult.rows[0].count).toBe(testData.length.toString());
          } catch (error) {
            console.error('Failed view data test');
            throw error;
          }
        }
      ),
      {
        numRuns: 15,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: materialized view can be refreshed", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableName,
        columnName,
        fc.constantFrom('refresh_mv'),
        async (tbl, col, mvName) => {
          try {
            await cleanDatabase(client);

            const schema = `
              CREATE TABLE ${tbl} (
                id SERIAL PRIMARY KEY,
                ${col} TEXT
              );

              CREATE MATERIALIZED VIEW ${mvName} AS SELECT * FROM ${tbl};
            `.trim();

            await service.apply(schema, ['public'], true);

            // Insert data and refresh
            await client.query(`INSERT INTO ${tbl} (${col}) VALUES ('test1'), ('test2')`);
            await client.query(`REFRESH MATERIALIZED VIEW ${mvName}`);

            const result = await client.query(`SELECT COUNT(*) FROM ${mvName}`);
            expect(result.rows[0].count).toBe('2');

            // Verify schema is still idempotent after refresh
            const plan = await service.plan(schema);
            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error('Failed materialized view refresh test');
            throw error;
          }
        }
      ),
      {
        numRuns: 15,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: view with WHERE clause is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableName,
        columnName,
        fc.constantFrom('filtered_view'),
        async (tbl, col, viewName) => {
          try {
            await cleanDatabase(client);

            const schema = `
              CREATE TABLE ${tbl} (
                id SERIAL PRIMARY KEY,
                ${col} TEXT,
                active BOOLEAN DEFAULT true
              );

              CREATE VIEW ${viewName} AS
              SELECT id, ${col} FROM ${tbl} WHERE active = true;
            `.trim();

            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error('Failed filtered view idempotency');
            throw error;
          }
        }
      ),
      {
        numRuns: 15,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: view with constant column is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableName,
        columnName,
        fc.constantFrom('constant_view'),
        fc.integer({ min: 1, max: 100 }),
        async (tbl, col, viewName, constantValue) => {
          try {
            await cleanDatabase(client);

            const schema = `
              CREATE TABLE ${tbl} (
                id SERIAL PRIMARY KEY,
                ${col} TEXT
              );

              CREATE VIEW ${viewName} AS
              SELECT id, ${col}, ${constantValue} AS constant_value FROM ${tbl};
            `.trim();

            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error('Failed constant view idempotency');
            throw error;
          }
        }
      ),
      {
        numRuns: 15,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: multiple views on same table are idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableName,
        columnName,
        async (tbl, col) => {
          try {
            await cleanDatabase(client);

            const schema = `
              CREATE TABLE ${tbl} (
                id SERIAL PRIMARY KEY,
                ${col} TEXT,
                active BOOLEAN DEFAULT true
              );

              CREATE VIEW view1 AS SELECT * FROM ${tbl};
              CREATE VIEW view2 AS SELECT id, ${col} FROM ${tbl} WHERE active = true;
            `.trim();

            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error('Failed multiple views test');
            throw error;
          }
        }
      ),
      {
        numRuns: 15,
        verbose: false
      }
    );
  }, { timeout: 120000 });
});
