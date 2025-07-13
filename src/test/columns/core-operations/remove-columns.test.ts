import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "../../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  assertColumn,
  assertColumnNotExists,
  EnhancedAssertions,
  PerformanceUtils,
  DataIntegrityUtils,
} from "../column-test-utils";

describe("Column Removal Operations", () => {
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

  describe("Basic Column Removal", () => {
    test("should remove columns from existing table", async () => {
      // 1. Initial state: create table with multiple columns
      await client.query(`
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          old_field VARCHAR(100),
          deprecated_column INTEGER
        );
      `);

      const initialColumns = await getTableColumns(client, "products");
      expect(initialColumns).toHaveLength(5);

      // 2. Desired state: SQL with fewer columns
      const desiredSQL = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT
        );
      `;

      // 3. Execute migration with performance measurement
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify final state with enhanced assertions
      const finalColumns = await getTableColumns(client, "products");
      expect(finalColumns).toHaveLength(3);

      EnhancedAssertions.assertColumnType(
        finalColumns,
        "id",
        "integer",
        "column removal"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "description",
        "text",
        "column removal"
      );

      assertColumn(finalColumns, "name", { nullable: false });
      assertColumnNotExists(finalColumns, "old_field");
      assertColumnNotExists(finalColumns, "deprecated_column");

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        3000,
        "basic column removal"
      );
    });

    test("should remove single column", async () => {
      // 1. Initial state: table with temporary column
      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          temp_email VARCHAR(255)
        );
      `);

      // Insert test data to verify data preservation
      await client.query(`
        INSERT INTO users (name, temp_email) 
        VALUES ('John Doe', 'john@temp.com'), ('Jane Smith', 'jane@temp.com')
      `);

      // 2. Desired state: remove temp_email column
      const desiredSQL = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state and data preservation
      const finalColumns = await getTableColumns(client, "users");
      expect(finalColumns).toHaveLength(2);

      assertColumnNotExists(finalColumns, "temp_email");

      // Verify existing data is preserved
      const result = await client.query("SELECT * FROM users ORDER BY id");
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].name).toBe("John Doe");
      expect(result.rows[1].name).toBe("Jane Smith");
    });

    test("should remove multiple columns of different types", async () => {
      // 1. Initial state: table with various column types
      await client.query(`
                 CREATE TABLE test_table (
           id SERIAL PRIMARY KEY,
           keep_text TEXT,
           remove_varchar VARCHAR(100),
           keep_integer INTEGER,
           remove_decimal DECIMAL(10,2),
           remove_boolean BOOLEAN,
           keep_timestamp TIMESTAMP
         );
      `);

      // Insert test data
      await client.query(`
        INSERT INTO test_table (keep_text, remove_varchar, keep_integer, remove_decimal, remove_boolean) 
        VALUES ('Test text', 'Remove me', 42, 123.45, true)
      `);

      // 2. Desired state: remove specific columns
      const desiredSQL = `
                 CREATE TABLE test_table (
           id SERIAL PRIMARY KEY,
           keep_text TEXT,
           keep_integer INTEGER,
           keep_timestamp TIMESTAMP
         );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state
      const finalColumns = await getTableColumns(client, "test_table");
      expect(finalColumns).toHaveLength(4);

      // Verify kept columns
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "keep_text",
        "text",
        "multiple column removal"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "keep_integer",
        "integer",
        "multiple column removal"
      );

      // Verify removed columns
      assertColumnNotExists(finalColumns, "remove_varchar");
      assertColumnNotExists(finalColumns, "remove_decimal");
      assertColumnNotExists(finalColumns, "remove_boolean");

      // Verify data preservation for remaining columns
      const result = await client.query(
        "SELECT keep_text, keep_integer FROM test_table"
      );
      expect(result.rows[0].keep_text).toBe("Test text");
      expect(result.rows[0].keep_integer).toBe(42);
    });
  });

  describe("Column Removal with Data Preservation", () => {
    test("should preserve data when removing columns with large datasets", async () => {
      // 1. Create table with multiple columns
      await client.query(`
        CREATE TABLE large_test (
          id SERIAL PRIMARY KEY,
          important_data VARCHAR(255),
          remove_this TEXT,
          keep_number INTEGER
        );
      `);

      // Insert substantial test data
      const insertPromises = Array.from({ length: 1000 }, (_, i) =>
        client.query(`
          INSERT INTO large_test (important_data, remove_this, keep_number) 
          VALUES ('data_${i}', 'temp_${i}', ${i})
        `)
      );
      await Promise.all(insertPromises);

      // Capture before state
      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "large_test",
        "id"
      );

      // 2. Remove the 'remove_this' column
      const desiredSQL = `
        CREATE TABLE large_test (
          id SERIAL PRIMARY KEY,
          important_data VARCHAR(255),
          keep_number INTEGER
        );
      `;

      // 3. Execute migration with performance measurement
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify data integrity
      const afterSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "large_test",
        "id"
      );

      // Verify row count preservation
      expect(afterSnapshot.length).toBe(beforeSnapshot.length);
      expect(afterSnapshot.length).toBe(1000);

      // Verify specific data preservation
      for (let i = 0; i < Math.min(10, afterSnapshot.length); i++) {
        expect(afterSnapshot[i].important_data).toBe(
          beforeSnapshot[i].important_data
        );
        expect(afterSnapshot[i].keep_number).toBe(
          beforeSnapshot[i].keep_number
        );
        expect(afterSnapshot[i].remove_this).toBeUndefined(); // Column should be gone
      }

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        10000,
        "large dataset column removal"
      );
    });

    test("should handle removing columns with NULL values", async () => {
      // 1. Create table with nullable columns
      await client.query(`
        CREATE TABLE nullable_test (
          id SERIAL PRIMARY KEY,
          keep_name VARCHAR(100),
          remove_nullable VARCHAR(100),
          keep_value INTEGER
        );
      `);

      // Insert data with NULL values
      await client.query(`
        INSERT INTO nullable_test (keep_name, remove_nullable, keep_value) VALUES
        ('Test1', NULL, 1),
        ('Test2', 'Value2', 2),
        ('Test3', NULL, 3),
        ('Test4', 'Value4', NULL)
      `);

      // 2. Remove column with NULL values
      const desiredSQL = `
        CREATE TABLE nullable_test (
          id SERIAL PRIMARY KEY,
          keep_name VARCHAR(100),
          keep_value INTEGER
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify data preservation including NULLs
      const result = await client.query(
        "SELECT * FROM nullable_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(4);

      expect(result.rows[0].keep_name).toBe("Test1");
      expect(result.rows[0].keep_value).toBe(1);
      expect(result.rows[3].keep_value).toBeNull();

      // Verify removed column is gone
      expect(result.rows[0].remove_nullable).toBeUndefined();
    });
  });

  describe("Edge Cases in Column Removal", () => {
    test("should handle removing columns with default values", async () => {
      // 1. Create table with columns having defaults
      await client.query(`
                 CREATE TABLE defaults_test (
           id SERIAL PRIMARY KEY,
           keep_status VARCHAR(50) DEFAULT 'active',
           remove_priority INTEGER DEFAULT 0,
           keep_created TIMESTAMP
         );
      `);

      // Insert rows using defaults
      await client.query(
        "INSERT INTO defaults_test (keep_status) VALUES ('custom')"
      );
      await client.query("INSERT INTO defaults_test DEFAULT VALUES");

      // 2. Remove column with default
      const desiredSQL = `
                 CREATE TABLE defaults_test (
           id SERIAL PRIMARY KEY,
           keep_status VARCHAR(50) DEFAULT 'active',
           keep_created TIMESTAMP
         );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify remaining defaults still work
      await client.query("INSERT INTO defaults_test DEFAULT VALUES");

      const result = await client.query(
        "SELECT * FROM defaults_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(3);
      expect(result.rows[2].keep_status).toBe("active"); // Default still works

      // Verify removed column is gone
      assertColumnNotExists(
        await getTableColumns(client, "defaults_test"),
        "remove_priority"
      );
    });

    test("should handle removing the last non-key column", async () => {
      // 1. Create table with only primary key and one other column
      await client.query(`
        CREATE TABLE minimal_table (
          id SERIAL PRIMARY KEY,
          only_column VARCHAR(100)
        );
      `);

      await client.query(
        "INSERT INTO minimal_table (only_column) VALUES ('test')"
      );

      // 2. Remove the only non-key column
      const desiredSQL = `
        CREATE TABLE minimal_table (
          id SERIAL PRIMARY KEY
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify table structure and data
      const finalColumns = await getTableColumns(client, "minimal_table");
      expect(finalColumns).toHaveLength(1);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "id",
        "integer",
        "minimal table"
      );

      const result = await client.query("SELECT * FROM minimal_table");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe(1);
    });

    test("should handle removing multiple columns simultaneously", async () => {
      // 1. Create table with many columns
      await client.query(`
        CREATE TABLE many_columns (
          id SERIAL PRIMARY KEY,
          keep1 VARCHAR(50),
          remove1 TEXT,
          keep2 INTEGER,
          remove2 DECIMAL(10,2),
          remove3 BOOLEAN,
          keep3 TIMESTAMP,
          remove4 VARCHAR(100),
          remove5 INTEGER
        );
      `);

      // Insert test data
      await client.query(`
        INSERT INTO many_columns (keep1, remove1, keep2, remove2, remove3, keep3, remove4, remove5)
        VALUES ('keep1', 'remove1', 42, 123.45, true, CURRENT_TIMESTAMP, 'remove4', 999)
      `);

      // 2. Remove multiple columns at once
      const desiredSQL = `
        CREATE TABLE many_columns (
          id SERIAL PRIMARY KEY,
          keep1 VARCHAR(50),
          keep2 INTEGER,
          keep3 TIMESTAMP
        );
      `;

      // 3. Execute migration
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify final state
      const finalColumns = await getTableColumns(client, "many_columns");
      expect(finalColumns).toHaveLength(4); // id + 3 kept columns

      // Verify kept columns exist
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "keep1",
        "character varying",
        "multiple removal"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "keep2",
        "integer",
        "multiple removal"
      );

      // Verify removed columns are gone
      assertColumnNotExists(finalColumns, "remove1");
      assertColumnNotExists(finalColumns, "remove2");
      assertColumnNotExists(finalColumns, "remove3");
      assertColumnNotExists(finalColumns, "remove4");
      assertColumnNotExists(finalColumns, "remove5");

      // Verify data preservation
      const result = await client.query("SELECT * FROM many_columns");
      expect(result.rows[0].keep1).toBe("keep1");
      expect(result.rows[0].keep2).toBe(42);

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        5000,
        "multiple column removal"
      );
    });
  });

  describe("Error Scenarios", () => {
    test("should handle attempting to remove non-existent column gracefully", async () => {
      // 1. Create simple table
      await client.query(`
        CREATE TABLE simple_table (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100)
        );
      `);

      // 2. Try to "remove" a column that doesn't exist by not including it
      // This should be a no-op since the column wasn't there anyway
      const desiredSQL = `
        CREATE TABLE simple_table (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100)
        );
      `;

      // 3. Execute migration (should succeed as no-op)
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify no changes
      const finalColumns = await getTableColumns(client, "simple_table");
      expect(finalColumns).toHaveLength(2);
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "name",
        "character varying",
        "no-op removal"
      );
    });
  });
});
