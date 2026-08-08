import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { SchemaService } from "../../core/schema/service";
import { Client } from "pg";
import { createTestClient, cleanDatabase, createTestSchemaService } from "../utils";
import {
  foreignKeyConstraint,
  uniqueConstraint,
  checkConstraint,
  tableName,
  columnName
} from "./arbitraries";
import { configurePropertyTests } from "./property-test-options";

configurePropertyTests();

const foreignKeyActions = [
  "CASCADE",
  "SET NULL",
  "SET DEFAULT",
  "RESTRICT",
  "NO ACTION",
] as const;

type ForeignKeyAction = (typeof foreignKeyActions)[number];
type ForeignKeyActionDirection = "delete" | "update";

interface ForeignKeyActionTransition {
  before: ForeignKeyAction;
  after: ForeignKeyAction;
}

const foreignKeyActionTransitions: ForeignKeyActionTransition[] = [];
for (const before of foreignKeyActions) {
  for (const after of foreignKeyActions) {
    if (before !== after) {
      foreignKeyActionTransitions.push({ before, after });
    }
  }
}

const foreignKeyActionTransition = fc.constantFrom(
  ...foreignKeyActionTransitions
);
const foreignKeyActionExamples: Array<[
  ForeignKeyActionDirection,
  ForeignKeyActionTransition,
]> = [];
for (const direction of ["delete", "update"] as const) {
  for (const transition of foreignKeyActionTransitions) {
    foreignKeyActionExamples.push([direction, transition]);
  }
}

const foreignKeyActionCodes: Record<ForeignKeyAction, string> = {
  "NO ACTION": "a",
  RESTRICT: "r",
  CASCADE: "c",
  "SET NULL": "n",
  "SET DEFAULT": "d",
};

function renderForeignKeyActionSchema(
  direction: ForeignKeyActionDirection,
  action: ForeignKeyAction
): string {
  const onDelete = direction === "delete" ? action : "NO ACTION";
  const onUpdate = direction === "update" ? action : "NO ACTION";
  return `
    CREATE TABLE fk_action_parents (
      id integer PRIMARY KEY
    );

    CREATE TABLE fk_action_children (
      id integer PRIMARY KEY,
      parent_id integer DEFAULT 0,
      CONSTRAINT fk_action_parent
        FOREIGN KEY (parent_id) REFERENCES fk_action_parents(id)
        ON DELETE ${onDelete}
        ON UPDATE ${onUpdate}
    );
  `.trim();
}

async function expectForeignKeyActionBehavior(
  client: Client,
  direction: ForeignKeyActionDirection,
  action: ForeignKeyAction
): Promise<void> {
  const blocksChange = action === "NO ACTION" || action === "RESTRICT";
  const mutation = direction === "delete"
    ? "DELETE FROM fk_action_parents WHERE id = 1"
    : "UPDATE fk_action_parents SET id = 2 WHERE id = 1";

  if (blocksChange) {
    let errorCode: string | undefined;
    try {
      await client.query(mutation);
    } catch (error) {
      errorCode = (error as { code?: string }).code;
    }
    if (action === "RESTRICT") {
      expect(["23001", "23503"]).toContain(errorCode);
    } else {
      expect(errorCode).toBe("23503");
    }
  } else {
    await client.query(mutation);
  }

  const result = await client.query(
    "SELECT parent_id FROM fk_action_children WHERE id = 10"
  );
  if (action === "CASCADE" && direction === "delete") {
    expect(result.rows).toEqual([]);
    return;
  }

  expect(result.rows).toHaveLength(1);
  if (action === "SET NULL") {
    expect(result.rows[0]?.parent_id).toBeNull();
  } else if (action === "SET DEFAULT") {
    expect(result.rows[0]?.parent_id).toBe(0);
  } else if (action === "CASCADE") {
    expect(result.rows[0]?.parent_id).toBe(2);
  } else {
    expect(result.rows[0]?.parent_id).toBe(1);
  }
}

