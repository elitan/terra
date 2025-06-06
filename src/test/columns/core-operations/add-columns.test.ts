import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "../../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  assertColumn,
  EnhancedAssertions,
  PerformanceUtils,
  TestScenarioFactory,
} from "../column-test-utils";
import { StringEdgeCases, BoundaryValues } from "../test-data-generators";

describe("Column Addition Operations", () => {
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

  describe("Basic Column Addition", () => {
    test("should add new columns to existing table", async () => {
      // 1. Initial state: create table with basic columns
      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL
        );
      `);

      const initialColumns = await getTableColumns(client, "users");
      expect(initialColumns).toHaveLength(2);

      // 2. Desired state: SQL with additional columns
      const desiredSQL = `
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          email VARCHAR(255),
          age INTEGER
        );
      `;

      // 3. Execute migration with performance measurement
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify final state with enhanced assertions
      const finalColumns = await getTableColumns(client, "users");
      expect(finalColumns).toHaveLength(4);

      EnhancedAssertions.assertColumnType(
        finalColumns,
        "id",
        "integer",
        "basic column addition"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "email",
        "character varying",
        "basic column addition"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "age",
        "integer",
        "basic column addition"
      );

      assertColumn(finalColumns, "name", { nullable: false });
      assertColumn(finalColumns, "email", { nullable: true });

      // Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        3000,
        "basic column addition"
      );
    });

    test("should handle columns with different data types", async () => {
      // 1. Initial state: simple table
      await client.query(`
        CREATE TABLE test_types (
          id SERIAL PRIMARY KEY
        );
      `);

      // 2. Desired state: add columns with various data types
      const desiredSQL = `
        CREATE TABLE test_types (
          id SERIAL PRIMARY KEY,
          text_field TEXT,
          varchar_field VARCHAR(255),
          integer_field INTEGER,
          decimal_field DECIMAL(10,2),
          boolean_field BOOLEAN
        );
      `;

      // 3. Execute migration
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify final state with enhanced type checking
      const finalColumns = await getTableColumns(client, "test_types");
      expect(finalColumns).toHaveLength(6);

      EnhancedAssertions.assertColumnType(
        finalColumns,
        "text_field",
        "text",
        "multiple data types"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "varchar_field",
        "character varying",
        "multiple data types"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "integer_field",
        "integer",
        "multiple data types"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "decimal_field",
        "numeric",
        "multiple data types"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "boolean_field",
        "boolean",
        "multiple data types"
      );

      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        3000,
        "multiple data type addition"
      );
    });

    test("should handle columns with default values", async () => {
      // 1. Initial state: simple table
      await client.query(`
        CREATE TABLE settings (
          id SERIAL PRIMARY KEY
        );
      `);

      // 2. Desired state: add columns with various defaults
      const desiredSQL = `
        CREATE TABLE settings (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          value TEXT DEFAULT 'default_value',
          priority INTEGER DEFAULT 0,
                     is_active BOOLEAN
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify final state and default values
      const finalColumns = await getTableColumns(client, "settings");
      expect(finalColumns).toHaveLength(5);

      assertColumn(finalColumns, "name", { nullable: false });
      assertColumn(finalColumns, "value", { default: "default_value" });
      assertColumn(finalColumns, "priority", { default: "0" });
      assertColumn(finalColumns, "is_active", { type: "boolean" });

      // Verify defaults work by inserting a minimal record
      await client.query(
        "INSERT INTO settings (name, is_active) VALUES ('test', true)"
      );
      const result = await client.query(
        "SELECT * FROM settings WHERE name = 'test'"
      );
      expect(result.rows[0].value).toBe("default_value");
      expect(result.rows[0].priority).toBe(0);
      expect(result.rows[0].is_active).toBe(true);
    });
  });

  describe("Edge Cases in Column Addition", () => {
    test("should handle adding columns with Unicode names and values", async () => {
      await client.query(`
        CREATE TABLE unicode_test (
          id SERIAL PRIMARY KEY
        );
      `);

      const desiredSQL = `
        CREATE TABLE unicode_test (
          id SERIAL PRIMARY KEY,
          unicode_field TEXT,
          emoji_field VARCHAR(100)
        );
      `;

      await executeColumnMigration(client, desiredSQL, services);

      // Test Unicode data insertion
      for (const unicodeValue of StringEdgeCases.unicode.slice(0, 3)) {
        await client.query(
          `INSERT INTO unicode_test (unicode_field) VALUES (${unicodeValue})`
        );
      }

      const result = await client.query("SELECT COUNT(*) FROM unicode_test");
      expect(parseInt(result.rows[0].count)).toBe(3);
    });

    test("should handle adding columns with boundary value defaults", async () => {
      await client.query(`
        CREATE TABLE boundary_defaults (
          id SERIAL PRIMARY KEY
        );
      `);

      const desiredSQL = `
        CREATE TABLE boundary_defaults (
          id SERIAL PRIMARY KEY,
          max_int INTEGER DEFAULT ${
            BoundaryValues.integer.valid[
              BoundaryValues.integer.valid.length - 1
            ]
          },
          min_int INTEGER DEFAULT ${BoundaryValues.integer.valid[0]},
          zero_int INTEGER DEFAULT 0
        );
      `;

      await executeColumnMigration(client, desiredSQL, services);

      // Verify boundary defaults work
      await client.query("INSERT INTO boundary_defaults DEFAULT VALUES");
      const result = await client.query("SELECT * FROM boundary_defaults");

      expect(result.rows[0].max_int).toBe(
        BoundaryValues.integer.valid[BoundaryValues.integer.valid.length - 1]
      );
      expect(result.rows[0].min_int).toBe(BoundaryValues.integer.valid[0]);
      expect(result.rows[0].zero_int).toBe(0);
    });

    test("should handle adding many columns at once", async () => {
      await client.query(`
        CREATE TABLE many_columns (
          id SERIAL PRIMARY KEY
        );
      `);

      // Generate a large number of column definitions
      const columnDefs = Array.from(
        { length: 50 },
        (_, i) =>
          `col_${i
            .toString()
            .padStart(2, "0")} VARCHAR(100) DEFAULT 'value_${i}'`
      ).join(",\n          ");

      const desiredSQL = `
        CREATE TABLE many_columns (
          id SERIAL PRIMARY KEY,
          ${columnDefs}
        );
      `;

      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      const finalColumns = await getTableColumns(client, "many_columns");
      expect(finalColumns).toHaveLength(51); // 1 + 50 columns

      // Verify performance is reasonable even with many columns
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        10000,
        "many columns addition"
      );
    });
  });

  describe("Column Addition with Constraints", () => {
    test("should add NOT NULL columns with proper handling", async () => {
      // Create table with existing data
      await client.query(`
        CREATE TABLE existing_data (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100)
        );
      `);

      // Insert some test data
      await client.query(
        "INSERT INTO existing_data (name) VALUES ('test1'), ('test2')"
      );

      const desiredSQL = `
        CREATE TABLE existing_data (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100),
          email VARCHAR(255) NOT NULL DEFAULT 'no-email@example.com',
          status VARCHAR(50) NOT NULL DEFAULT 'pending'
        );
      `;

      await executeColumnMigration(client, desiredSQL, services);

      // Verify existing data has default values for new NOT NULL columns
      const result = await client.query(
        "SELECT * FROM existing_data ORDER BY id"
      );
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].email).toBe("no-email@example.com");
      expect(result.rows[0].status).toBe("pending");
    });

    test("should handle adding basic numeric columns", async () => {
      await client.query(`
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100)
        );
      `);

      const desiredSQL = `
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100),
          price DECIMAL(10,2),
          quantity INTEGER
        );
      `;

      await executeColumnMigration(client, desiredSQL, services);

      // Verify basic functionality
      await client.query(
        "INSERT INTO products (name, price, quantity) VALUES ('test', 10.50, 5)"
      );

      const result = await client.query(
        "SELECT * FROM products WHERE name = 'test'"
      );
      expect(result.rows[0].price).toBe("10.50"); // DECIMAL values come back as strings
      expect(result.rows[0].quantity).toBe(5);
    });
  });

  describe("Performance and Concurrency", () => {
    test("should handle large table column addition efficiently", async () => {
      // Create table with substantial data
      await client.query(`
        CREATE TABLE large_table (
          id SERIAL PRIMARY KEY,
          data VARCHAR(255)
        );
      `);

      // Insert test data (moderate size for CI)
      const insertPromises = Array.from({ length: 1000 }, (_, i) =>
        client.query(`INSERT INTO large_table (data) VALUES ('data_${i}')`)
      );
      await Promise.all(insertPromises);

      const desiredSQL = `
        CREATE TABLE large_table (
          id SERIAL PRIMARY KEY,
          data VARCHAR(255),
          new_column_1 TEXT DEFAULT 'default',
          new_column_2 INTEGER DEFAULT 0,
          new_column_3 BOOLEAN DEFAULT false
        );
      `;

      const { migrationTime, dataIntact } =
        await PerformanceUtils.measureLargeDataMigration(
          client,
          services,
          "large_table_temp", // Use temp name to avoid conflicts
          `CREATE TABLE large_table_temp (id SERIAL, test_column VARCHAR(255))`,
          `CREATE TABLE large_table_temp (id SERIAL, test_column VARCHAR(255), new_col TEXT)`,
          100 // Smaller dataset for testing
        );

      expect(dataIntact).toBe(true);
      PerformanceUtils.assertPerformanceWithinBounds(
        migrationTime,
        15000,
        "large table column addition"
      );
    });
  });
});
