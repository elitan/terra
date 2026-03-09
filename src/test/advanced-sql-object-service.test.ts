import { describe, expect, test } from "bun:test";
import { SchemaService } from "../core/schema/service";
import type { DatabaseClient, DatabaseProvider, ParsedSchema, ValidationResult } from "../providers/types";
import type { MigrationPlan } from "../types/migration";

function createParsedSchema(overrides: Partial<ParsedSchema> = {}): ParsedSchema {
  return {
    tables: [],
    enums: [],
    views: [],
    functions: [],
    procedures: [],
    triggers: [],
    sequences: [],
    extensions: [],
    schemas: [],
    comments: [],
    sqlObjects: [],
    ...overrides,
  };
}

function createPlan(overrides: Partial<MigrationPlan> = {}): MigrationPlan {
  return {
    transactional: [],
    concurrent: [],
    deferred: [],
    hasChanges: false,
    ...overrides,
  };
}

function createValidation(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    valid: true,
    errors: [],
    warnings: [],
    ...overrides,
  };
}

describe("Advanced SQL object service", function () {
  test("plans sql objects and ignores unrelated global current objects", async function () {
    const parsedSchema = createParsedSchema({
      sqlObjects: [
        {
          kind: "user",
          key: "user:app_user",
          name: "app_user",
          createStatement: 'CREATE USER "app_user" WITH LOGIN;',
        },
        {
          kind: "grant",
          key: 'grant:GRANT SELECT ON TABLE "public"."users" TO "app_user";',
          name: 'GRANT SELECT ON TABLE "public"."users" TO "app_user";',
          schema: "public",
          createStatement: 'GRANT SELECT ON TABLE "public"."users" TO "app_user";',
        },
      ],
    });

    const client: DatabaseClient = {
      query: async function () {
        return { rows: [] };
      },
      end: async function () {},
    };

    const provider: DatabaseProvider = {
      dialect: "postgres",
      createClient: async function () {
        return client;
      },
      parseSchema: async function () {
        return parsedSchema;
      },
      getCurrentSchema: async function () {
        return [];
      },
      getCurrentEnums: async function () {
        return [];
      },
      getCurrentViews: async function () {
        return [];
      },
      getCurrentFunctions: async function () {
        return [];
      },
      getCurrentProcedures: async function () {
        return [];
      },
      getCurrentTriggers: async function () {
        return [];
      },
      getCurrentSequences: async function () {
        return [];
      },
      getCurrentExtensions: async function () {
        return [];
      },
      getCurrentSchemas: async function () {
        return [];
      },
      getCurrentComments: async function () {
        return [];
      },
      getCurrentSqlObjects: async function () {
        return [
          {
            kind: "user",
            key: "user:test_user",
            name: "test_user",
            createStatement: 'CREATE USER "test_user" WITH LOGIN;',
            dropStatement: 'DROP USER IF EXISTS "test_user";',
          },
        ];
      },
      generateMigrationPlan: function () {
        return createPlan();
      },
      supportsFeature: function () {
        return true;
      },
      validateSchema: function () {
        return createValidation();
      },
      executeInTransaction: async function () {},
    };

    const service = new SchemaService(provider, {
      dialect: "postgres",
      host: "localhost",
      port: 5432,
      database: "test",
      user: "test",
      password: "test",
    });

    const plan = await service.plan("ignored");

    expect(plan.transactional).toEqual([
      'CREATE USER "app_user" WITH LOGIN;',
      'GRANT SELECT ON TABLE "public"."users" TO "app_user";',
    ]);
    expect(plan.transactional).not.toContain('DROP USER IF EXISTS "test_user";');
  });
});
