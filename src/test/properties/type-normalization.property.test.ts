import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { SchemaService } from "../../core/schema/service";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestDatabaseService } from "../utils";
import { typeAliasPair, tableName, columnName } from "./arbitraries";

/**
 * Property-Based Tests for Type Normalization
 *
 * Verifies that Terra correctly normalizes PostgreSQL type aliases and treats
 * equivalent types identically across all operations.
 */

describe("Property-Based: Type Normalization", () => {
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

  test("property: type alias pairs are commutative (A→B = B→A)", async () => {
    await fc.assert(
      fc.asyncProperty(
        typeAliasPair,
        tableName,
        columnName,
        async ([type1, type2, canonical], tblName, colName) => {
          try {
            // Test A → B
            const schemaA = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} ${type1}
              );
            `.trim();

            const schemaB = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} ${type2}
              );
            `.trim();

            // Apply A, plan B - should show no changes
            await service.apply(schemaA, ['public'], true);
            const planAtoB = await service.plan(schemaB);
            expect(planAtoB.hasChanges).toBe(false);

            // Test B → A
            await cleanDatabase(client);

            // Apply B, plan A - should show no changes
            await service.apply(schemaB, ['public'], true);
            const planBtoA = await service.plan(schemaA);
            expect(planBtoA.hasChanges).toBe(false);
          } catch (error) {
            console.error(`Failed type pair: ${type1} ↔ ${type2}`);
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

  test("property: case variations of same type are equivalent", async () => {
    const caseVariations = [
      ['INTEGER', 'integer', 'Integer', 'InTeGeR'],
      ['TEXT', 'text', 'Text', 'TeXt'],
      ['BOOLEAN', 'boolean', 'Boolean', 'BoOlEaN']
    ];

    for (const variations of caseVariations) {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...variations),
          fc.constantFrom(...variations),
          tableName,
          columnName,
          async (type1, type2, tblName, colName) => {
            try {
              const schema1 = `
                CREATE TABLE ${tblName} (
                  id SERIAL PRIMARY KEY,
                  ${colName} ${type1}
                );
              `.trim();

              const schema2 = `
                CREATE TABLE ${tblName} (
                  id SERIAL PRIMARY KEY,
                  ${colName} ${type2}
                );
              `.trim();

              await service.apply(schema1, ['public'], true);
              const plan = await service.plan(schema2);

              expect(plan.hasChanges).toBe(false);
            } catch (error) {
              console.error(`Failed case comparison: ${type1} vs ${type2}`);
              throw error;
            }
          }
        ),
        {
          numRuns: 10,
          verbose: false
        }
      );
    }
  }, { timeout: 120000 });

  test("property: type aliases with NOT NULL are equivalent", async () => {
    await fc.assert(
      fc.asyncProperty(
        typeAliasPair,
        tableName,
        columnName,
        async ([type1, type2], tblName, colName) => {
          try {
            const schema1 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} ${type1} NOT NULL
              );
            `.trim();

            const schema2 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} ${type2} NOT NULL
              );
            `.trim();

            await service.apply(schema1, ['public'], true);
            const plan = await service.plan(schema2);

            expect(plan.hasChanges).toBe(false);
            expect(plan.transactional.length).toBe(0);
          } catch (error) {
            console.error(`Failed: ${type1} NOT NULL ↔ ${type2} NOT NULL`);
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

  test("property: type aliases in multiple columns are all normalized", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableName,
        fc.array(
          fc.record({
            name: columnName,
            aliasPair: typeAliasPair
          }),
          { minLength: 2, maxLength: 4 }
        ),
        async (tblName, columns) => {
          try {
            // Ensure unique column names
            const uniqueColumns = Array.from(
              new Map(columns.map(c => [c.name, c])).values()
            );

            if (uniqueColumns.length < 2) {
              return; // Skip if we don't have at least 2 unique columns
            }

            // Schema with first type alias of each pair
            const columns1 = uniqueColumns
              .map(c => `${c.name} ${c.aliasPair[0]}`)
              .join(',\n      ');

            const schema1 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${columns1}
              );
            `.trim();

            // Schema with second type alias of each pair
            const columns2 = uniqueColumns
              .map(c => `${c.name} ${c.aliasPair[1]}`)
              .join(',\n      ');

            const schema2 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${columns2}
              );
            `.trim();

            await service.apply(schema1, ['public'], true);
            const plan = await service.plan(schema2);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error('Failed multi-column type alias test');
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

  test("property: VARCHAR with same length is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1000 }),
        tableName,
        columnName,
        async (length, tblName, colName) => {
          try {
            const schema = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} VARCHAR(${length})
              );
            `.trim();

            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error(`Failed VARCHAR(${length})`);
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

  test("property: integer type aliases with positive defaults", async () => {
    const integerTypes = ['INTEGER', 'int', 'int4', 'SMALLINT', 'int2', 'BIGINT', 'int8'];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...integerTypes),
        fc.constantFrom(...integerTypes),
        fc.integer({ min: 0, max: 1000 }),
        fc.constantFrom('alias_test'),
        columnName,
        async (type1, type2, defaultValue, tblName, colName) => {
          try {
            // Clean database before each property iteration
            await cleanDatabase(client);

            // Skip if types aren't in the same category (e.g., SMALLINT vs BIGINT vs INTEGER)
            const getCategory = (t: string) => {
              const lower = t.toLowerCase();
              if (lower.includes('small') || lower === 'int2') return 'small';
              if (lower.includes('big') || lower === 'int8') return 'big';
              if (lower.includes('int') || lower === 'int4') return 'regular';
              return 'other';
            };

            if (getCategory(type1) !== getCategory(type2)) {
              return; // Skip incompatible type pairs
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

            expect(plan.hasChanges).toBe(false);
          } catch (error) {
            console.error(`Failed: ${type1} vs ${type2} with default ${defaultValue}`);
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

  test("property: type normalization is transitive (if A≡B and B≡C then A≡C)", async () => {
    // Test transitivity with INTEGER, int, int4
    const transitiveChain = ['INTEGER', 'int', 'int4'];

    await fc.assert(
      fc.asyncProperty(
        tableName,
        columnName,
        async (tblName, colName) => {
          try {
            // Create with first type
            const schema1 = `
              CREATE TABLE ${tblName} (
                id SERIAL PRIMARY KEY,
                ${colName} ${transitiveChain[0]}
              );
            `.trim();

            await service.apply(schema1, ['public'], true);

            // Verify all types in chain are equivalent
            for (const type of transitiveChain) {
              const schema = `
                CREATE TABLE ${tblName} (
                  id SERIAL PRIMARY KEY,
                  ${colName} ${type}
                );
              `.trim();

              const plan = await service.plan(schema);
              expect(plan.hasChanges).toBe(false);
            }
          } catch (error) {
            console.error('Transitivity test failed for:', transitiveChain);
            throw error;
          }
        }
      ),
      {
        numRuns: 15,
        verbose: false
      }
    );
  }, { timeout: 75000 });
});
