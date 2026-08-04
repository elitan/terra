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
          kind: "role",
          key: "role:app_user",
          name: "app_user",
          createStatement:
            'CREATE ROLE "app_user" WITH LOGIN NOSUPERUSER NOCREATEDB ' +
            'NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;',
          roleDefinition: {
            login: true,
            superuser: false,
            createDatabase: false,
            createRole: false,
            inherit: true,
            replication: false,
            bypassRowLevelSecurity: false,
            connectionLimit: -1,
          },
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
            kind: "role",
            key: "role:test_user",
            name: "test_user",
            createStatement:
              'CREATE ROLE "test_user" WITH LOGIN NOSUPERUSER NOCREATEDB ' +
              'NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;',
            dropStatement: 'DROP ROLE IF EXISTS "test_user";',
            roleDefinition: {
              login: true,
              superuser: false,
              createDatabase: false,
              createRole: false,
              inherit: true,
              replication: false,
              bypassRowLevelSecurity: false,
              connectionLimit: -1,
            },
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
      'CREATE ROLE "app_user" WITH LOGIN NOSUPERUSER NOCREATEDB ' +
        'NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;',
      'GRANT SELECT ON TABLE "public"."users" TO "app_user";',
    ]);
    expect(plan.transactional).not.toContain('DROP ROLE IF EXISTS "test_user";');
  });
});
