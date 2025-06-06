import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase } from "../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  insertTestData,
  verifyDataIntegrity,
} from "./column-test-utils";

describe("Data Safety & Error Handling - End to End", () => {
  let client: Client;
  let services: ReturnType<typeof createColumnTestServices>;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    services = createColumnTestServices();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("Data Preservation During Type Changes", () => {
    test("should preserve data when converting compatible types", async () => {
      // 1. Initial state: create table with data
      await client.query(`
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          description VARCHAR(500)
        );
      `);

      // Insert test data
      const testValues = ["'Product A'", "'Product B'", "'Product C'"];
      await insertTestData(client, "products", "description", testValues);
      await verifyDataIntegrity(client, "products", 3);

      // 2. Desired state: convert VARCHAR to TEXT (compatible)
      const desiredSQL = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          description TEXT
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify data is preserved
      await verifyDataIntegrity(client, "products", 3);

      const result = await client.query(
        "SELECT description FROM products ORDER BY id"
      );
      expect(result.rows[0].description).toBe("Product A");
      expect(result.rows[1].description).toBe("Product B");
      expect(result.rows[2].description).toBe("Product C");
    });
  });

  describe("Error Handling for Invalid Conversions", () => {
    test("should handle non-numeric strings when converting to INTEGER", async () => {
      // 1. Initial state: table with mixed data
      await client.query(`
        CREATE TABLE mixed_data (
          id SERIAL PRIMARY KEY,
          value VARCHAR(50)
        );
      `);

      // Insert problematic data
      await client.query("INSERT INTO mixed_data (value) VALUES ('123')");
      await client.query(
        "INSERT INTO mixed_data (value) VALUES ('not_a_number')"
      );
      await client.query("INSERT INTO mixed_data (value) VALUES ('456')");

      // 2. Desired state: convert to INTEGER (should fail)
      const desiredSQL = `
        CREATE TABLE mixed_data (
          id SERIAL PRIMARY KEY,
          value INTEGER
        );
      `;

      // 3. Execute migration - expect it to fail gracefully
      let migrationFailed = false;
      try {
        await executeColumnMigration(client, desiredSQL, services);
      } catch (error) {
        migrationFailed = true;
        // Verify it's the expected error
        expect((error as Error).message).toContain(
          "invalid input syntax for type integer"
        );
      }

      // 4. Verify migration failed (data safety)
      expect(migrationFailed).toBe(true);

      // Verify original data is still intact
      await verifyDataIntegrity(client, "mixed_data", 3);
    });
  });

  describe("Constraint Validation", () => {
    test("should validate data when adding NOT NULL constraint", async () => {
      // 1. Initial state: table with NULL values
      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255)
        );
      `);

      // Insert data with NULLs
      await client.query(
        "INSERT INTO users (email) VALUES ('user@example.com')"
      );
      await client.query("INSERT INTO users (email) VALUES (NULL)");
      await client.query(
        "INSERT INTO users (email) VALUES ('another@example.com')"
      );

      // 2. Desired state: make email NOT NULL (should fail)
      const desiredSQL = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL
        );
      `;

      // 3. Execute migration - expect it to fail
      let migrationFailed = false;
      try {
        await executeColumnMigration(client, desiredSQL, services);
      } catch (error) {
        migrationFailed = true;
        expect((error as Error).message).toContain("contains null values");
      }

      // 4. Verify original data is preserved
      expect(migrationFailed).toBe(true);
      await verifyDataIntegrity(client, "users", 3);
    });
  });
});
