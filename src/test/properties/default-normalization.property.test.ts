import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { SchemaService } from "../../core/schema/service";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestDatabaseService } from "../utils";
import { tableName, columnName, typeAliasPair } from "./arbitraries";

/**
 * Property-Based Tests for Default Value Normalization
 *
 * Verifies that Terra correctly normalizes default values and doesn't generate
 * spurious DROP DEFAULT / SET DEFAULT operations when defaults are functionally equivalent.
 */

describe("Property-Based: Default Value Normalization", () => {
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

  test("property: numeric defaults are normalized correctly", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }),
        tableName,
        columnName,
        async (defaultValue, tblName, colName) => {
          try {
            const schema = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} INTEGER DEFAULT ${defaultValue}
              );
            `.trim();

            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);

            // Verify no DEFAULT operations
            const defaultOps = plan.transactional.filter(
              s => s.includes('DROP DEFAULT') || s.includes('SET DEFAULT')
            );
            expect(defaultOps.length).toBe(0);
          } catch (error) {
            console.error(`Failed with default value: ${defaultValue}`);
            throw error;
          }
        }
      ),
      {
        numRuns: 30,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: string defaults preserve content", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-zA-Z0-9 ]{1,50}$/),
        tableName,
        columnName,
        async (defaultValue, tblName, colName) => {
          try {
            const schema = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} TEXT DEFAULT '${defaultValue}'
              );
            `.trim();

            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);

            // Verify no DEFAULT operations
            const defaultOps = plan.transactional.filter(
              s => s.includes('DROP DEFAULT') || s.includes('SET DEFAULT')
            );
            expect(defaultOps.length).toBe(0);
          } catch (error) {
            console.error(`Failed with default value: '${defaultValue}'`);
            throw error;
          }
        }
      ),
      {
        numRuns: 30,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: boolean defaults are normalized", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        tableName,
        columnName,
        async (defaultValue, tblName, colName) => {
          try {
            const schema = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} BOOLEAN DEFAULT ${defaultValue}
              );
            `.trim();

            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error(`Failed with boolean default: ${defaultValue}`);
            throw error;
          }
        }
      ),
      {
        numRuns: 15,
        verbose: false
      }
    );
  }, { timeout: 90000 });

  test("property: type change with same default doesn't drop/set default", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-zA-Z0-9 ]{1,30}$/),
        tableName,
        columnName,
        async (defaultValue, tblName, colName) => {
          try {
            // Start with TEXT
            const schema1 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} TEXT DEFAULT '${defaultValue}'
              );
            `.trim();

            // Change to VARCHAR but keep default
            const schema2 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} VARCHAR(255) DEFAULT '${defaultValue}'
              );
            `.trim();

            await service.apply(schema1, ['public'], true);
            const plan = await service.plan(schema2);

            // Should have type change but NOT default operations
            const defaultOps = plan.transactional.filter(
              s => s.includes('DROP DEFAULT') || s.includes('SET DEFAULT')
            );

            expect(defaultOps.length).toBe(0);
          } catch (error) {
            console.error(`Failed with default: '${defaultValue}'`);
            throw error;
          }
        }
      ),
      {
        numRuns: 30,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: type alias change with default preserves default", async () => {
    await fc.assert(
      fc.asyncProperty(
        typeAliasPair,
        fc.integer({ min: 0, max: 1000 }),
        tableName,
        columnName,
        async ([type1, type2], defaultValue, tblName, colName) => {
          try {
            // Skip non-integer types
            if (!type1.toLowerCase().includes('int') || type1.toLowerCase().includes('serial')) {
              return;
            }

            const schema1 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} ${type1} DEFAULT ${defaultValue}
              );
            `.trim();

            const schema2 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} ${type2} DEFAULT ${defaultValue}
              );
            `.trim();

            await service.apply(schema1, ['public'], true);
            const plan = await service.plan(schema2);

            // Should have NO changes at all (type and default both equivalent)
            expect(plan.hasChanges).toBe(false);
            expect(plan.transactional.length).toBe(0);
          } catch (error) {
            console.error(`Failed: ${type1} → ${type2} with default ${defaultValue}`);
            throw error;
          }
        }
      ),
      {
        numRuns: 25,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: CURRENT_TIMESTAMP default is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableName,
        columnName,
        async (tblName, colName) => {
          try {
            const schema = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} TIMESTAMP DEFAULT CURRENT_TIMESTAMP
              );
            `.trim();

            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error('CURRENT_TIMESTAMP test failed');
            throw error;
          }
        }
      ),
      {
        numRuns: 15,
        verbose: false
      }
    );
  }, { timeout: 90000 });

  test("property: explicit NULL default is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('TEXT', 'INTEGER', 'BOOLEAN'),
        fc.constantFrom('null_test'),
        columnName,
        async (type, tblName, colName) => {
          try {
            // Clean database before each property iteration
            await cleanDatabase(client);

            // Schema with explicit DEFAULT NULL
            const schema = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} ${type} DEFAULT NULL
              );
            `.trim();

            // Apply and verify idempotency
            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            // Should be idempotent
            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error(`NULL default test failed for type: ${type}`);
            throw error;
          }
        }
      ),
      {
        numRuns: 15,
        verbose: false
      }
    );
  }, { timeout: 90000 });

  test("property: defaults with extra spaces are normalized", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        tableName,
        columnName,
        async (defaultValue, tblName, colName) => {
          try {
            // Schema with extra spaces around default
            const schema1 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} INTEGER DEFAULT  ${defaultValue}
              );
            `.trim();

            // Schema without extra whitespace
            const schema2 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} INTEGER DEFAULT ${defaultValue}
              );
            `.trim();

            await service.apply(schema1, ['public'], true);
            const plan = await service.plan(schema2);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error(`Whitespace normalization failed with default: ${defaultValue}`);
            throw error;
          }
        }
      ),
      {
        numRuns: 15,
        verbose: false
      }
    );
  }, { timeout: 90000 });

  test("property: changing default value is detected", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 101, max: 200 }),
        tableName,
        columnName,
        async (default1, default2, tblName, colName) => {
          try {
            const schema1 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} INTEGER DEFAULT ${default1}
              );
            `.trim();

            const schema2 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} INTEGER DEFAULT ${default2}
              );
            `.trim();

            await service.apply(schema1, ['public'], true);
            const plan = await service.plan(schema2);

            // Should detect the default value change
            expect(plan.hasChanges).toBe(true);

            const hasDefaultChange = plan.transactional.some(
              s => s.includes('SET DEFAULT') || s.includes('ALTER COLUMN')
            );
            expect(hasDefaultChange).toBe(true);
          } catch (error) {
            console.error(`Default change detection failed: ${default1} → ${default2}`);
            throw error;
          }
        }
      ),
      {
        numRuns: 25,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: removing default is detected", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }),
        tableName,
        columnName,
        async (defaultValue, tblName, colName) => {
          try {
            // Schema with default
            const schema1 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} INTEGER DEFAULT ${defaultValue}
              );
            `.trim();

            // Schema without default
            const schema2 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} INTEGER
              );
            `.trim();

            await service.apply(schema1, ['public'], true);
            const plan = await service.plan(schema2);

            // Should detect the removal
            expect(plan.hasChanges).toBe(true);

            const hasDropDefault = plan.transactional.some(
              s => s.includes('DROP DEFAULT')
            );
            expect(hasDropDefault).toBe(true);
          } catch (error) {
            console.error(`Default removal detection failed with value: ${defaultValue}`);
            throw error;
          }
        }
      ),
      {
        numRuns: 25,
        verbose: false
      }
    );
  }, { timeout: 120000 });

  test("property: adding default is detected", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }),
        tableName,
        columnName,
        async (defaultValue, tblName, colName) => {
          try {
            // Schema without default
            const schema1 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} INTEGER
              );
            `.trim();

            // Schema with default
            const schema2 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} INTEGER DEFAULT ${defaultValue}
              );
            `.trim();

            await service.apply(schema1, ['public'], true);
            const plan = await service.plan(schema2);

            // Should detect the addition
            expect(plan.hasChanges).toBe(true);

            const hasSetDefault = plan.transactional.some(
              s => s.includes('SET DEFAULT')
            );
            expect(hasSetDefault).toBe(true);
          } catch (error) {
            console.error(`Default addition detection failed with value: ${defaultValue}`);
            throw error;
          }
        }
      ),
      {
        numRuns: 25,
        verbose: false
      }
    );
  }, { timeout: 120000 });
});