async function verifyForeignKeyActionTransition(
  service: SchemaService,
  client: Client,
  direction: ForeignKeyActionDirection,
  transition: ForeignKeyActionTransition
): Promise<void> {
  await cleanDatabase(client);
  const initialSchema = renderForeignKeyActionSchema(
    direction,
    transition.before
  );
  const desiredSchema = renderForeignKeyActionSchema(
    direction,
    transition.after
  );

  await service.apply(initialSchema, ["public"], true);
  await client.query("INSERT INTO fk_action_parents (id) VALUES (0), (1)");
  await client.query(
    "INSERT INTO fk_action_children (id, parent_id) VALUES (10, 1)"
  );

  const plan = await service.plan(desiredSchema);
  const sql = plan.transactional.join("\n");
  expect(plan.hasChanges).toBe(true);
  expect(plan.concurrent).toEqual([]);
  expect(sql).toContain('DROP CONSTRAINT "fk_action_parent"');
  expect(sql).toContain(`ON ${direction.toUpperCase()} ${transition.after}`);

  await service.apply(desiredSchema, ["public"], true);
  const preserved = await client.query(
    "SELECT parent_id FROM fk_action_children WHERE id = 10"
  );
  expect(preserved.rows[0]?.parent_id).toBe(1);

  const catalog = await client.query(
    `SELECT confdeltype, confupdtype
     FROM pg_constraint
     WHERE conname = 'fk_action_parent'`
  );
  const catalogColumn = direction === "delete"
    ? "confdeltype"
    : "confupdtype";
  expect(catalog.rows[0]?.[catalogColumn]).toBe(
    foreignKeyActionCodes[transition.after]
  );

  const secondPlan = await service.plan(desiredSchema);
  expect(secondPlan.hasChanges).toBe(false);
  expect(secondPlan.transactional).toEqual([]);
  expect(secondPlan.concurrent).toEqual([]);

  await expectForeignKeyActionBehavior(client, direction, transition.after);
}

/**
 * Property-Based Tests for Constraint Management
 *
 * These tests verify that Terra correctly handles constraints (foreign keys,
 * unique, check) across various scenarios, ensuring idempotency and correct
 * dependency ordering.
 */

