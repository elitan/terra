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

describe("Mixed Column Operations", () => {
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

  describe("Add, Keep, and Remove Operations", () => {
    test("should handle mixed column operations - add, keep, and remove", async () => {
      // 1. Initial state: create table with some columns
      await client.query(`
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_name VARCHAR(255),
          old_status VARCHAR(50),
          temp_field INTEGER
        );
      `);

      // Insert test data to verify preservation
      await client.query(`
        INSERT INTO orders (customer_name, old_status, temp_field)
        VALUES ('John Doe', 'pending', 123), ('Jane Smith', 'active', 456)
      `);

      const initialColumns = await getTableColumns(client, "orders");
      expect(initialColumns).toHaveLength(4);

      // 2. Desired state: keep some columns, remove others, add new ones
      const desiredSQL = `
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_name VARCHAR(255),
          status VARCHAR(100) NOT NULL DEFAULT 'pending',
          total_amount DECIMAL(10,2)
        );
      `;

      // 3. Execute migration with performance measurement
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify final state with enhanced assertions
      const finalColumns = await getTableColumns(client, "orders");
      expect(finalColumns).toHaveLength(4);

      EnhancedAssertions.assertColumnType(
        finalColumns,
        "id",
        "integer",
        "mixed operations"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "customer_name",
        "character varying",
        "mixed operations"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "status",
        "character varying",
        "mixed operations"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "total_amount",
        "numeric",
        "mixed operations"
      );

      assertColumn(finalColumns, "status", { nullable: false });
      assertColumnNotExists(finalColumns, "old_status");
      assertColumnNotExists(finalColumns, "temp_field");

      // Verify data preservation for kept columns
      const result = await client.query("SELECT * FROM orders ORDER BY id");
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].customer_name).toBe("John Doe");
      expect(result.rows[1].customer_name).toBe("Jane Smith");

      // Verify new column has default values
      expect(result.rows[0].status).toBe("pending");
      expect(result.rows[1].status).toBe("pending");

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        5000,
        "mixed operations"
      );
    });

    test("should handle complex mixed operations with data types", async () => {
      // 1. Initial state: table with various data types
      await client.query(`
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100),
          old_price VARCHAR(20),
          description TEXT,
          temp_category VARCHAR(50),
          is_featured BOOLEAN
        );
      `);

      // Insert test data
      await client.query(`
        INSERT INTO products (name, old_price, description, temp_category, is_featured)
        VALUES 
        ('Product 1', '19.99', 'Great product', 'electronics', true),
        ('Product 2', '29.99', 'Another product', 'books', false)
      `);

      // 2. Desired state: mix of operations
      const desiredSQL = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100),
          price DECIMAL(10,2),
          description TEXT,
          category VARCHAR(100) DEFAULT 'uncategorized',
          stock_count INTEGER DEFAULT 0,
          created_at TIMESTAMP
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state
      const finalColumns = await getTableColumns(client, "products");
      expect(finalColumns).toHaveLength(7);

      // Verify kept columns
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "name",
        "character varying",
        "complex mixed"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "description",
        "text",
        "complex mixed"
      );

      // Verify new columns
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "price",
        "numeric",
        "complex mixed"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "category",
        "character varying",
        "complex mixed"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "stock_count",
        "integer",
        "complex mixed"
      );

      // Verify removed columns
      assertColumnNotExists(finalColumns, "old_price");
      assertColumnNotExists(finalColumns, "temp_category");
      assertColumnNotExists(finalColumns, "is_featured");

      // Verify data preservation
      const result = await client.query("SELECT * FROM products ORDER BY id");
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].name).toBe("Product 1");
      expect(result.rows[0].description).toBe("Great product");
      expect(result.rows[0].category).toBe("uncategorized"); // Default value
      expect(result.rows[0].stock_count).toBe(0); // Default value
    });
  });

  describe("Large Dataset Mixed Operations", () => {
    test("should handle mixed operations on large datasets efficiently", async () => {
      // 1. Create table with substantial data
      await client.query(`
        CREATE TABLE large_mixed (
          id SERIAL PRIMARY KEY,
          keep_data VARCHAR(255),
          remove_temp TEXT,
          modify_me VARCHAR(50)
        );
      `);

      // Insert substantial test data
      const insertPromises = Array.from({ length: 500 }, (_, i) =>
        client.query(`
          INSERT INTO large_mixed (keep_data, remove_temp, modify_me)
          VALUES ('important_${i}', 'temp_${i}', 'old_${i}')
        `)
      );
      await Promise.all(insertPromises);

      // Capture before state
      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "large_mixed",
        "id"
      );

      // 2. Desired state: remove, keep, and add columns
      const desiredSQL = `
        CREATE TABLE large_mixed (
          id SERIAL PRIMARY KEY,
          keep_data VARCHAR(255),
          new_column INTEGER DEFAULT 42,
          another_new TEXT DEFAULT 'new value'
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
        "large_mixed",
        "id"
      );

      // Verify row count preservation
      expect(afterSnapshot.length).toBe(beforeSnapshot.length);
      expect(afterSnapshot.length).toBe(500);

      // Verify specific data preservation and new defaults
      for (let i = 0; i < Math.min(10, afterSnapshot.length); i++) {
        expect(afterSnapshot[i].keep_data).toBe(beforeSnapshot[i].keep_data);
        expect(afterSnapshot[i].new_column).toBe(42); // New default
        expect(afterSnapshot[i].another_new).toBe("new value"); // New default
        expect(afterSnapshot[i].remove_temp).toBeUndefined(); // Removed
        expect(afterSnapshot[i].modify_me).toBeUndefined(); // Removed
      }

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        15000,
        "large dataset mixed operations"
      );
    });
  });

  describe("Complex Schema Transformations", () => {
    test("should handle table restructuring with data preservation", async () => {
      // 1. Initial state: legacy table structure
      await client.query(`
        CREATE TABLE legacy_users (
          id SERIAL PRIMARY KEY,
          full_name VARCHAR(255),
          email_address VARCHAR(255),
          user_status VARCHAR(20),
          registration_date VARCHAR(50),
          old_field1 TEXT,
          old_field2 INTEGER,
          temp_notes TEXT
        );
      `);

      // Insert legacy data
      await client.query(`
        INSERT INTO legacy_users (full_name, email_address, user_status, registration_date, old_field1, old_field2, temp_notes)
        VALUES 
        ('John Doe', 'john@example.com', 'active', '2023-01-15', 'old1', 1, 'temp1'),
        ('Jane Smith', 'jane@example.com', 'inactive', '2023-02-20', 'old2', 2, 'temp2'),
        ('Bob Johnson', 'bob@example.com', 'pending', '2023-03-10', 'old3', 3, 'temp3')
      `);

      // 2. Desired state: modern table structure
      const desiredSQL = `
        CREATE TABLE legacy_users (
          id SERIAL PRIMARY KEY,
          first_name VARCHAR(100),
          last_name VARCHAR(100),
                     email VARCHAR(255) NOT NULL DEFAULT 'unknown@example.com',
          status VARCHAR(50) DEFAULT 'pending',
          created_at TIMESTAMP,
                     is_verified BOOLEAN,
          profile_data TEXT
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify transformation
      const finalColumns = await getTableColumns(client, "legacy_users");
      expect(finalColumns).toHaveLength(8);

      // Verify new structure
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "first_name",
        "character varying",
        "table restructuring"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "last_name",
        "character varying",
        "table restructuring"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "email",
        "character varying",
        "table restructuring"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "is_verified",
        "boolean",
        "table restructuring"
      );

      assertColumn(finalColumns, "email", { nullable: false });

      // Verify old columns are gone
      assertColumnNotExists(finalColumns, "full_name");
      assertColumnNotExists(finalColumns, "email_address");
      assertColumnNotExists(finalColumns, "user_status");
      assertColumnNotExists(finalColumns, "registration_date");
      assertColumnNotExists(finalColumns, "old_field1");
      assertColumnNotExists(finalColumns, "old_field2");
      assertColumnNotExists(finalColumns, "temp_notes");

      // Verify row count preservation
      const result = await client.query("SELECT COUNT(*) FROM legacy_users");
      expect(parseInt(result.rows[0].count)).toBe(3);

      // Verify new defaults are applied
      const firstRow = await client.query(
        "SELECT * FROM legacy_users WHERE id = 1"
      );
      expect(firstRow.rows[0].status).toBe("pending");
      expect(firstRow.rows[0].is_verified).toBeNull();
    });

    test("should handle multiple simultaneous column operations", async () => {
      // 1. Initial state: table needing comprehensive changes
      await client.query(`
        CREATE TABLE comprehensive_test (
          id SERIAL PRIMARY KEY,
          keep_unchanged VARCHAR(100),
          remove_old_1 TEXT,
          remove_old_2 INTEGER,
          remove_old_3 BOOLEAN
        );
      `);

      // Insert data to test preservation
      await client.query(`
        INSERT INTO comprehensive_test (keep_unchanged, remove_old_1, remove_old_2, remove_old_3)
        VALUES ('preserve_me', 'delete1', 1, true), ('also_preserve', 'delete2', 2, false)
      `);

      // 2. Desired state: major restructuring
      const desiredSQL = `
        CREATE TABLE comprehensive_test (
          id SERIAL PRIMARY KEY,
          keep_unchanged VARCHAR(100),
          new_text_field TEXT DEFAULT 'default text',
          new_number_field INTEGER DEFAULT 100,
          new_decimal_field DECIMAL(8,2) DEFAULT 0.00,
                     new_boolean_field BOOLEAN,
          new_varchar_field VARCHAR(200)
        );
      `;

      // 3. Execute migration
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify comprehensive changes
      const finalColumns = await getTableColumns(client, "comprehensive_test");
      expect(finalColumns).toHaveLength(7);

      // Verify all new columns exist with correct types
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "new_text_field",
        "text",
        "comprehensive changes"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "new_number_field",
        "integer",
        "comprehensive changes"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "new_decimal_field",
        "numeric",
        "comprehensive changes"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "new_boolean_field",
        "boolean",
        "comprehensive changes"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "new_varchar_field",
        "character varying",
        "comprehensive changes"
      );

      // Verify old columns are removed
      assertColumnNotExists(finalColumns, "remove_old_1");
      assertColumnNotExists(finalColumns, "remove_old_2");
      assertColumnNotExists(finalColumns, "remove_old_3");

      // Verify data preservation and new defaults
      const result = await client.query(
        "SELECT * FROM comprehensive_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(2);

      expect(result.rows[0].keep_unchanged).toBe("preserve_me");
      expect(result.rows[0].new_text_field).toBe("default text");
      expect(result.rows[0].new_number_field).toBe(100);
      expect(result.rows[0].new_decimal_field).toBe("0.00");
      expect(result.rows[0].new_boolean_field).toBeNull();

      expect(result.rows[1].keep_unchanged).toBe("also_preserve");

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        8000,
        "comprehensive changes"
      );
    });
  });
});
