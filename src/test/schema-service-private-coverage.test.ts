import { describe, expect, mock, test } from "bun:test";
import { readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { SchemaService } from "../core/schema/service";
import type { DatabaseClient, DatabaseProvider, ParsedSchema, ValidationResult } from "../providers/types";
import type { MigrationPlan } from "../types/migration";

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
  parseCalls: Array<[string, string | undefined]>;
  executeInTransactionCalls: string[][];
  acquireCalls: string[];
  releaseCalls: string[];
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
  parsedSchema?: ParsedSchema;
  plan?: MigrationPlan;
  validation?: ValidationResult;
  features?: Set<string>;
} = {}): { provider: DatabaseProvider; state: MockState } {
  const state: MockState = {
    clientEndCalls: 0,
    clientQueries: [],
    parseCalls: [],
    executeInTransactionCalls: [],
    acquireCalls: [],
    releaseCalls: [],
  };

  const parsedSchema = options.parsedSchema ?? createParsedSchema();
  const plan = options.plan ?? createPlan();
  const validation = options.validation ?? createValidation();
  const features = options.features ?? new Set<string>();

  const client: DatabaseClient = {
    query: async function (sql: string) {
      state.clientQueries.push(sql);
      return { rows: [] };
    },
    end: async function () {
      state.clientEndCalls += 1;
    },
  };

  const provider: DatabaseProvider = {
    dialect: "postgres",
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
    generateMigrationPlan: function () {
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
    expect(filtered.comments).toHaveLength(1);

    expect(privateService.countObjects(parsed)).toBe(14);
    expect(privateService.countObjects(filtered)).toBe(7);
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

  test("executePlan runs transaction and throws on concurrent query error", async function () {
    const mock = createMockProvider();
    const service = createService(mock.provider);
    const privateService = service as unknown as {
      executePlan: (client: DatabaseClient, plan: MigrationPlan, autoApprove: boolean) => Promise<void>;
    };

    const okClient: DatabaseClient = {
      query: async function (sql: string) {
        mock.state.clientQueries.push(sql);
        return { rows: [] };
      },
      end: async function () {
        mock.state.clientEndCalls += 1;
      },
    };

    await privateService.executePlan(okClient, createPlan({ transactional: ["TX1"], concurrent: ["C1"] }), true);
    expect(mock.state.executeInTransactionCalls).toEqual([["TX1"]]);
    expect(mock.state.clientQueries).toContain("C1");

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

  test("apply cancels after prompt and still releases advisory lock", async function () {
    const mock = createMockProvider({
      parsedSchema: createParsedSchema({ tables: [{ name: "users", columns: [] }] }),
      plan: createPlan({ transactional: ["CREATE TABLE users (id INT);"] }),
    });

    const service = createService(mock.provider);
    (service as unknown as { promptForConfirmation: () => Promise<boolean> }).promptForConfirmation = async function () {
      return false;
    };

    await service.apply("CREATE TABLE users (id INT);", ["public"], false, { lockName: "schema-lock", lockTimeout: 1000 }, false);

    expect(mock.state.acquireCalls).toEqual(["schema-lock"]);
    expect(mock.state.releaseCalls).toEqual(["schema-lock"]);
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

  test("plan logs transactional deferred and concurrent changes", async function () {
    const mock = createMockProvider({
      parsedSchema: createParsedSchema({ tables: [{ name: "users", columns: [] }] }),
      plan: createPlan({
        transactional: ["ALTER TABLE users ADD COLUMN email TEXT;"],
        deferred: ["ALTER TABLE users ADD CONSTRAINT users_fk ...;"],
        concurrent: ["CREATE INDEX CONCURRENTLY users_email_idx ON users (email);"],
        hasChanges: true,
      }),
    });

    const service = createService(mock.provider);
    const plan = await service.plan("CREATE TABLE users (id INT);");

    expect(plan.hasChanges).toBe(true);
    expect(plan.transactional).toHaveLength(1);
    expect(plan.deferred).toHaveLength(1);
    expect(plan.concurrent).toHaveLength(1);
    expect(mock.state.clientEndCalls).toBe(1);
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
});
