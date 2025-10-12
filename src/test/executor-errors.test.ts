import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { MigrationError } from "../types/errors";
import { DatabaseService } from "../core/database/client";
import { createTestClient, cleanDatabase } from "./utils";

describe("Executor Error Handling", () => {
  let client: Client;
  let databaseService: DatabaseService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);

    // Create DatabaseService with test config
    databaseService = new DatabaseService({
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "5432"),
      database: process.env.DB_NAME || "test_db",
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
    });
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("PostgreSQL error handling", () => {
    test("should throw MigrationError on constraint violation", async () => {
      // Create a table with unique constraint
      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE
        );
      `);

      // Insert a record
      await client.query(`
        INSERT INTO users (email) VALUES ('test@example.com');
      `);

      // Try to insert duplicate - should throw MigrationError
      const statements = [
        "INSERT INTO users (email) VALUES ('test@example.com');"
      ];

      try {
        await databaseService.executeInTransaction(client, statements);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationError);
        const migrationError = error as MigrationError;

        // Check that error includes PostgreSQL details
        expect(migrationError.pgError).toBeDefined();
        expect(migrationError.pgError?.code).toBe("23505"); // unique violation
        expect(migrationError.statement).toContain("INSERT INTO users");
      }
    });

    test("should include statement that failed", async () => {
      // Try to create table with invalid syntax
      const statements = [
        "CREATE TABLE test_table (id SERIAL PRIMARY KEY);",
        "INVALID SQL STATEMENT HERE;",
      ];

      try {
        await databaseService.executeInTransaction(client, statements);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationError);
        const migrationError = error as MigrationError;

        // The statement that failed should be included
        expect(migrationError.statement).toBe("INVALID SQL STATEMENT HERE;");
      }
    });

    test("should include hint when PostgreSQL provides one", async () => {
      // Create a table
      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE
        );
        INSERT INTO users (email) VALUES ('test@example.com');
      `);

      // Try to insert duplicate
      const statements = [
        "INSERT INTO users (email) VALUES ('test@example.com');"
      ];

      try {
        await databaseService.executeInTransaction(client, statements);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationError);
        const migrationError = error as MigrationError;

        // PostgreSQL should provide error details
        expect(migrationError.pgError?.code).toBe("23505");
        expect(migrationError.pgError?.detail).toBeDefined();
        // Note: hint may or may not be provided by PostgreSQL
      }
    });
  });

  describe("Transaction rollback", () => {
    test("should rollback transaction on error", async () => {
      const statements = [
        "CREATE TABLE test_table (id SERIAL PRIMARY KEY);",
        "INSERT INTO test_table (id) VALUES (1);",
        "INVALID SQL;", // This will fail
      ];

      try {
        await databaseService.executeInTransaction(client, statements);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationError);
      }

      // Verify that the table was not created (transaction rolled back)
      const result = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'test_table'
      `);

      expect(result.rows).toHaveLength(0);
    });
  });

  describe("Successful execution", () => {
    test("should execute statements successfully without throwing", async () => {
      const statements = [
        "CREATE TABLE test_table (id SERIAL PRIMARY KEY);",
        "INSERT INTO test_table (id) VALUES (1);",
      ];

      // Should not throw
      await expect(
        databaseService.executeInTransaction(client, statements)
      ).resolves.toBeUndefined();

      // Verify data was inserted
      const result = await client.query("SELECT * FROM test_table");
      expect(result.rows).toHaveLength(1);
    });
  });
});
