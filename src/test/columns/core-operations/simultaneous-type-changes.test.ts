import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "../../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  assertColumn,
  EnhancedAssertions,
  PerformanceUtils,
  DataIntegrityUtils,
} from "../column-test-utils";
import {
  BoundaryValues,
  StringEdgeCases,
  BooleanEdgeCases,
  POSTGRES_LIMITS,
  LargeDatasetGenerators,
} from "../test-data-generators";

describe("Simultaneous Type Changes", () => {
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

  describe("Two Column Simultaneous Type Changes", () => {
    test("should handle string to numeric and numeric to string conversions simultaneously", async () => {
      // 1. Setup initial table with mixed data types
      await client.query(`
        CREATE TABLE dualtest (
          id SERIAL PRIMARY KEY,
          price VARCHAR(20),
          quantity INTEGER
        );
      `);

      // Insert test data - numeric strings and integers
      const testData = [
        { price_str: "19.99", quantity_int: 100 },
        { price_str: "25.50", quantity_int: 75 },
        { price_str: "0.99", quantity_int: 1000 },
        { price_str: "199.95", quantity_int: 25 },
        { price_str: "5.00", quantity_int: 500 },
      ];

      for (const data of testData) {
        await client.query(
          "INSERT INTO dualtest (price, quantity) VALUES ($1, $2)",
          [data.price_str, data.quantity_int]
        );
      }

      // Capture initial data snapshot
      const beforeSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "dualtest",
        "id"
      );

      // 2. Desired state: swap types - price becomes INTEGER, quantity becomes VARCHAR
      const desiredSQL = `
        CREATE TABLE dualtest (
          id SERIAL PRIMARY KEY,
          price INTEGER,
          quantity VARCHAR(20)
        );
      `;

      // 3. Execute migration with performance measurement
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify type changes
      const finalColumns = await getTableColumns(client, "dualtest");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "price",
        "integer",
        "string to integer conversion"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "quantity",
        "character varying",
        "integer to varchar conversion"
      );

      // 5. Verify data integrity
      const afterSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "dualtest",
        "id"
      );

      expect(afterSnapshot).toHaveLength(testData.length);

      // Verify specific conversions
      for (let i = 0; i < testData.length; i++) {
        const before = beforeSnapshot[i];
        const after = afterSnapshot[i];

        // Price string should convert to integer (truncated)
        expect(after.price).toBe(Math.floor(parseFloat(before.price)));

        // Quantity integer should convert to string representation
        expect(after.quantity).toBe(before.quantity.toString());
      }

      // 6. Verify performance
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        4000,
        "dual type conversion"
      );
    });

    test("should handle compatible upscaling conversions simultaneously", async () => {
      // 1. Setup table with smaller numeric types
      await client.query(`
        CREATE TABLE upscaling_test (
          id SERIAL PRIMARY KEY,
          small_num SMALLINT,
          reg_num INTEGER,
          price_val VARCHAR(15)
        );
      `);

      // Insert boundary and edge case data
      const testData = [
        {
          small_num: POSTGRES_LIMITS.INT2_MAX,
          reg_num: POSTGRES_LIMITS.INT4_MAX,
          price_val: "999.99",
        },
        {
          small_num: POSTGRES_LIMITS.INT2_MIN,
          reg_num: POSTGRES_LIMITS.INT4_MIN,
          price_val: "0.01",
        },
        { small_num: 0, reg_num: 0, price_val: "100.50" },
        { small_num: -1, reg_num: -1, price_val: "50.25" },
        { small_num: 1000, reg_num: 1000000, price_val: "2500.75" },
      ];

      for (const data of testData) {
        await client.query(
          "INSERT INTO upscaling_test (small_num, reg_num, price_val) VALUES ($1, $2, $3)",
          [data.small_num, data.reg_num, data.price_val]
        );
      }

      // 2. Upscale all columns: SMALLINT → INTEGER, INTEGER → BIGINT, VARCHAR → NUMERIC
      const desiredSQL = `
        CREATE TABLE upscaling_test (
          id SERIAL PRIMARY KEY,
          small_num INTEGER,
          reg_num BIGINT,
          price_val NUMERIC(10,2)
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify all type changes
      const finalColumns = await getTableColumns(client, "upscaling_test");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "small_num",
        "integer",
        "SMALLINT to INTEGER"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "reg_num",
        "bigint",
        "INTEGER to BIGINT"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "price_val",
        "numeric",
        "VARCHAR to DECIMAL"
      );

      // 5. Verify data preservation
      const result = await client.query(
        "SELECT * FROM upscaling_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(testData.length);

      for (let i = 0; i < testData.length; i++) {
        const row = result.rows[i];
        const expected = testData[i];

        expect(row.small_num).toBe(expected.small_num);
        expect(row.reg_num).toBe(expected.reg_num.toString()); // BIGINT returns as string
        expect(parseFloat(row.price_val)).toBe(parseFloat(expected.price_val));
      }
    });
  });

  describe("Three Column Simultaneous Type Changes", () => {
    test("should handle complex three-way type conversions with data preservation", async () => {
      // 1. Setup table with three columns of different types
      await client.query(`
        CREATE TABLE triple_conversion_test (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(10),
          score INTEGER,
          is_active VARCHAR(10)
        );
      `);

      // Insert diverse test data
      const testData = [
        { user_id: "123", score: 85, is_active: "true" },
        { user_id: "456", score: 92, is_active: "false" },
        { user_id: "789", score: 78, is_active: "1" },
        { user_id: "101", score: 95, is_active: "0" },
        { user_id: "202", score: 67, is_active: "yes" },
        { user_id: "303", score: 88, is_active: "no" },
      ];

      for (const data of testData) {
        await client.query(
          "INSERT INTO triple_conversion_test (user_id, score, is_active) VALUES ($1, $2, $3)",
          [data.user_id, data.score, data.is_active]
        );
      }

      // 2. Convert: VARCHAR→INTEGER, INTEGER→NUMERIC, VARCHAR→BOOLEAN
      const desiredSQL = `
        CREATE TABLE triple_conversion_test (
          id SERIAL PRIMARY KEY,
          user_id INTEGER,
          score NUMERIC(5,2),
          is_active BOOLEAN
        );
      `;

      // 3. Execute migration with detailed performance tracking
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 4. Verify all type changes succeeded
      const finalColumns = await getTableColumns(
        client,
        "triple_conversion_test"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "user_id",
        "integer",
        "VARCHAR to INTEGER"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "score",
        "numeric",
        "INTEGER to DECIMAL"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "is_active",
        "boolean",
        "VARCHAR to BOOLEAN"
      );

      // 5. Verify complex data conversions
      const result = await client.query(
        "SELECT * FROM triple_conversion_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(testData.length);

      for (let i = 0; i < testData.length; i++) {
        const row = result.rows[i];
        const expected = testData[i];

        // VARCHAR to INTEGER conversion
        expect(row.user_id).toBe(parseInt(expected.user_id));

        // INTEGER to DECIMAL conversion (with .00 precision)
        expect(parseFloat(row.score)).toBe(expected.score);

        // VARCHAR to BOOLEAN conversion
        const expectedBoolean = BooleanEdgeCases.convertStringToBoolean(
          expected.is_active
        );
        expect(row.is_active).toBe(expectedBoolean);
      }

      // 6. Performance validation for complex conversion
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        6000,
        "triple type conversion"
      );
    });

    test("should handle mixed compatible and incompatible conversions with proper error handling", async () => {
      // 1. Setup table with problematic data for some conversions
      await client.query(`
        CREATE TABLE mixed_conversion_test (
          id SERIAL PRIMARY KEY,
          valid_numeric VARCHAR(10),
          invalid_numeric VARCHAR(50),
          valid_boolean VARCHAR(10)
        );
      `);

      // Insert data where one conversion will fail
      await client.query(`
        INSERT INTO mixed_conversion_test (valid_numeric, invalid_numeric, valid_boolean) 
        VALUES 
        ('123', 'not_a_number', 'true'),
        ('456', 'abc123', 'false'),
        ('789', 'invalid', '1');
      `);

      // 2. Attempt conversions: valid→INTEGER, invalid→INTEGER, valid→BOOLEAN
      const desiredSQL = `
        CREATE TABLE mixed_conversion_test (
          id SERIAL PRIMARY KEY,
          valid_numeric INTEGER,
          invalid_numeric INTEGER,
          valid_boolean BOOLEAN
        );
      `;

      // 3. Expect migration to fail due to invalid numeric conversion
      await EnhancedAssertions.assertMigrationFailure(
        executeColumnMigration(client, desiredSQL, services),
        /invalid input syntax for.*integer/i,
        "mixed valid/invalid conversion"
      );

      // 4. Verify rollback - original data should be intact
      const result = await client.query(
        "SELECT * FROM mixed_conversion_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(3);
      expect(result.rows[0].invalid_numeric).toBe("not_a_number");
      expect(result.rows[1].invalid_numeric).toBe("abc123");
      expect(result.rows[2].invalid_numeric).toBe("invalid");

      // 5. Verify original column types are preserved
      const columns = await getTableColumns(client, "mixed_conversion_test");
      EnhancedAssertions.assertColumnType(
        columns,
        "valid_numeric",
        "character varying"
      );
      EnhancedAssertions.assertColumnType(
        columns,
        "invalid_numeric",
        "character varying"
      );
      EnhancedAssertions.assertColumnType(
        columns,
        "valid_boolean",
        "character varying"
      );
    });
  });

  describe("Four+ Column Simultaneous Type Changes", () => {
    test("should handle complex multi-column scenarios with large datasets", async () => {
      // 1. Create table with four different types
      await client.query(`
        CREATE TABLE complex_multi_test (
          id SERIAL PRIMARY KEY,
          user_code VARCHAR(20),
          balance VARCHAR(15),
          items_count SMALLINT,
          status_flag VARCHAR(5)
        );
      `);

      // 2. Generate large dataset for performance testing (with numeric user codes)
      const DATASET_SIZE = 100;

      for (let i = 0; i < DATASET_SIZE; i++) {
        await client.query(
          "INSERT INTO complex_multi_test (user_code, balance, items_count, status_flag) VALUES ($1, $2, $3, $4)",
          [
            (i + 1000).toString(), // Numeric string that can convert to integer
            (Math.random() * 1000).toFixed(2),
            Math.floor(Math.random() * 32767),
            Math.random() > 0.5 ? "true" : "false",
          ]
        );
      }

      // 3. Complex simultaneous conversions
      const desiredSQL = `
        CREATE TABLE complex_multi_test (
          id SERIAL PRIMARY KEY,
          user_code INTEGER,
          balance NUMERIC(12,2),
          items_count INTEGER,
          status_flag BOOLEAN
        );
      `;

      // 4. Measure performance of large-scale simultaneous conversions
      const { duration, result } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
          return await client.query("SELECT COUNT(*) FROM complex_multi_test");
        }
      );

      // 5. Verify all conversions succeeded
      const finalColumns = await getTableColumns(client, "complex_multi_test");
      EnhancedAssertions.assertColumnType(finalColumns, "user_code", "integer");
      EnhancedAssertions.assertColumnType(finalColumns, "balance", "numeric");
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "items_count",
        "integer"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "status_flag",
        "boolean"
      );

      // 6. Verify data count preserved
      expect(parseInt(result.rows[0].count)).toBe(DATASET_SIZE);

      // 7. Performance validation for large dataset
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        15000, // Allow more time for large dataset
        "complex multi-column large dataset conversion"
      );
    });

    test("should handle simultaneous conversions with constraint changes", async () => {
      // 1. Setup table with nullable columns
      await client.query(`
        CREATE TABLE constraint_conversion_test (
          id SERIAL PRIMARY KEY,
          required_field VARCHAR(50),
          optional_field VARCHAR(20),
          counter_field VARCHAR(10),
          flag_field VARCHAR(10)  
        );
      `);

      // Insert data with some NULL values (using numeric strings for integer conversion)
      await client.query(`
        INSERT INTO constraint_conversion_test (required_field, optional_field, counter_field, flag_field)
        VALUES 
        ('required_value_1', '1001', '100', 'true'),
        ('required_value_2', NULL, '200', 'false'),
        ('required_value_3', '1003', '300', '1'),
        ('required_value_4', NULL, '400', '0');
      `);

      // 2. Convert types AND change constraints simultaneously
      const desiredSQL = `
        CREATE TABLE constraint_conversion_test (
          id SERIAL PRIMARY KEY,
          required_field TEXT NOT NULL,
          optional_field INTEGER,
          counter_field BIGINT NOT NULL DEFAULT 0,
          flag_field BOOLEAN NOT NULL
        );
      `;

      // 3. Execute migration
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify type changes
      const finalColumns = await getTableColumns(
        client,
        "constraint_conversion_test"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "required_field",
        "text"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "optional_field",
        "integer"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "counter_field",
        "bigint"
      );
      EnhancedAssertions.assertColumnType(
        finalColumns,
        "flag_field",
        "boolean"
      );

      // 5. Verify constraint changes
      assertColumn(finalColumns, "required_field", { nullable: false });
      assertColumn(finalColumns, "optional_field", { nullable: true });
      assertColumn(finalColumns, "counter_field", { nullable: false });
      assertColumn(finalColumns, "flag_field", { nullable: false });

      // 6. Verify data preservation and default handling
      const result = await client.query(
        "SELECT * FROM constraint_conversion_test ORDER BY id"
      );
      expect(result.rows).toHaveLength(4);

      // Required field should be preserved as TEXT
      expect(result.rows[0].required_field).toBe("required_value_1");

      // Optional field NULL values should be preserved, non-NULL converted to INTEGER
      expect(result.rows[0].optional_field).toBe(1001); // Converted to INTEGER
      expect(result.rows[1].optional_field).toBe(null); // NULL preserved
      expect(result.rows[2].optional_field).toBe(1003); // Converted to INTEGER
      expect(result.rows[3].optional_field).toBe(null); // NULL preserved

      // Counter field converted to BIGINT (returned as string)
      expect(result.rows[0].counter_field).toBe("100");
      expect(result.rows[1].counter_field).toBe("200");
      expect(result.rows[2].counter_field).toBe("300");
      expect(result.rows[3].counter_field).toBe("400");

      // Flag field converted to BOOLEAN
      expect(result.rows[0].flag_field).toBe(true);
      expect(result.rows[1].flag_field).toBe(false);
      expect(result.rows[2].flag_field).toBe(true);
      expect(result.rows[3].flag_field).toBe(false);
    });
  });

  describe("Edge Cases and Error Scenarios", () => {
    test("should handle partial failures in simultaneous conversions with proper rollback", async () => {
      // 1. Setup table where one conversion will definitely fail
      await client.query(`
        CREATE TABLE partial_failure_test (
          id SERIAL PRIMARY KEY,
          good_numeric VARCHAR(10),
          bad_numeric VARCHAR(20),
          good_boolean VARCHAR(10)
        );
      `);

      // Insert data where middle column will fail conversion
      await client.query(`
        INSERT INTO partial_failure_test (good_numeric, bad_numeric, good_boolean)
        VALUES 
        ('123', 'not_a_number', 'true'),
        ('456', 'invalid', 'false'),
        ('789', 'bad_data', '1');
      `);

      // Capture original state
      const originalSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "partial_failure_test"
      );

      // 2. Attempt simultaneous conversions where one will fail
      const desiredSQL = `
        CREATE TABLE partial_failure_test (
          id SERIAL PRIMARY KEY,
          good_numeric INTEGER,
          bad_numeric INTEGER,
          good_boolean BOOLEAN
        );
      `;

      // 3. Expect complete rollback on failure
      await EnhancedAssertions.assertMigrationFailure(
        executeColumnMigration(client, desiredSQL, services),
        /invalid input syntax for.*integer/i,
        "partial failure scenario"
      );

      // 4. Verify complete rollback - ALL data should be unchanged
      await EnhancedAssertions.assertTransactionRollback(
        client,
        "partial_failure_test",
        originalSnapshot.length,
        "partial failure rollback"
      );

      // Verify original column types are preserved
      const columns = await getTableColumns(client, "partial_failure_test");
      EnhancedAssertions.assertColumnType(
        columns,
        "good_numeric",
        "character varying"
      );
      EnhancedAssertions.assertColumnType(
        columns,
        "bad_numeric",
        "character varying"
      );
      EnhancedAssertions.assertColumnType(
        columns,
        "good_boolean",
        "character varying"
      );

      // Verify original data is intact
      const finalSnapshot = await DataIntegrityUtils.captureTableSnapshot(
        client,
        "partial_failure_test"
      );

      expect(finalSnapshot).toEqual(originalSnapshot);
    });

    test("should handle boundary value edge cases in simultaneous conversions", async () => {
      // 1. Setup with boundary values for multiple types
      await client.query(`
        CREATE TABLE boundary_simultaneous_test (
          id SERIAL PRIMARY KEY,
          max_int_str VARCHAR(15),
          min_int_str VARCHAR(15),
          max_decimal_str VARCHAR(25),
          boundary_bool VARCHAR(10)
        );
      `);

      // Insert boundary values
      await client.query(`
        INSERT INTO boundary_simultaneous_test (max_int_str, min_int_str, max_decimal_str, boundary_bool)
        VALUES 
        ('${POSTGRES_LIMITS.INT4_MAX}', '${
        POSTGRES_LIMITS.INT4_MIN
      }', '999999.99', 'true'),
        ('${POSTGRES_LIMITS.INT4_MAX - 1}', '${
        POSTGRES_LIMITS.INT4_MIN + 1
      }', '0.01', 'false'),
        ('0', '0', '123456.789', '1');
      `);

      // 2. Convert all to their respective target types
      const desiredSQL = `
        CREATE TABLE boundary_simultaneous_test (
          id SERIAL PRIMARY KEY,
          max_int_str INTEGER,
          min_int_str INTEGER,
          max_decimal_str NUMERIC(10,3),
          boundary_bool BOOLEAN
        );
      `;

      // 3. Execute conversion
      await executeColumnMigration(client, desiredSQL, services);

      // 4. Verify boundary values preserved correctly
      const result = await client.query(
        "SELECT * FROM boundary_simultaneous_test ORDER BY id"
      );

      // First row - max/min boundaries
      expect(result.rows[0].max_int_str).toBe(POSTGRES_LIMITS.INT4_MAX);
      expect(result.rows[0].min_int_str).toBe(POSTGRES_LIMITS.INT4_MIN);
      expect(parseFloat(result.rows[0].max_decimal_str)).toBe(999999.99);
      expect(result.rows[0].boundary_bool).toBe(true);

      // Second row - near boundaries
      expect(result.rows[1].max_int_str).toBe(POSTGRES_LIMITS.INT4_MAX - 1);
      expect(result.rows[1].min_int_str).toBe(POSTGRES_LIMITS.INT4_MIN + 1);
      expect(parseFloat(result.rows[1].max_decimal_str)).toBe(0.01);
      expect(result.rows[1].boundary_bool).toBe(false);

      // Third row - zero boundary
      expect(result.rows[2].max_int_str).toBe(0);
      expect(result.rows[2].min_int_str).toBe(0);
      expect(parseFloat(result.rows[2].max_decimal_str)).toBe(123456.789);
      expect(result.rows[2].boundary_bool).toBe(true);
    });
  });

  describe("Performance and Concurrency", () => {
    test("should maintain acceptable performance with simultaneous conversions on large datasets", async () => {
      // 1. Create large table for performance testing
      await client.query(`
        CREATE TABLE performance_simultaneous_test (
          id SERIAL PRIMARY KEY,
          col1 VARCHAR(50),
          col2 VARCHAR(20),
          col3 VARCHAR(15),
          col4 VARCHAR(10),
          col5 VARCHAR(5)
        );
      `);

      // 2. Generate substantial dataset
      const DATASET_SIZE = 1000;
      const batchSize = 100;

      for (let batch = 0; batch < DATASET_SIZE / batchSize; batch++) {
        const values = [];
        for (let i = 0; i < batchSize; i++) {
          const rowNum = batch * batchSize + i;
          values.push(
            `(${rowNum + 1}, 'text_${rowNum}', '${rowNum}', '${(
              rowNum * 1.5
            ).toFixed(2)}', '${
              rowNum % 2 === 0 ? "true" : "false"
            }', '${String.fromCharCode(65 + (rowNum % 26))}')`
          );
        }

        await client.query(`
          INSERT INTO performance_simultaneous_test (id, col1, col2, col3, col4, col5) 
          VALUES ${values.join(", ")}
        `);
      }

      // 3. Perform simultaneous conversions on all columns
      const desiredSQL = `
        CREATE TABLE performance_simultaneous_test (
          id SERIAL PRIMARY KEY,
          col1 TEXT,
          col2 INTEGER,
          col3 NUMERIC(8,2),
          col4 BOOLEAN,
          col5 CHAR(1)
        );
      `;

      // 4. Measure conversion performance
      const { duration } = await PerformanceUtils.measureMigrationTime(
        async () => {
          await executeColumnMigration(client, desiredSQL, services);
        }
      );

      // 5. Verify all conversions completed
      const finalColumns = await getTableColumns(
        client,
        "performance_simultaneous_test"
      );
      EnhancedAssertions.assertColumnType(finalColumns, "col1", "text");
      EnhancedAssertions.assertColumnType(finalColumns, "col2", "integer");
      EnhancedAssertions.assertColumnType(finalColumns, "col3", "numeric");
      EnhancedAssertions.assertColumnType(finalColumns, "col4", "boolean");
      EnhancedAssertions.assertColumnType(finalColumns, "col5", "character");

      // 6. Verify data integrity maintained
      const rowCount = await client.query(
        "SELECT COUNT(*) FROM performance_simultaneous_test"
      );
      expect(parseInt(rowCount.rows[0].count)).toBe(DATASET_SIZE);

      // 7. Performance assertion - should complete within reasonable time
      PerformanceUtils.assertPerformanceWithinBounds(
        duration,
        30000, // 30 seconds max for 1000 rows, 5 columns
        "large dataset simultaneous conversion performance"
      );

      console.log(
        `Simultaneous conversion of ${DATASET_SIZE} rows, 5 columns completed in ${duration}ms`
      );
    });
  });
});
