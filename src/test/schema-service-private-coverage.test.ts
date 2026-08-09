import { describe, expect, mock, test } from "bun:test";
import { readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadModule } from "pgsql-parser";
import { SchemaService } from "../core/schema/service";
import { generateStatements } from "../core/schema/handlers/base-handler";
import { TriggerHandler } from "../core/schema/handlers/trigger-handler";
import type { DatabaseClient, DatabaseProvider, ParsedSchema, ValidationResult } from "../providers/types";
import { StrictModeError } from "../types/errors";
import type { MigrationContext, MigrationPlan } from "../types/migration";
import type { Trigger } from "../types/schema";

let promptAnswer = "yes";

mock.module("readline", function () {
  return {
    createInterface: function () {
      return {
        question: function (_message: string, callback: (value: string) => void) {
          callback(promptAnswer);
        },
        close: function () {},
      };
    },
  };
});

interface MockState {
  clientEndCalls: number;
  clientQueries: string[];
  executionOrder: string[];
  parseCalls: Array<[string, string | undefined]>;
  executeInTransactionCalls: string[][];
  acquireCalls: string[];
  releaseCalls: string[];
  migrationContexts: Array<MigrationContext | undefined>;
}

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
    ...overrides,
  };
}

function createPlan(overrides: Partial<MigrationPlan> = {}): MigrationPlan {
  return {
    preTransactional: [],
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

function createMockProvider(options: {
  dialect?: DatabaseProvider["dialect"];
  parsedSchema?: ParsedSchema;
  plan?: MigrationPlan;
  validation?: ValidationResult;
  features?: Set<string>;
  migrationContext?: MigrationContext;
} = {}): { provider: DatabaseProvider; state: MockState } {
  const state: MockState = {
    clientEndCalls: 0,
    clientQueries: [],
    executionOrder: [],
    parseCalls: [],
    executeInTransactionCalls: [],
    acquireCalls: [],
    releaseCalls: [],
    migrationContexts: [],
  };

  const parsedSchema = options.parsedSchema ?? createParsedSchema();
  const plan = options.plan ?? createPlan();
  const validation = options.validation ?? createValidation();
  const features = options.features ?? new Set<string>();

  const client: DatabaseClient = {
    query: async function (sql: string) {
      state.clientQueries.push(sql);
      state.executionOrder.push(`query:${sql}`);
      return { rows: [] };
    },
    end: async function () {
      state.clientEndCalls += 1;
    },
  };

  const provider: DatabaseProvider = {
    dialect: options.dialect ?? "postgres",
    createClient: async function () {
      return client;
    },
    parseSchema: async function (sql: string, filePath?: string) {
      state.parseCalls.push([sql, filePath]);
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
    getMigrationContext: async function () {
      return options.migrationContext || {};
    },
    generateMigrationPlan: function (_desired, _current, context) {
      state.migrationContexts.push(context);
      return {
        transactional: [...plan.transactional],
        concurrent: [...plan.concurrent],
        deferred: [...plan.deferred],
        hasChanges: plan.hasChanges,
      };
    },
    supportsFeature: function (feature) {
      return features.has(feature);
    },
    validateSchema: function () {
      return validation;
    },
    executeInTransaction: async function (_client, statements) {
      state.executeInTransactionCalls.push([...statements]);
      state.executionOrder.push(...statements.map(function (statement) {
        return `transaction:${statement}`;
      }));
    },
    acquireAdvisoryLock: async function (_client, lockOptions) {
      state.acquireCalls.push(lockOptions.lockName);
    },
    releaseAdvisoryLock: async function (_client, lockName) {
      state.releaseCalls.push(lockName);
    },
  };

  return { provider, state };
}

function createService(provider: DatabaseProvider): SchemaService {
  if (provider.dialect === "sqlite") {
    return new SchemaService(provider, {
      dialect: "sqlite",
      filename: ":memory:",
    });
  }
  return new SchemaService(provider, {
    dialect: "postgres",
    host: "localhost",
    port: 5432,
    database: "test",
    user: "test",
    password: "test",
  });
}

describe("SchemaService private coverage", function () {
  test("validates PostgreSQL-only type modifiers only for PostgreSQL", async function () {
    const invalidNumeric = createParsedSchema({
      tables: [{
        name: "measurements",
        columns: [{ name: "value", type: "NUMERIC(0)" }],
      }],
    });
    const postgres = createMockProvider({
      parsedSchema: invalidNumeric,
      migrationContext: { postgresVersionNum: 180000 },
    });
    await expect(
      createService(postgres.provider).plan("CREATE TABLE measurements")
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/numeric precision 0/i),
    });

    const sqlite = createMockProvider({
      dialect: "sqlite",
      parsedSchema: invalidNumeric,
    });
    await expect(
      createService(sqlite.provider).plan("CREATE TABLE measurements")
    ).resolves.toMatchObject({ hasChanges: false });

    const invalidTemporal = createParsedSchema({
      tables: [{
        name: "events",
        columns: [{ name: "recorded_at", type: "TIMESTAMP(7)" }],
      }],
    });
    const temporalPostgres = createMockProvider({
      parsedSchema: invalidTemporal,
      migrationContext: { postgresVersionNum: 180000 },
    });
    await expect(
      createService(temporalPostgres.provider).plan("CREATE TABLE events")
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/temporal precision 7/i),
    });

    const temporalSqlite = createMockProvider({
      dialect: "sqlite",
      parsedSchema: invalidTemporal,
    });
    await expect(
      createService(temporalSqlite.provider).plan("CREATE TABLE events")
    ).resolves.toMatchObject({ hasChanges: false });

    const invalidLength = createParsedSchema({
      tables: [{
        name: "labels",
        columns: [{ name: "value", type: "VARCHAR(0)" }],
      }],
    });
    const lengthPostgres = createMockProvider({
      parsedSchema: invalidLength,
      migrationContext: { postgresVersionNum: 180000 },
    });
    await expect(
      createService(lengthPostgres.provider).plan("CREATE TABLE labels")
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/VARCHAR length 0/i),
    });

    const lengthSqlite = createMockProvider({
      dialect: "sqlite",
      parsedSchema: invalidLength,
    });
    await expect(
      createService(lengthSqlite.provider).plan("CREATE TABLE labels")
    ).resolves.toMatchObject({ hasChanges: false });
  });

  test("generateStatements preserves array creates and matching managed objects", function () {
    interface Item {
      name: string;
    }

    const config = {
      name: "item",
      getKey: function getKey(item: Item) {
        return item.name;
      },
      generateDrop: function generateDrop(item: Item) {
        return `DROP ${item.name}`;
      },
      generateCreate: function generateCreate(item: Item) {
        return [`CREATE ${item.name}`, `ALTER ${item.name}`];
      },
      needsUpdate: function needsUpdate() {
        return false;
      },
    };

    expect(generateStatements([{ name: "new" }], [], config)).toEqual([
      "CREATE new",
      "ALTER new",
    ]);
    expect(generateStatements(
      [{ name: "existing" }],
      [{ name: "existing" }],
      config
    )).toEqual([]);
  });

  test("trigger comparison distinguishes equal arrays from changed arguments", function () {
    const handler = new TriggerHandler();
    const current: Trigger = {
      name: "audit_orders",
      tableName: "orders",
      schema: "public",
      timing: "AFTER",
      events: ["INSERT", "UPDATE"],
      updateColumns: ["status", "name"],
      functionName: "audit_row",
      functionSchema: "public",
      functionArgs: ["current"],
    };

    expect(handler.generateStatements([{ ...current }], [current])).toEqual([]);
    expect(handler.generateStatements([
      { ...current, functionArgs: ["desired"] },
    ], [current])).toEqual([
      'DROP TRIGGER IF EXISTS "audit_orders" ON "public"."orders";',
      expect.stringContaining("CREATE TRIGGER"),
    ]);
  });

  test("parseSchemaInput reads file path input", async function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);
    const filePath = join(tmpdir(), `terradb-schema-${Date.now()}.sql`);
    const sql = "CREATE TABLE users (id INT);";

    await writeFile(filePath, sql, "utf-8");

    try {
      const parsed = await (service as unknown as { parseSchemaInput: (input: string) => Promise<ParsedSchema> }).parseSchemaInput(filePath);
      expect(parsed.tables).toHaveLength(0);
      expect(mock.state.parseCalls).toEqual([[sql, filePath]]);
      const saved = await readFile(filePath, "utf-8");
      expect(saved).toBe(sql);
    } finally {
      await unlink(filePath);
    }
  });

  test("parseSchemaInput handles empty and inline sql input", async function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);
    const privateService = service as unknown as { parseSchemaInput: (input: string) => Promise<ParsedSchema> };

    await privateService.parseSchemaInput("");
    await privateService.parseSchemaInput("CREATE TABLE posts (id INT);");

    expect(mock.state.parseCalls).toEqual([
      ["", undefined],
      ["CREATE TABLE posts (id INT);", undefined],
    ]);
  });

  test("parseSchemaInput reads sql files even when file path contains sql keywords", async function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);
    const privateService = service as unknown as { parseSchemaInput: (input: string) => Promise<ParsedSchema> };
    const filePath = join(tmpdir(), `terradb-with-view-${Date.now()}.sql`);
    const sql = "CREATE VIEW active_users AS SELECT 1;";

    await writeFile(filePath, sql, "utf-8");

    try {
      await privateService.parseSchemaInput(filePath);
      expect(mock.state.parseCalls).toEqual([[sql, filePath]]);
    } finally {
      await unlink(filePath);
    }
  });

  test("parseSchemaInput reads keyworded file paths without sql extension", async function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);
    const privateService = service as unknown as { parseSchemaInput: (input: string) => Promise<ParsedSchema> };
    const filePath = join(tmpdir(), `terradb-select-keyword-${Date.now()}`);
    const sql = "CREATE TABLE users (id INT);";

    await writeFile(filePath, sql, "utf-8");

    try {
      await privateService.parseSchemaInput(filePath);
      expect(mock.state.parseCalls).toEqual([[sql, filePath]]);
    } finally {
      await unlink(filePath);
    }
  });

  test("filterUnmanagedSchemas and countObjects filter by managed schemas", function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);

    const parsed = createParsedSchema({
      tables: [{ name: "users", schema: "public", columns: [] }, { name: "audit", schema: "internal", columns: [] }],
      enums: [{ name: "state", schema: "public", values: ["a"] }, { name: "status", schema: "internal", values: ["x"] }],
      views: [{ name: "v_users", schema: "public", definition: "SELECT 1" }, { name: "v_audit", schema: "internal", definition: "SELECT 1" }],
      functions: [
        { name: "f_public", schema: "public", parameters: [], returnType: "void", language: "sql", body: "SELECT 1" },
        { name: "f_internal", schema: "internal", parameters: [], returnType: "void", language: "sql", body: "SELECT 1" },
      ],
      procedures: [
        { name: "p_public", schema: "public", parameters: [], language: "sql", body: "SELECT 1" },
        { name: "p_internal", schema: "internal", parameters: [], language: "sql", body: "SELECT 1" },
      ],
      triggers: [
        { name: "t_public", tableName: "users", schema: "public", timing: "AFTER", events: ["INSERT"], functionName: "f_public" },
        { name: "t_internal", tableName: "audit", schema: "internal", timing: "AFTER", events: ["INSERT"], functionName: "f_internal" },
      ],
      sequences: [{ name: "public_seq", schema: "public" }, { name: "internal_seq", schema: "internal" }],
      extensions: [{ name: "pgcrypto", schema: "public" }],
      schemas: [{ name: "public" }, { name: "internal" }],
      comments: [
        { objectType: "TABLE", objectName: "users", schemaName: "public", comment: "ok" },
        { objectType: "TABLE", objectName: "audit", schemaName: "internal", comment: "skip" },
        { objectType: "SCHEMA", objectName: "public", comment: "managed schema" },
        { objectType: "SCHEMA", objectName: "internal", comment: "unmanaged schema" },
      ],
    });

    const privateService = service as unknown as {
      filterUnmanagedSchemas: (schemas: string[], input: ParsedSchema) => ParsedSchema;
      countObjects: (input: ParsedSchema) => number;
    };

    const filtered = privateService.filterUnmanagedSchemas(["public"], parsed);

    expect(filtered.tables).toHaveLength(1);
    expect(filtered.enums).toHaveLength(1);
    expect(filtered.views).toHaveLength(1);
    expect(filtered.functions).toHaveLength(1);
    expect(filtered.procedures).toHaveLength(1);
    expect(filtered.triggers).toHaveLength(1);
    expect(filtered.sequences).toHaveLength(1);
    expect(filtered.extensions).toHaveLength(1);
    expect(filtered.schemas).toHaveLength(1);
    expect(filtered.comments).toEqual([
      {
        objectType: "TABLE",
        objectName: "users",
        schemaName: "public",
        comment: "ok",
      },
      {
        objectType: "SCHEMA",
        objectName: "public",
        comment: "managed schema",
      },
    ]);

    expect(privateService.countObjects(parsed)).toBe(14);
    expect(privateService.countObjects(filtered)).toBe(7);
  });

  test("filterCurrentSqlObjects retains scoped objects and desired global objects", function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);
    const privateService = service as unknown as {
      filterCurrentSqlObjects: (
        current: NonNullable<ParsedSchema["sqlObjects"]>,
        desired: NonNullable<ParsedSchema["sqlObjects"]>,
        schemas?: ParsedSchema["schemas"]
      ) => NonNullable<ParsedSchema["sqlObjects"]>;
    };
    const scopedPolicy = {
      kind: "policy" as const,
      key: "policy:public.users:tenant_policy",
      name: "tenant_policy",
      schema: "public",
      createStatement: "CREATE POLICY tenant_policy ON public.users USING (true);",
    };
    const desiredRole = {
      kind: "role" as const,
      key: "role:app_user",
      name: "app_user",
      createStatement: "CREATE ROLE app_user;",
    };
    const unrelatedRole = {
      kind: "role" as const,
      key: "role:external_user",
      name: "external_user",
      createStatement: "CREATE ROLE external_user;",
    };
    const desiredServer = {
      kind: "foreign-server" as const,
      key: "foreign-server:analytics",
      name: "analytics",
      createStatement: "CREATE SERVER analytics FOREIGN DATA WRAPPER postgres_fdw;",
    };
    const serverGrant = {
      kind: "grant" as const,
      key: 'grant:GRANT USAGE ON FOREIGN SERVER "analytics" TO "reader";',
      name: 'GRANT USAGE ON FOREIGN SERVER "analytics" TO "reader";',
      createStatement: 'GRANT USAGE ON FOREIGN SERVER "analytics" TO "reader";',
      grantDefinition: {
        objectType: "FOREIGN SERVER" as const,
        objectName: "analytics",
        grantee: "reader",
        granteeIsPublic: false,
        privilege: "USAGE",
        grantable: false,
        implicitDefault: false,
      },
    };
    const implicitOwnerGrant = {
      kind: "grant" as const,
      key: 'grant:GRANT SELECT ON TABLE "public"."users" TO "owner";',
      name: 'GRANT SELECT ON TABLE "public"."users" TO "owner";',
      schema: "public",
      createStatement:
        'GRANT SELECT ON TABLE "public"."users" TO "owner";',
      grantDefinition: {
        objectType: "TABLE" as const,
        objectName: "users",
        schema: "public",
        grantee: "owner",
        granteeIsPublic: false,
        privilege: "SELECT",
        grantable: false,
        implicitDefault: true,
      },
    };

    const filtered = privateService.filterCurrentSqlObjects(
      [
        scopedPolicy,
        desiredRole,
        unrelatedRole,
        serverGrant,
        implicitOwnerGrant,
      ],
      [desiredRole, desiredServer],
      []
    );

    expect(filtered.map(function (item) {
      return item.key;
    })).toEqual([scopedPolicy.key, desiredRole.key, serverGrant.key]);
  });

  test("filterCurrentSqlObjects scopes default privileges by owner and schema", function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);
    const privateService = service as unknown as {
      filterCurrentSqlObjects: (
        current: NonNullable<ParsedSchema["sqlObjects"]>,
        desired: NonNullable<ParsedSchema["sqlObjects"]>,
        schemas?: ParsedSchema["schemas"]
      ) => NonNullable<ParsedSchema["sqlObjects"]>;
    };
    const desiredRole = {
      kind: "role" as const,
      key: "role:object_owner",
      name: "object_owner",
      createStatement: "CREATE ROLE object_owner;",
    };

    function makeDefaultPrivilege(owner: string, schema?: string) {
      return {
        kind: "default-privilege" as const,
        key: `default-privilege:${owner}:${schema || "global"}`,
        name: "default privilege",
        ...(schema ? { schema } : {}),
        createStatement: "ALTER DEFAULT PRIVILEGES ...;",
        defaultPrivilegeDefinition: {
          owner,
          objectType: "TABLES" as const,
          ...(schema ? { schema } : {}),
          grantee: "reader",
          granteeIsPublic: false,
          privilege: "SELECT",
          granted: true,
          grantable: false,
          baselineGranted: false,
        },
      };
    }

    const global = makeDefaultPrivilege("object_owner");
    const managedSchema = makeDefaultPrivilege("object_owner", "app");
    const unmanagedSchema = makeDefaultPrivilege("object_owner", "external");
    const unmanagedOwner = makeDefaultPrivilege("external_owner");
    const filtered = privateService.filterCurrentSqlObjects(
      [global, managedSchema, unmanagedSchema, unmanagedOwner],
      [desiredRole],
      [{ name: "app" }]
    );

    expect(filtered.map(function getKey(item) {
      return item.key;
    })).toEqual([global.key, managedSchema.key]);
  });

  test("filterCurrentExtensions keeps managed desired and required extensions", function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);
    const privateService = service as unknown as {
      filterCurrentExtensions: (
        current: ParsedSchema["extensions"],
        desired: ParsedSchema["extensions"],
        schemas: string[]
      ) => ParsedSchema["extensions"];
    };
    const current = [
      { name: "cube", schema: "external", dependencies: ["base"] },
      { name: "base", schema: "external" },
      { name: "earthdistance", schema: "managed", dependencies: ["cube"] },
      { name: "hstore", schema: "external" },
      { name: "pgcrypto", schema: "external" },
    ];

    expect(privateService.filterCurrentExtensions(
      current,
      [{ name: "hstore", schema: "managed" }],
      ["managed"]
    )).toEqual([
      { name: "cube", schema: "external", dependencies: ["base"] },
      { name: "base", schema: "external" },
      { name: "earthdistance", schema: "managed", dependencies: ["cube"] },
      { name: "hstore", schema: "external" },
    ]);
  });

  test("filterCurrentExtensions protects dependencies of unmanaged extensions", function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);
    const privateService = service as unknown as {
      filterCurrentExtensions: (
        current: ParsedSchema["extensions"],
        desired: ParsedSchema["extensions"],
        schemas: string[]
      ) => ParsedSchema["extensions"];
    };
    const current = [
      { name: "shared", schema: "public" },
      {
        name: "external_consumer",
        schema: "external",
        dependencies: ["shared"],
      },
    ];

    expect(privateService.filterCurrentExtensions(
      current,
      [],
      ["public"]
    )).toEqual([]);
    expect(privateService.filterCurrentExtensions(
      current,
      [{ name: "shared", schema: "public" }],
      ["public"]
    )).toEqual([
      { name: "shared", schema: "public" },
    ]);
  });

  test("orders planned trigger removal before its dependent function", async function () {
    const mock = createMockProvider({
      features: new Set(["stored_functions", "triggers"]),
    });
    mock.provider.getCurrentFunctions = async function () {
      return [
        {
          name: "audit_trigger",
          schema: "public",
          parameters: [],
          returnType: "trigger",
          language: "plpgsql",
          body: "BEGIN RETURN NEW; END",
          dependentObjects: ["trigger audit_trigger on table users"],
        },
      ];
    };
    mock.provider.getCurrentTriggers = async function () {
      return [
        {
          name: "audit_trigger",
          tableName: "users",
          schema: "public",
          timing: "BEFORE" as const,
          events: ["INSERT" as const],
          functionName: "audit_trigger",
          functionSchema: "public",
        },
      ];
    };

    const plan = await createService(mock.provider).plan("");

    expect(plan.transactional).toEqual([
      'DROP TRIGGER IF EXISTS "audit_trigger" ON "public"."users";',
      'DROP FUNCTION IF EXISTS "public"."audit_trigger"();',
    ]);
  });

  test("promptForConfirmation accepts yes and y only", async function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);
    const privateService = service as unknown as { promptForConfirmation: () => Promise<boolean> };

    promptAnswer = "Y";
    expect(await privateService.promptForConfirmation()).toBe(true);
    promptAnswer = "yes";
    expect(await privateService.promptForConfirmation()).toBe(true);
    promptAnswer = "no";
    expect(await privateService.promptForConfirmation()).toBe(false);
  });

  test("canPromptForConfirmation runs tty gate", function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);
    const privateService = service as unknown as { canPromptForConfirmation: () => boolean };

    expect(typeof privateService.canPromptForConfirmation()).toBe("boolean");
  });

  test("executePlan runs transaction and throws on concurrent query error", async function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);
    const privateService = service as unknown as {
      executePlan: (client: DatabaseClient, plan: MigrationPlan, autoApprove: boolean) => Promise<void>;
    };

    const okClient: DatabaseClient = {
      query: async function (sql: string) {
        mock.state.clientQueries.push(sql);
        mock.state.executionOrder.push(`query:${sql}`);
        return { rows: [] };
      },
      end: async function () {
        mock.state.clientEndCalls += 1;
      },
    };

    await privateService.executePlan(
      okClient,
      createPlan({
        preTransactional: ["PRE1"],
        transactional: ["TX1"],
        deferred: ["DEFER1"],
        concurrent: ["C1"],
      }),
      true
    );
    expect(mock.state.executeInTransactionCalls).toEqual([
      ["PRE1"],
      ["TX1"],
      ["DEFER1"],
    ]);
    expect(mock.state.executionOrder).toEqual([
      "transaction:PRE1",
      "transaction:TX1",
      "query:C1",
      "transaction:DEFER1",
    ]);

    const badClient: DatabaseClient = {
      query: async function (sql: string) {
        if (sql === "BAD") {
          throw new Error("boom");
        }
        return { rows: [] };
      },
      end: async function () {
        mock.state.clientEndCalls += 1;
      },
    };

    await expect(privateService.executePlan(badClient, createPlan({ concurrent: ["BAD"], hasChanges: true }), true)).rejects.toThrow("boom");
  });

  test("executePlan skips concurrent statements when transactional execution fails", async function () {
    const mock = createMockProvider();
    const service = createService({
      ...mock.provider,
      executeInTransaction: async function (_client, statements) {
        mock.state.executeInTransactionCalls.push([...statements]);
        throw new Error("tx-failed");
      },
    });
    const privateService = service as unknown as {
      executePlan: (client: DatabaseClient, plan: MigrationPlan, autoApprove: boolean) => Promise<void>;
    };

    const client: DatabaseClient = {
      query: async function (sql: string) {
        mock.state.clientQueries.push(sql);
        return { rows: [] };
      },
      end: async function () {
        mock.state.clientEndCalls += 1;
      },
    };

    await expect(
      privateService.executePlan(
        client,
        createPlan({ transactional: ["TX1"], concurrent: ["C1"], hasChanges: true }),
        true
      )
    ).rejects.toThrow("tx-failed");

    expect(mock.state.executeInTransactionCalls).toEqual([["TX1"]]);
    expect(mock.state.clientQueries).toEqual([]);
  });

  test("apply cancels after prompt and still releases advisory lock", async function () {
    const mock = createMockProvider({
      parsedSchema: createParsedSchema({ tables: [{ name: "users", columns: [] }] }),
      plan: createPlan({ transactional: ["CREATE TABLE users (id INT);"] }),
    });

    const service = createService(mock.provider);
    (service as unknown as { canPromptForConfirmation: () => boolean }).canPromptForConfirmation = function () {
      return true;
    };
    (service as unknown as { promptForConfirmation: () => Promise<boolean> }).promptForConfirmation = async function () {
      return false;
    };

    await service.apply("CREATE TABLE users (id INT);", ["public"], false, { lockName: "schema-lock", lockTimeout: 1000 }, false);

    expect(mock.state.acquireCalls).toEqual(["schema-lock"]);
    expect(mock.state.releaseCalls).toEqual(["schema-lock"]);
    expect(mock.state.executeInTransactionCalls).toHaveLength(0);
    expect(mock.state.clientEndCalls).toBe(1);
  });

  test("apply fails in non-interactive mode without auto approve", async function () {
    const mock = createMockProvider({
      parsedSchema: createParsedSchema({ tables: [{ name: "users", columns: [] }] }),
      plan: createPlan({ transactional: ["CREATE TABLE users (id INT);"], hasChanges: true }),
    });

    const service = createService(mock.provider);
    (service as unknown as { canPromptForConfirmation: () => boolean }).canPromptForConfirmation = function () {
      return false;
    };

    await expect(
      service.apply("CREATE TABLE users (id INT);", ["public"], false)
    ).rejects.toThrow("Confirmation prompt requires interactive terminal");
    expect(mock.state.executeInTransactionCalls).toHaveLength(0);
    expect(mock.state.clientEndCalls).toBe(1);
  });

  test("apply defaults to requiring approval", async function () {
    const mock = createMockProvider({
      parsedSchema: createParsedSchema({ tables: [{ name: "users", columns: [] }] }),
      plan: createPlan({
        transactional: ["CREATE TABLE users (id INT);"],
        hasChanges: true,
      }),
    });

    const service = createService(mock.provider);
    (service as unknown as { canPromptForConfirmation: () => boolean }).canPromptForConfirmation = function () {
      return false;
    };

    await expect(
      service.apply("CREATE TABLE users (id INT);", ["public"])
    ).rejects.toThrow("Confirmation prompt requires interactive terminal");
    expect(mock.state.executeInTransactionCalls).toHaveLength(0);
    expect(mock.state.clientEndCalls).toBe(1);
  });

  test("apply dry run skips advisory lock and does not execute plan", async function () {
    const mock = createMockProvider({
      parsedSchema: createParsedSchema({ tables: [{ name: "users", columns: [] }] }),
      plan: createPlan({ transactional: ["CREATE TABLE users (id INT);"] }),
    });

    const service = createService(mock.provider);
    await service.apply("CREATE TABLE users (id INT);", ["public"], true, { lockName: "schema-lock", lockTimeout: 1000 }, true);

    expect(mock.state.acquireCalls).toHaveLength(0);
    expect(mock.state.releaseCalls).toHaveLength(0);
    expect(mock.state.executeInTransactionCalls).toHaveLength(0);
    expect(mock.state.clientEndCalls).toBe(1);
  });

  test("plan moves a new-table concurrent index into the transaction", async function () {
    const migrationContext = {
      postgresVersionNum: 170000,
      defaultTableAccessMethod: "heap",
    };
    const mock = createMockProvider({
      parsedSchema: createParsedSchema({ tables: [{ name: "users", columns: [] }] }),
      plan: createPlan({
        transactional: ["ALTER TABLE users ADD COLUMN email TEXT;"],
        deferred: ["ALTER TABLE users ADD CONSTRAINT users_fk ...;"],
        concurrent: ["CREATE INDEX CONCURRENTLY users_email_idx ON users (email);"],
        hasChanges: true,
      }),
      migrationContext,
    });

    const service = createService(mock.provider);
    const plan = await service.plan("CREATE TABLE users (id INT);");

    expect(plan.hasChanges).toBe(true);
    expect(plan.transactional).toHaveLength(3);
    expect(plan.deferred).toHaveLength(0);
    expect(plan.concurrent).toHaveLength(0);
    expect(mock.state.migrationContexts).toEqual([migrationContext]);
    expect(mock.state.clientEndCalls).toBe(1);
  });

  test("concurrent index-drop recognition is PostgreSQL-only and fails closed", async function () {
    await loadModule();
    const postgres = createService(createMockProvider().provider) as unknown as {
      isConcurrentIndexDrop(statement: string): boolean;
    };
    const sqlite = createService(createMockProvider({ dialect: "sqlite" }).provider) as unknown as {
      isConcurrentIndexDrop(statement: string): boolean;
    };

    expect(postgres.isConcurrentIndexDrop(
      'DROP INDEX CONCURRENTLY "public"."users_email_idx";'
    )).toBe(true);
    expect(postgres.isConcurrentIndexDrop("DROP TABLE CONCURRENTLY users;")).toBe(false);
    expect(postgres.isConcurrentIndexDrop("not valid SQL")).toBe(false);
    expect(sqlite.isConcurrentIndexDrop(
      'DROP INDEX CONCURRENTLY "public"."users_email_idx";'
    )).toBe(false);
  });

  test("promotes only new-table generated-expression function dependencies", async function () {
    await loadModule();
    const postgres = createService(createMockProvider().provider) as unknown as {
      getGeneratedColumnFunctionStatements(
        statements: string[],
        desiredTables: any[],
        currentTables: any[]
      ): { beforeTables: string[]; remaining: string[] };
    };
    const statements = [
      'CREATE FUNCTION "public"."normalize_value"("value" text ) RETURNS text AS $$ SELECT lower(value); $$ LANGUAGE sql IMMUTABLE;',
      'CREATE FUNCTION "public"."unrelated_value"("value" text ) RETURNS text AS $$ SELECT upper(value); $$ LANGUAGE sql IMMUTABLE;',
      "SELECT 1;",
    ];
    const result = postgres.getGeneratedColumnFunctionStatements(
      statements,
      [{
        name: "records",
        schema: "public",
        columns: [{
          name: "normalized",
          generated: {
            expression: "public.normalize_value(source)",
            always: true,
            stored: true,
          },
        }],
      }],
      []
    );

    expect(result.beforeTables).toEqual([statements[0]]);
    expect(result.remaining).toEqual([statements[1], statements[2]]);
    expect(postgres.getGeneratedColumnFunctionStatements(
      statements,
      [{ name: "records", schema: "public", columns: [] }],
      []
    )).toEqual({ beforeTables: [], remaining: statements });

    const sqlite = createService(createMockProvider({ dialect: "sqlite" }).provider) as unknown as {
      getGeneratedColumnFunctionStatements(
        input: string[],
        desired: any[],
        current: any[]
      ): { beforeTables: string[]; remaining: string[] };
    };
    expect(sqlite.getGeneratedColumnFunctionStatements(
      statements,
      [{ name: "records", columns: [] }],
      []
    )).toEqual({ beforeTables: [], remaining: statements });

    const validate = postgres as unknown as {
      validateVirtualGeneratedFunctionDependencies(
        tables: any[],
        functions: any[],
        enums: any[],
        compositeTypes: any[],
        sqlObjects: any[],
        currentEnums?: any[],
        currentCompositeTypes?: any[],
        currentSqlObjects?: any[],
        currentFunctions?: any[],
        currentTables?: any[]
      ): void;
    };
    expect(function rejectsUnqualifiedVirtualUserFunction() {
      validate.validateVirtualGeneratedFunctionDependencies(
        [{
          name: "records",
          columns: [{
            name: "normalized",
            type: "TEXT",
            generated: {
              expression: "normalize_value(source)",
              always: true,
              stored: false,
            },
          }],
        }],
        [{ name: "normalize_value", parameters: [] }],
        [],
        [],
        []
      );
    }).toThrow("cannot reference user-defined function public.normalize_value");
    expect(function rejectsUnqualifiedVirtualUserType() {
      validate.validateVirtualGeneratedFunctionDependencies(
        [{
          name: "records",
          columns: [{
            name: "payload",
            type: "virtual_payload",
            generated: { expression: "source", always: true, stored: false },
          }],
        }],
        [],
        [],
        [{ name: "virtual_payload" }],
        []
      );
    }).toThrow("cannot use user-defined type public.virtual_payload");
    expect(function rejectsExistingVirtualUserType() {
      validate.validateVirtualGeneratedFunctionDependencies(
        [{
          name: "records",
          columns: [{
            name: "payload",
            type: "virtual_payload",
            generated: { expression: "source", always: true, stored: false },
          }],
        }],
        [],
        [],
        [],
        [],
        [],
        [{ name: "virtual_payload" }]
      );
    }).toThrow("cannot use user-defined type public.virtual_payload");
    expect(function rejectsExistingVirtualUserFunction() {
      validate.validateVirtualGeneratedFunctionDependencies(
        [{
          name: "records",
          columns: [{
            name: "normalized",
            type: "TEXT",
            generated: {
              expression: "normalize_value(source)",
              always: true,
              stored: false,
            },
          }],
        }],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [{ name: "normalize_value", parameters: [] }]
      );
    }).toThrow("cannot reference user-defined function public.normalize_value");
    expect(function rejectsVirtualExpressionUserType() {
      validate.validateVirtualGeneratedFunctionDependencies(
        [{
          name: "records",
          columns: [{
            name: "normalized",
            type: "TEXT",
            generated: {
              expression: "(source::virtual_payload)::text",
              always: true,
              stored: false,
            },
          }],
        }],
        [],
        [],
        [],
        [],
        [],
        [],
        [{ kind: "domain-type", name: "virtual_payload" }]
      );
    }).toThrow(
      "PostgreSQL virtual generated column public.records.normalized cannot reference user-defined type public.virtual_payload"
    );
    expect(function rejectsVirtualExpressionUserTypedColumn() {
      validate.validateVirtualGeneratedFunctionDependencies(
        [{
          name: "records",
          columns: [
            { name: "source", type: "virtual_payload" },
            {
              name: "normalized",
              type: "TEXT",
              generated: {
                expression: "source",
                always: true,
                stored: false,
              },
            },
          ],
        }],
        [],
        [],
        [],
        [{ kind: "domain-type", name: "virtual_payload" }]
      );
    }).toThrow(
      "PostgreSQL virtual generated column public.records.normalized cannot reference user-defined type public.virtual_payload through column source"
    );
    expect(function allowsVirtualExpressionWithBuiltinReferencedColumn() {
      validate.validateVirtualGeneratedFunctionDependencies(
        [{
          name: "records",
          columns: [
            { name: "source", type: "TEXT" },
            { name: "unused_payload", type: "virtual_payload" },
            {
              name: "normalized",
              type: "TEXT",
              generated: {
                expression: "source",
                always: true,
                stored: false,
              },
            },
          ],
        }],
        [],
        [],
        [],
        [{ kind: "domain-type", name: "virtual_payload" }]
      );
    }).not.toThrow();
    expect(function rejectsExistingVirtualRowType() {
      validate.validateVirtualGeneratedFunctionDependencies(
        [{
          name: "records",
          columns: [{
            name: "payload",
            type: "virtual_payload",
            generated: { expression: "source", always: true, stored: false },
          }],
        }],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [{ name: "virtual_payload", columns: [] }]
      );
    }).toThrow("cannot use user-defined type public.virtual_payload");
    expect(function rejectsVirtualDomainType() {
      validate.validateVirtualGeneratedFunctionDependencies(
        [{
          name: "records",
          columns: [{
            name: "payload",
            type: "virtual_payload",
            generated: { expression: "source", always: true, stored: false },
          }],
        }],
        [],
        [],
        [],
        [{ kind: "domain-type", name: "virtual_payload" }]
      );
    }).toThrow("cannot use user-defined type public.virtual_payload");
    expect(function rejectsVirtualRangeType() {
      validate.validateVirtualGeneratedFunctionDependencies(
        [{
          name: "records",
          columns: [{
            name: "payload",
            type: "virtual_payload",
            generated: { expression: "source", always: true, stored: false },
          }],
        }],
        [],
        [],
        [],
        [{ kind: "range-type", name: "virtual_payload" }]
      );
    }).toThrow("cannot use user-defined type public.virtual_payload");

    const sqliteValidate = sqlite as unknown as {
      validateVirtualGeneratedFunctionDependencies(
        tables: any[],
        functions: any[],
        enums: any[],
        compositeTypes: any[],
        sqlObjects: any[]
      ): void;
    };
    expect(function ignoresSqliteVirtualFunctionValidation() {
      sqliteValidate.validateVirtualGeneratedFunctionDependencies(
        [{ name: "records", columns: [] }],
        [{ name: "normalize_value", parameters: [] }],
        [],
        [],
        []
      );
    }).not.toThrow();
  });

  test("plan throws on validation errors and closes client", async function () {
    const mock = createMockProvider({
      validation: createValidation({
        valid: false,
        errors: [{ code: "E001", message: "bad schema", suggestion: "fix" }],
      }),
    });

    const service = createService(mock.provider);

    await expect(service.plan("CREATE TABLE users (id INT);")).rejects.toThrow("Schema validation failed for target database");
    expect(mock.state.clientEndCalls).toBe(1);
  });

  test("apply throws strict mode error on destructive statements", async function () {
    const mock = createMockProvider({
      parsedSchema: createParsedSchema(),
      plan: createPlan({
        transactional: ['DROP TABLE "users";'],
        hasChanges: true,
      }),
    });

    const service = createService(mock.provider);

    await expect(
      service.apply("", ["public"], true, undefined, false, true)
    ).rejects.toBeInstanceOf(StrictModeError);
    expect(mock.state.executeInTransactionCalls).toHaveLength(0);
    expect(mock.state.clientEndCalls).toBe(1);
  });

  test("strict mode permits foreign server owner initialization", async function () {
    const createStatement =
      'CREATE SERVER "New Server" FOREIGN DATA WRAPPER "postgres_fdw";';
    const ownerStatement =
      'ALTER SERVER "New Server" OWNER TO "Server Owner";';
    const mock = createMockProvider({
      parsedSchema: createParsedSchema(),
      plan: createPlan({
        transactional: [createStatement, ownerStatement],
        hasChanges: true,
      }),
    });

    const service = createService(mock.provider);
    await expect(
      service.apply("", ["public"], true, undefined, false, true)
    ).resolves.toMatchObject({ hasChanges: true });
    expect(mock.state.executeInTransactionCalls).toEqual([
      [createStatement, ownerStatement],
    ]);
  });

  test("strict mode blocks ownership transfer for another foreign server", async function () {
    const existingOwnerStatement =
      'ALTER SERVER "Existing Server" OWNER TO "Server Owner";';
    const mock = createMockProvider({
      parsedSchema: createParsedSchema(),
      plan: createPlan({
        transactional: [
          'CREATE SERVER "New Server" FOREIGN DATA WRAPPER "postgres_fdw";',
          'ALTER SERVER "New Server" OWNER TO "Server Owner";',
          existingOwnerStatement,
        ],
        hasChanges: true,
      }),
    });

    const service = createService(mock.provider);
    await expect(
      service.apply("", ["public"], true, undefined, false, true)
    ).rejects.toMatchObject({
      code: "STRICT_MODE_ERROR",
      statements: [existingOwnerStatement],
    });
    expect(mock.state.executeInTransactionCalls).toHaveLength(0);
  });
});
