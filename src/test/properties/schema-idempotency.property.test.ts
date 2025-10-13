import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { SchemaService } from "../../core/schema/service";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestDatabaseService } from "../utils";
import { tableSchema, schemaWithTypeAlias, testDataArray } from "./arbitraries";

/**
 * Property-Based Tests for Schema Idempotency
 *
 * These tests generate hundreds of random schemas and verify that core properties
 * always hold true, catching edge cases that manual tests might miss.
 */

describe("Property-Based: Schema Idempotency", () => {
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

  test("property: apply(schema) is always idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('idempotency_test'),
        fc.array(
          fc.record({
            name: fc.constantFrom('col1', 'col2', 'col3', 'value', 'name'),
            type: fc.constantFrom('TEXT', 'INTEGER', 'VARCHAR(255)', 'BOOLEAN'),
            notNull: fc.boolean()
          }),
          { minLength: 1, maxLength: 3 }
        ),
        async (tableName, columns) => {
          try {
            // Clean database before each property iteration
            await cleanDatabase(client);

            // Ensure unique column names
            const uniqueColumns = Array.from(
              new Map(columns.map(c => [c.name, c])).values()
            );

            const columnDefs = uniqueColumns.map(col => {
              let def = `${col.name} ${col.type}`;
              if (col.notNull) {
                const defaultVal = col.type === 'TEXT' || col.type.includes('VARCHAR')
                  ? "'default'"
                  : col.type === 'BOOLEAN' ? 'true' : '0';
                def += ` NOT NULL DEFAULT ${defaultVal}`;
              }
              return def;
            }).join(',\n      ');

            const schema = `
              CREATE TABLE ${tableName} (
                id SERIAL PRIMARY KEY,
                ${columnDefs}
              );
            `.trim();

            // First apply
            await service.apply(schema, ['public'], true);

            // Second apply - should show no changes
            const plan = await service.plan(schema);

            // The fundamental property: applying the same schema twice should result in no changes
            expect(plan.hasChanges).toBe(false);
            expect(plan.transactional.length).toBe(0);
            expect(plan.concurrent.length).toBe(0);
          } catch (error) {
            console.error('Failed with columns:', columns);
            throw error;
          }
        }
      ),
      {
        numRuns: 50,
        verbose: false
      }
    );
  }, { timeout: 120000 }); // 2 minute timeout for 50 schemas

  test("property: equivalent type aliases produce identical schemas", async () => {
    await fc.assert(
      fc.asyncProperty(
        schemaWithTypeAlias,
        async ({ schema1, schema2, tableName }) => {
          try {
            // Apply first schema with type alias 1 (e.g., "int")
            await service.apply(schema1, ['public'], true);

            // Plan second schema with type alias 2 (e.g., "INTEGER")
            // Should show no changes because the types are equivalent
            const plan = await service.plan(schema2);

            expect(plan.hasChanges).toBe(false);
            expect(plan.transactional.length).toBe(0);

            // Verify idempotency in reverse direction
            await cleanDatabase(client);
            await service.apply(schema2, ['public'], true);
            const reversePlan = await service.plan(schema1);

            expect(reversePlan.hasChanges).toBe(false);
            expect(reversePlan.transactional.length).toBe(0);
          } catch (error) {
            console.error('Failed schema pair:');
            console.error('Schema 1:', schema1);
            console.error('Schema 2:', schema2);
            throw error;
          }
        }
      ),
      {
        numRuns: 100,
        verbose: false
      }
    );
  }, { timeout: 240000 }); // 4 minute timeout for 100 schema pairs

  test("property: apply three times is same as apply twice", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('TEXT', 'INTEGER', 'VARCHAR(255)', 'BOOLEAN'),
        fc.constantFrom('test_table'),
        fc.constantFrom('col1', 'col2', 'value'),
        fc.boolean(),
        async (colType, tblName, colName, notNull) => {
          try {
            // Clean database before each property iteration
            await cleanDatabase(client);

            const schema = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} ${colType}${notNull ? ' NOT NULL DEFAULT ' + (colType === 'TEXT' || colType.includes('VARCHAR') ? "'default'" : colType === 'BOOLEAN' ? 'true' : '0') : ''}
              );
            `.trim();

            // Apply once
            await service.apply(schema, ['public'], true);

            // Apply twice
            await service.apply(schema, ['public'], true);

            // Third apply should still show no changes
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error(`Failed with type ${colType}, notNull: ${notNull}`);
            throw error;
          }
        }
      ),
      {
        numRuns: 30,
        verbose: false
      }
    );
  }, { timeout: 90000 });

  test("property: data count preserved after schema reapply", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          tableName: fc.constantFrom('data_test'),
          columnName: fc.constantFrom('name', 'value', 'description')
        }),
        testDataArray('TEXT'),
        async ({ tableName, columnName }, testData) => {
          try {
            // Clean database before each property iteration
            await cleanDatabase(client);

            // Simple schema with TEXT column
            const schema = `
              CREATE TABLE ${tableName} (
                id SERIAL PRIMARY KEY,
                ${columnName} TEXT
              );
            `.trim();

            // Apply initial schema
            await service.apply(schema, ['public'], true);

            // Insert test data
            for (const value of testData) {
              await client.query(
                `INSERT INTO ${tableName} (${columnName}) VALUES ($1)`,
                [value]
              );
            }

            // Get initial count
            const beforeCount = await client.query(`SELECT COUNT(*) FROM ${tableName}`);

            // Reapply same schema
            await service.apply(schema, ['public'], true);

            // Verify count unchanged
            const afterCount = await client.query(`SELECT COUNT(*) FROM ${tableName}`);

            expect(afterCount.rows[0].count).toBe(beforeCount.rows[0].count);
            expect(afterCount.rows[0].count).toBe(testData.length.toString());
          } catch (error) {
            console.error('Test data length:', testData.length);
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

  test("property: planning same schema twice produces same result", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('TEXT', 'INTEGER', 'VARCHAR(100)', 'BOOLEAN'),
        fc.constantFrom('plan_test'),
        fc.constantFrom('col'),
        async (colType, tblName, colName) => {
          try {
            // Clean database before each property iteration
            await cleanDatabase(client);

            const schema = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} ${colType}
              );
            `.trim();

            // Apply schema
            await service.apply(schema, ['public'], true);

            // Plan twice with same schema
            const plan1 = await service.plan(schema);
            const plan2 = await service.plan(schema);

            // Plans should be identical
            expect(plan1.hasChanges).toBe(plan2.hasChanges);
            expect(plan1.transactional.length).toBe(plan2.transactional.length);
            expect(plan1.concurrent.length).toBe(plan2.concurrent.length);

            // Both should show no changes
            expect(plan1.hasChanges).toBe(false);
            expect(plan2.hasChanges).toBe(false);
          } catch (error) {
            console.error(`Failed with type: ${colType}`);
            throw error;
          }
        }
      ),
      {
        numRuns: 30,
        verbose: false
      }
    );
  }, { timeout: 90000 });

  test("property: schema with all nullable columns is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          tableName: fc.constantFrom('nullable_test'),
          columnCount: fc.integer({ min: 1, max: 4 })
        }),
        async ({ tableName, columnCount }) => {
          try {
            // Build schema with all nullable columns
            const columns = Array.from({ length: columnCount }, (_, i) =>
              `col${i} TEXT`
            ).join(',\n      ');

            const schema = `
              CREATE TABLE ${tableName} (
                id SERIAL PRIMARY KEY,
                ${columns}
              );
            `.trim();

            // Apply and verify idempotency
            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error('Failed with column count:', columnCount);
            throw error;
          }
        }
      ),
      {
        numRuns: 25,
        verbose: false
      }
    );
  }, { timeout: 75000 });

  test("property: schema with all NOT NULL columns is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          tableName: fc.constantFrom('notnull_test'),
          columnCount: fc.integer({ min: 1, max: 4 })
        }),
        async ({ tableName, columnCount }) => {
          try {
            // Build schema with all NOT NULL columns
            const columns = Array.from({ length: columnCount }, (_, i) =>
              `col${i} TEXT NOT NULL DEFAULT 'default'`
            ).join(',\n      ');

            const schema = `
              CREATE TABLE ${tableName} (
                id SERIAL PRIMARY KEY,
                ${columns}
              );
            `.trim();

            // Apply and verify idempotency
            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error('Failed with column count:', columnCount);
            throw error;
          }
        }
      ),
      {
        numRuns: 25,
        verbose: false
      }
    );
  }, { timeout: 75000 });
});