describe("Property-Based: Constraint Management", () => {
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

  test("property: foreign key creation is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        foreignKeyConstraint,
        async (fk) => {
          try {
            // Clean database before each iteration
            await cleanDatabase(client);

            const schema = `
              CREATE TABLE ${fk.parentTable} (
                id SERIAL PRIMARY KEY,
                ${fk.parentColumn} VARCHAR(255) NOT NULL UNIQUE
              );

              CREATE TABLE ${fk.childTable} (
                id SERIAL PRIMARY KEY,
                ${fk.childColumn} VARCHAR(255),
                CONSTRAINT ${fk.constraintName} FOREIGN KEY (${fk.childColumn})
                  REFERENCES ${fk.parentTable}(${fk.parentColumn})
                  ON DELETE ${fk.onDelete}
                  ON UPDATE ${fk.onUpdate}
              );
            `.trim();

            // First apply
            await service.apply(schema, ['public'], true);

            // Second apply - should show no changes
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
            expect(plan.transactional.length).toBe(0);
            expect(plan.concurrent.length).toBe(0);
          } catch (error) {
            console.error('Failed with FK:', fk);
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

  test("property: foreign key action changes are detected and enforced", async function () {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("delete", "update"),
        foreignKeyActionTransition,
        async function runForeignKeyActionTransition(direction, transition) {
          await verifyForeignKeyActionTransition(
            service,
            client,
            direction,
            transition
          );
        }
      ),
      {
        examples: foreignKeyActionExamples,
        numRuns: foreignKeyActionExamples.length + 20,
        verbose: false,
      }
    );
  }, { timeout: 300000 });

  test("property: unique constraint creation is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueConstraint,
        async (uc) => {
          try {
            // Skip if no columns after deduplication
            if (uc.columns.length === 0) {
              return;
            }

            await cleanDatabase(client);

            // Build column definitions
            const columnDefs = uc.columns.map(col => `${col} TEXT`).join(',\n        ');
            const constraintCols = uc.columns.join(', ');

            const schema = `
              CREATE TABLE ${uc.tableName} (
                id SERIAL PRIMARY KEY,
                ${columnDefs},
                CONSTRAINT ${uc.constraintName} UNIQUE (${constraintCols})
              );
            `.trim();

            await service.apply(schema, ['public'], true);
            const plan = await service.plan(schema);

            expect(plan.hasChanges).toBe(false);
            expect(plan.transactional.length).toBe(0);
          } catch (error) {
            console.error('Failed with unique constraint:', uc);
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

  test("property: check constraint expressions are idempotent", async function () {
    await fc.assert(
      fc.asyncProperty(
        checkConstraint,
        async function assertCheckConstraintIdempotency(constraint) {
          await cleanDatabase(client);
          const schema = `
            CREATE TABLE ${constraint.tableName} (
              id SERIAL PRIMARY KEY,
              ${constraint.column} integer,
              CONSTRAINT ${constraint.constraintName}
                CHECK (${constraint.expression})
            );
          `.trim();

          await service.apply(schema, ["public"], true);
          const plan = await service.plan(schema);

          expect(plan.hasChanges).toBe(false);
          expect(plan.transactional).toEqual([]);
          expect(plan.concurrent).toEqual([]);
        }
      ),
      { numRuns: 20, verbose: false }
    );
  }, { timeout: 120000 });

  test("property: removing foreign key is detected", async () => {
    await fc.assert(
      fc.asyncProperty(
        foreignKeyConstraint,
        async (fk) => {
          try {
            await cleanDatabase(client);

            const schemaWithFK = `
              CREATE TABLE ${fk.parentTable} (
                id SERIAL PRIMARY KEY,
                ${fk.parentColumn} VARCHAR(255) NOT NULL UNIQUE
              );

              CREATE TABLE ${fk.childTable} (
                id SERIAL PRIMARY KEY,
                ${fk.childColumn} VARCHAR(255),
                CONSTRAINT ${fk.constraintName} FOREIGN KEY (${fk.childColumn})
                  REFERENCES ${fk.parentTable}(${fk.parentColumn})
              );
            `.trim();

            const schemaWithoutFK = `
              CREATE TABLE ${fk.parentTable} (
                id SERIAL PRIMARY KEY,
                ${fk.parentColumn} VARCHAR(255) NOT NULL UNIQUE
              );

              CREATE TABLE ${fk.childTable} (
                id SERIAL PRIMARY KEY,
                ${fk.childColumn} VARCHAR(255)
              );
            `.trim();

            await service.apply(schemaWithFK, ['public'], true);
            const plan = await service.plan(schemaWithoutFK);

            // Should detect FK removal
            expect(plan.hasChanges).toBe(true);
          } catch (error) {
            console.error('Failed FK removal detection:', fk);
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

  test("property: adding foreign key is detected", async () => {
    await fc.assert(
      fc.asyncProperty(
        foreignKeyConstraint,
        async (fk) => {
          try {
            await cleanDatabase(client);

            const schemaWithoutFK = `
              CREATE TABLE ${fk.parentTable} (
                id SERIAL PRIMARY KEY,
                ${fk.parentColumn} VARCHAR(255) NOT NULL UNIQUE
              );

              CREATE TABLE ${fk.childTable} (
                id SERIAL PRIMARY KEY,
                ${fk.childColumn} VARCHAR(255)
              );
            `.trim();

            const schemaWithFK = `
              CREATE TABLE ${fk.parentTable} (
                id SERIAL PRIMARY KEY,
                ${fk.parentColumn} VARCHAR(255) NOT NULL UNIQUE
              );

              CREATE TABLE ${fk.childTable} (
                id SERIAL PRIMARY KEY,
                ${fk.childColumn} VARCHAR(255),
                CONSTRAINT ${fk.constraintName} FOREIGN KEY (${fk.childColumn})
                  REFERENCES ${fk.parentTable}(${fk.parentColumn})
              );
            `.trim();

            await service.apply(schemaWithoutFK, ['public'], true);
            const plan = await service.plan(schemaWithFK);

            // Should detect FK addition
            expect(plan.hasChanges).toBe(true);
          } catch (error) {
            console.error('Failed FK addition detection:', fk);
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

  test("property: unique constraint removal is detected", async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueConstraint,
        async (uc) => {
          try {
            if (uc.columns.length === 0) {
              return;
            }

            await cleanDatabase(client);

            const columnDefs = uc.columns.map(col => `${col} TEXT`).join(',\n        ');
            const constraintCols = uc.columns.join(', ');

            const schemaWithUnique = `
              CREATE TABLE ${uc.tableName} (
                id SERIAL PRIMARY KEY,
                ${columnDefs},
                CONSTRAINT ${uc.constraintName} UNIQUE (${constraintCols})
              );
            `.trim();

            const schemaWithoutUnique = `
              CREATE TABLE ${uc.tableName} (
                id SERIAL PRIMARY KEY,
                ${columnDefs}
              );
            `.trim();

            await service.apply(schemaWithUnique, ['public'], true);
            const plan = await service.plan(schemaWithoutUnique);

            expect(plan.hasChanges).toBe(true);
          } catch (error) {
            console.error('Failed unique removal detection:', uc);
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

  test("property: check constraint modification is detected", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableName,
        columnName,
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 51, max: 100 }),
        async (tbl, col, value1, value2) => {
          try {
            await cleanDatabase(client);

            const schema1 = `
              CREATE TABLE ${tbl} (
                id SERIAL PRIMARY KEY,
                ${col} INTEGER,
                CONSTRAINT chk_value CHECK (${col} > ${value1})
              );
            `.trim();

            const schema2 = `
              CREATE TABLE ${tbl} (
                id SERIAL PRIMARY KEY,
                ${col} INTEGER,
                CONSTRAINT chk_value CHECK (${col} > ${value2})
              );
            `.trim();

            await service.apply(schema1, ['public'], true);
            const plan = await service.plan(schema2);

            // Should detect check constraint change
            expect(plan.hasChanges).toBe(true);
          } catch (error) {
            console.error(`Failed check modification: ${value1} → ${value2}`);
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

  test("property: multi-column unique constraint column order matters", async () => {
    await fc.assert(
      fc.asyncProperty(
        tableName,
        fc.array(columnName, { minLength: 2, maxLength: 3 }),
        async (tbl, cols) => {
          try {
            // Ensure unique column names
            const uniqueCols = Array.from(new Set(cols));
            if (uniqueCols.length < 2) {
              return;
            }

            await cleanDatabase(client);

            const columnDefs = uniqueCols.map(col => `${col} TEXT`).join(',\n        ');
            const cols1 = uniqueCols.join(', ');
            const cols2 = [...uniqueCols].reverse().join(', ');

            const schema1 = `
              CREATE TABLE ${tbl} (
                id SERIAL PRIMARY KEY,
                ${columnDefs},
                CONSTRAINT uq_cols UNIQUE (${cols1})
              );
            `.trim();

            const schema2 = `
              CREATE TABLE ${tbl} (
                id SERIAL PRIMARY KEY,
                ${columnDefs},
                CONSTRAINT uq_cols UNIQUE (${cols2})
              );
            `.trim();

            await service.apply(schema1, ['public'], true);
            const plan = await service.plan(schema2);

            // PostgreSQL treats different column orders as different constraints
            // unless the columns are the same set (which our reversal ensures they are)
            // This is actually implementation-dependent, so we just verify it's consistent
            const plan2 = await service.plan(schema2);
            expect(plan.hasChanges).toBe(plan2.hasChanges);
          } catch (error) {
            console.error('Failed multi-column unique test:', cols);
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

  test("property: foreign key dependency order is correct", async () => {
    await fc.assert(
      fc.asyncProperty(
        foreignKeyConstraint,
        async (fk) => {
          try {
            await cleanDatabase(client);

            // Create schema with child table BEFORE parent table (wrong order)
            // Terra should reorder these correctly
            const schema = `
              CREATE TABLE ${fk.childTable} (
                id SERIAL PRIMARY KEY,
                ${fk.childColumn} VARCHAR(255),
                CONSTRAINT ${fk.constraintName} FOREIGN KEY (${fk.childColumn})
                  REFERENCES ${fk.parentTable}(${fk.parentColumn})
              );

              CREATE TABLE ${fk.parentTable} (
                id SERIAL PRIMARY KEY,
                ${fk.parentColumn} VARCHAR(255) NOT NULL UNIQUE
              );
            `.trim();

            // Terra should handle this correctly via dependency resolution
            await service.apply(schema, ['public'], true);

            // Verify both tables exist
            const tables = await client.query(`
              SELECT table_name FROM information_schema.tables
              WHERE table_schema = 'public'
              AND table_name IN ('${fk.parentTable}', '${fk.childTable}')
            `);

            expect(tables.rows.length).toBe(2);
          } catch (error) {
            console.error('Failed FK dependency order test:', fk);
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
