import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../core/schema/service";
import { DatabaseService } from "../core/database/client";
import { createTestClient, cleanDatabase, createTestSchemaService, createTestDatabaseService } from "./utils";

describe("Advisory Lock", () => {
  let client: Client;
  let schemaService: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    
    schemaService = createTestSchemaService();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  test("should successfully acquire and release advisory lock", async () => {
    const schema = `
      CREATE TABLE test_table (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100)
      );
    `;

    // Apply with lock options
    await schemaService.apply(schema, ['public'], true, {
      lockName: "test_lock",
      lockTimeout: 5000
    });

    // Verify table was created
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'test_table'
    `);

    expect(tables.rows).toHaveLength(1);
  });

  test("should block concurrent migrations with same lock", async () => {
    const schema = `
      CREATE TABLE concurrent_test (
        id SERIAL PRIMARY KEY
      );
    `;

    // Create two separate database services for concurrent operations
    const databaseService1 = createTestDatabaseService();
    const databaseService2 = createTestDatabaseService();

    const client1 = await databaseService1.createClient();
    const client2 = await databaseService2.createClient();

    try {
      // Acquire lock on client1
      await databaseService1.acquireAdvisoryLock(client1, {
        lockName: "concurrent_lock",
        lockTimeout: 10000
      });

      // Try to acquire same lock on client2 with short timeout - should fail
      await expect(async () => {
        await databaseService2.acquireAdvisoryLock(client2, {
          lockName: "concurrent_lock",
          lockTimeout: 1000 // 1 second timeout
        });
      }).toThrow();

      // Release lock on client1
      await databaseService1.releaseAdvisoryLock(client1, "concurrent_lock");

      // Now client2 should be able to acquire the lock
      await databaseService2.acquireAdvisoryLock(client2, {
        lockName: "concurrent_lock",
        lockTimeout: 5000
      });

      // Clean up
      await databaseService2.releaseAdvisoryLock(client2, "concurrent_lock");
    } finally {
      await client1.end();
      await client2.end();
    }
  });

  test("should allow concurrent migrations with different locks", async () => {
    const databaseService1 = createTestDatabaseService();
    const databaseService2 = createTestDatabaseService();

    const client1 = await databaseService1.createClient();
    const client2 = await databaseService2.createClient();

    try {
      // Acquire different locks simultaneously
      await databaseService1.acquireAdvisoryLock(client1, {
        lockName: "lock_1",
        lockTimeout: 5000
      });

      await databaseService2.acquireAdvisoryLock(client2, {
        lockName: "lock_2",
        lockTimeout: 5000
      });

      // Both should succeed
      expect(true).toBe(true);

      // Clean up
      await databaseService1.releaseAdvisoryLock(client1, "lock_1");
      await databaseService2.releaseAdvisoryLock(client2, "lock_2");
    } finally {
      await client1.end();
      await client2.end();
    }
  });

  test("should timeout when lock cannot be acquired", async () => {
    const databaseService1 = createTestDatabaseService();
    const databaseService2 = createTestDatabaseService();

    const client1 = await databaseService1.createClient();
    const client2 = await databaseService2.createClient();

    try {
      // Acquire lock on client1
      await databaseService1.acquireAdvisoryLock(client1, {
        lockName: "timeout_test_lock",
        lockTimeout: 10000
      });

      const startTime = Date.now();

      // Try to acquire same lock on client2 with short timeout
      try {
        await databaseService2.acquireAdvisoryLock(client2, {
          lockName: "timeout_test_lock",
          lockTimeout: 500 // 500ms timeout
        });
        throw new Error("Should have thrown timeout error");
      } catch (error: any) {
        const elapsed = Date.now() - startTime;
        // Verify timeout occurred around expected time (with some tolerance)
        expect(elapsed).toBeGreaterThanOrEqual(400);
        expect(elapsed).toBeLessThan(1500);
        expect(error.message).toContain("Failed to acquire advisory lock");
        expect(error.message).toContain("timeout_test_lock");
      }

      // Clean up
      await databaseService1.releaseAdvisoryLock(client1, "timeout_test_lock");
    } finally {
      await client1.end();
      await client2.end();
    }
  });

  test("should release lock even if migration fails", async () => {
    const validSchema = `
      CREATE TABLE lock_test (
        id SERIAL PRIMARY KEY
      );
    `;

    const invalidSchema = `
      CREATE TABLE lock_test (
        id SERIAL PRIMARY KEY,
        invalid_column INVALID_TYPE
      );
    `;

    // First, create the table
    await schemaService.apply(validSchema, ['public'], true);

    // Try to apply invalid schema with lock
    try {
      await schemaService.apply(invalidSchema, ['public'], true, {
        lockName: "failure_test_lock",
        lockTimeout: 5000
      });
      throw new Error("Should have thrown error for invalid schema");
    } catch (error: any) {
      // Expected to fail
      expect(error.message).toBeTruthy();
    }

    // Now verify we can acquire the lock again (it was released)
    const databaseService = createTestDatabaseService();
    const testClient = await databaseService.createClient();

    try {
      // This should succeed if lock was properly released
      await databaseService.acquireAdvisoryLock(testClient, {
        lockName: "failure_test_lock",
        lockTimeout: 1000
      });

      // Clean up
      await databaseService.releaseAdvisoryLock(testClient, "failure_test_lock");
    } finally {
      await testClient.end();
    }
  });

  test("should work without lock options (backwards compatibility)", async () => {
    const schema = `
      CREATE TABLE no_lock_table (
        id SERIAL PRIMARY KEY,
        data TEXT
      );
    `;

    // Apply without lock options
    await schemaService.apply(schema, ['public'], true);

    // Verify table was created
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'no_lock_table'
    `);

    expect(tables.rows).toHaveLength(1);
  });

  test("should use default lock name from CLI option", async () => {
    const schema = `
      CREATE TABLE default_lock_test (
        id SERIAL PRIMARY KEY
      );
    `;

    // Apply with default lock name
    await schemaService.apply(schema, ['public'], true, {
      lockName: "terra_migrate_execute", // default from CLI
      lockTimeout: 10000
    });

    // Verify table was created
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'default_lock_test'
    `);

    expect(tables.rows).toHaveLength(1);
  });
});
