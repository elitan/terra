import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaParser } from "../../core/schema/parser";
import { DatabaseInspector } from "../../core/schema/inspector";
import { createTestClient } from "../utils";
import { SchemaDiffer } from "../../core/schema/differ";
import type { Index, Table } from "../../types/schema";

describe("Expression Index Support", () => {
  let client: Client;
  let parser: SchemaParser;
  let inspector: DatabaseInspector;

  beforeEach(async () => {
    client = await createTestClient();

    parser = new SchemaParser();
    inspector = new DatabaseInspector();

    // Clean up any existing test tables
    await client.query("DROP TABLE IF EXISTS expression_test CASCADE");
  });

  afterEach(async () => {
    await client.query("DROP TABLE IF EXISTS expression_test CASCADE");
    await client.end();
  });

  describe("Parser Support", () => {
    test("should parse simple function expression indexes", async () => {
      const sql = `
        CREATE TABLE expression_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          name VARCHAR(100)
        );
        
        CREATE INDEX idx_lower_email ON expression_test (LOWER(email));
        CREATE INDEX idx_upper_name ON expression_test (UPPER(name));
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(2);

      const lowerEmailIndex = indexes.find(
        (idx) => idx.name === "idx_lower_email"
      );
      expect(lowerEmailIndex).toBeDefined();
      expect(lowerEmailIndex?.expression).toBe("lower(email)");
      expect(lowerEmailIndex?.columns).toEqual([]);

      const upperNameIndex = indexes.find(
        (idx) => idx.name === "idx_upper_name"
      );
      expect(upperNameIndex).toBeDefined();
      expect(upperNameIndex?.expression).toBe("upper(name)");
      expect(upperNameIndex?.columns).toEqual([]);
    });

    test("should parse multi-argument function expression indexes", async () => {
      const sql = `
        CREATE INDEX idx_concat ON expression_test (CONCAT(first_name, ' ', last_name));
        CREATE INDEX idx_substring ON expression_test (SUBSTRING(email, 1, 10));
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(2);

      const concatIndex = indexes.find((idx) => idx.name === "idx_concat");
      expect(concatIndex?.expression).toBe(
        "concat(first_name, ' ', last_name)"
      );

      const substringIndex = indexes.find(
        (idx) => idx.name === "idx_substring"
      );
      expect(substringIndex?.expression).toBe("substring(email, 1, 10)");
    });
  });

  describe("Database Inspector Support", () => {
    test("should extract expression indexes from database", async () => {
      // Create table and expression indexes
      await client.query(`
        CREATE TABLE expression_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          first_name VARCHAR(100),
          last_name VARCHAR(100)
        )
      `);

      await client.query(
        `CREATE INDEX idx_lower_email ON expression_test (LOWER(email))`
      );
      await client.query(
        `CREATE INDEX idx_upper_first_name ON expression_test (UPPER(first_name))`
      );
      await client.query(
        `CREATE INDEX idx_length_first_name ON expression_test (LENGTH(first_name))`
      );

      // Inspect the database
      const tables = await inspector.getCurrentSchema(client);
      const testTable = tables.find((t) => t.name === "expression_test");

      expect(testTable).toBeDefined();
      expect(testTable?.indexes).toBeDefined();
      expect(testTable?.indexes?.length).toBeGreaterThanOrEqual(3);

      // Check expression indexes
      const lowerEmailIndex = testTable?.indexes?.find(
        (idx) => idx.name === "idx_lower_email"
      );
      expect(lowerEmailIndex).toBeDefined();
      expect(lowerEmailIndex?.expression).toBeDefined();
      expect(lowerEmailIndex?.expression).toContain("lower");
      expect(lowerEmailIndex?.expression).toContain("email");
      expect(lowerEmailIndex?.columns).toEqual([]);

      const upperFirstNameIndex = testTable?.indexes?.find(
        (idx) => idx.name === "idx_upper_first_name"
      );
      expect(upperFirstNameIndex).toBeDefined();
      expect(upperFirstNameIndex?.expression).toBeDefined();
      expect(upperFirstNameIndex?.expression).toContain("upper");
      expect(upperFirstNameIndex?.expression).toContain("first_name");

      const lengthFirstNameIndex = testTable?.indexes?.find(
        (idx) => idx.name === "idx_length_first_name"
      );
      expect(lengthFirstNameIndex).toBeDefined();
      expect(lengthFirstNameIndex?.expression).toBeDefined();
      expect(lengthFirstNameIndex?.expression).toContain("length");
    });

    test("should distinguish between regular column indexes and expression indexes", async () => {
      // Create table with both regular and expression indexes
      await client.query(`
        CREATE TABLE expression_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          status VARCHAR(50)
        )
      `);

      await client.query(
        `CREATE INDEX idx_regular_email ON expression_test (email)`
      );
      await client.query(
        `CREATE INDEX idx_expression_email ON expression_test (LOWER(email))`
      );
      await client.query(
        `CREATE INDEX idx_regular_status ON expression_test (status)`
      );

      // Inspect the database
      const tables = await inspector.getCurrentSchema(client);
      const testTable = tables.find((t) => t.name === "expression_test");

      expect(testTable?.indexes).toBeDefined();
      expect(testTable?.indexes?.length).toBeGreaterThanOrEqual(3);

      // Regular column index should have columns but no expression
      const regularEmailIndex = testTable?.indexes?.find(
        (idx) => idx.name === "idx_regular_email"
      );
      expect(regularEmailIndex).toBeDefined();
      expect(regularEmailIndex?.columns).toEqual(["email"]);
      expect(regularEmailIndex?.expression).toBeUndefined();

      // Expression index should have expression but no columns
      const expressionEmailIndex = testTable?.indexes?.find(
        (idx) => idx.name === "idx_expression_email"
      );
      expect(expressionEmailIndex).toBeDefined();
      expect(expressionEmailIndex?.columns).toEqual([]);
      expect(expressionEmailIndex?.expression).toBeDefined();
      expect(expressionEmailIndex?.expression).toContain("lower");

      // Another regular index
      const regularStatusIndex = testTable?.indexes?.find(
        (idx) => idx.name === "idx_regular_status"
      );
      expect(regularStatusIndex).toBeDefined();
      expect(regularStatusIndex?.columns).toEqual(["status"]);
      expect(regularStatusIndex?.expression).toBeUndefined();
    });

    test("should extract storage parameters and tablespace from database", async () => {
      // Create table and indexes with storage parameters and tablespace
      await client.query(`
        CREATE TABLE advanced_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          data TEXT
        )
      `);

      // Create index with storage parameters (fillfactor is commonly supported)
      await client.query(`
        CREATE INDEX idx_email_with_params ON advanced_test (email) 
        WITH (fillfactor = 80)
      `);

      // Create index with expression and storage parameters
      await client.query(`
        CREATE INDEX idx_lower_email_params ON advanced_test (LOWER(email)) 
        WITH (fillfactor = 70)
      `);

      // Note: We can't easily test tablespace extraction in the test environment
      // since creating tablespaces requires filesystem permissions, but the parsing logic is tested above

      // Inspect the database
      const tables = await inspector.getCurrentSchema(client);
      const testTable = tables.find((t) => t.name === "advanced_test");

      expect(testTable).toBeDefined();
      expect(testTable?.indexes).toBeDefined();
      expect(testTable?.indexes?.length).toBeGreaterThanOrEqual(2);

      // Check regular index with storage parameters
      const emailIndex = testTable?.indexes?.find(
        (idx) => idx.name === "idx_email_with_params"
      );
      expect(emailIndex).toBeDefined();
      expect(emailIndex!.columns).toEqual(["email"]);
      expect(emailIndex!.storageParameters).toBeDefined();
      expect(emailIndex!.storageParameters!.fillfactor).toBe("80");

      // Check expression index with storage parameters
      const lowerEmailIndex = testTable?.indexes?.find(
        (idx) => idx.name === "idx_lower_email_params"
      );
      expect(lowerEmailIndex).toBeDefined();
      expect(lowerEmailIndex!.expression).toBeDefined();
      expect(lowerEmailIndex!.expression).toContain("lower");
      expect(lowerEmailIndex!.columns).toEqual([]);
      expect(lowerEmailIndex!.storageParameters).toBeDefined();
      expect(lowerEmailIndex!.storageParameters!.fillfactor).toBe("70");

      // Clean up
      await client.query("DROP TABLE advanced_test CASCADE");
    });
  });

  describe("Integration Tests", () => {
    test("should handle expression indexes with WHERE clauses (partial expression indexes)", async () => {
      await client.query(`
        CREATE TABLE expression_test (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          active BOOLEAN
        )
      `);

      await client.query(`
        CREATE INDEX idx_active_lower_email 
        ON expression_test (LOWER(email)) 
        WHERE active = true
      `);

      // Test parser
      const sql = `CREATE INDEX idx_active_lower_email ON expression_test (LOWER(email)) WHERE active = true`;
      const indexes = await parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(1);
      expect(indexes[0]?.expression).toBe("lower(email)");
      expect(indexes[0]?.where).toBe("active = true");

      // Test inspector
      const tables = await inspector.getCurrentSchema(client);
      const testTable = tables.find((t) => t.name === "expression_test");
      const index = testTable?.indexes?.find(
        (idx) => idx.name === "idx_active_lower_email"
      );

      expect(index).toBeDefined();
      expect(index?.expression).toBeDefined();
      expect(index?.where).toBeDefined();
      expect(index?.where).toContain("active");
    });
  });
});

describe("Schema Differ Support", () => {
  test("should correctly compare identical expression indexes", async () => {
    const index1: Index = {
      name: "idx_email_lower",
      tableName: "users",
      columns: [],
      expression: "LOWER(email)",
      type: "btree",
    };

    const index2: Index = {
      name: "idx_email_lower",
      tableName: "users",
      columns: [],
      expression: "LOWER(email)",
      type: "btree",
    };

    const differ = new SchemaDiffer();
    // Access private method for testing
    const areEqual = (differ as any).indexesAreEqual(index1, index2);
    expect(areEqual).toBe(true);
  });

  test("should detect differences in expression indexes", async () => {
    const index1: Index = {
      name: "idx_email_lower",
      tableName: "users",
      columns: [],
      expression: "LOWER(email)",
      type: "btree",
    };

    const index2: Index = {
      name: "idx_email_lower",
      tableName: "users",
      columns: [],
      expression: "UPPER(email)", // Different expression
      type: "btree",
    };

    const differ = new SchemaDiffer();
    const areEqual = (differ as any).indexesAreEqual(index1, index2);
    expect(areEqual).toBe(false);
  });

  test("should distinguish between expression indexes and column indexes", async () => {
    const expressionIndex: Index = {
      name: "idx_email_expr",
      tableName: "users",
      columns: [],
      expression: "LOWER(email)",
      type: "btree",
    };

    const columnIndex: Index = {
      name: "idx_email_col",
      tableName: "users",
      columns: ["email"],
      type: "btree",
    };

    const differ = new SchemaDiffer();
    const areEqual = (differ as any).indexesAreEqual(
      expressionIndex,
      columnIndex
    );
    expect(areEqual).toBe(false);
  });

  test("should handle expression indexes with WHERE clauses", async () => {
    const index1: Index = {
      name: "idx_active_email_lower",
      tableName: "users",
      columns: [],
      expression: "LOWER(email)",
      where: "active = true",
      type: "btree",
    };

    const index2: Index = {
      name: "idx_active_email_lower",
      tableName: "users",
      columns: [],
      expression: "LOWER(email)",
      where: "active = true",
      type: "btree",
    };

    const differ = new SchemaDiffer();
    const areEqual = (differ as any).indexesAreEqual(index1, index2);
    expect(areEqual).toBe(true);
  });

  test("should generate correct migration plan for expression indexes", async () => {
    const currentSchema: Table[] = [
      {
        name: "users",
        columns: [
          { name: "id", type: "INTEGER", nullable: false },
          { name: "email", type: "VARCHAR(255)", nullable: false },
        ],
        indexes: [
          {
            name: "idx_email_regular",
            tableName: "users",
            columns: ["email"],
            type: "btree",
          },
        ],
      },
    ];

    const desiredSchema: Table[] = [
      {
        name: "users",
        columns: [
          { name: "id", type: "INTEGER", nullable: false },
          { name: "email", type: "VARCHAR(255)", nullable: false },
        ],
        indexes: [
          {
            name: "idx_email_regular",
            tableName: "users",
            columns: ["email"],
            type: "btree",
          },
          {
            name: "idx_email_lower",
            tableName: "users",
            columns: [],
            expression: "LOWER(email)",
            type: "btree",
          },
        ],
      },
    ];

    const differ = new SchemaDiffer();
    const migrationPlan = differ.generateMigrationPlan(
      desiredSchema,
      currentSchema
    );

    const allStatements = [
      ...migrationPlan.transactional,
      ...migrationPlan.concurrent,
    ];
    expect(allStatements).toContain(
      "CREATE INDEX CONCURRENTLY idx_email_lower ON users (LOWER(email));"
    );
  });

  test("should generate correct SQL for expression indexes", async () => {
    const expressionIndex: Index = {
      name: "idx_email_lower",
      tableName: "users",
      columns: [],
      expression: "LOWER(email)",
      type: "btree",
    };

    const differ = new SchemaDiffer();
    const sql = (differ as any).generateCreateIndexSQL(expressionIndex);

    expect(sql).toBe(
      "CREATE INDEX CONCURRENTLY idx_email_lower ON users (LOWER(email));"
    );
  });

  test("should generate correct SQL for unique expression indexes", async () => {
    const uniqueExpressionIndex: Index = {
      name: "idx_email_lower_unique",
      tableName: "users",
      columns: [],
      expression: "LOWER(email)",
      type: "btree",
      unique: true,
    };

    const differ = new SchemaDiffer();
    const sql = (differ as any).generateCreateIndexSQL(uniqueExpressionIndex);

    expect(sql).toBe(
      "CREATE UNIQUE INDEX CONCURRENTLY idx_email_lower_unique ON users (LOWER(email));"
    );
  });
});

describe("Advanced Index Options Support", () => {
  let parser: SchemaParser;

  beforeEach(() => {
    parser = new SchemaParser();
  });

  test("should parse storage parameters in index definitions", async () => {
    const sql = `
      CREATE INDEX idx_users_email_with_params ON users (email) 
      WITH (fillfactor = 90, deduplicate_items = off);
    `;

    const indexes = await parser.parseCreateIndexStatements(sql);
    expect(indexes).toHaveLength(1);

    const index = indexes[0]!;
    expect(index.name).toBe("idx_users_email_with_params");
    expect(index.storageParameters).toEqual({
      fillfactor: "90",
      deduplicate_items: "off",
    });
  });

  test("should parse tablespace specifications in index definitions", async () => {
    const sql = `
      CREATE INDEX idx_users_email_tablespace ON users (email) 
      TABLESPACE pg_default;
    `;

    const indexes = await parser.parseCreateIndexStatements(sql);
    expect(indexes).toHaveLength(1);

    const index = indexes[0]!;
    expect(index.name).toBe("idx_users_email_tablespace");
    expect(index.tablespace).toBe("pg_default");
  });

  test("should parse indexes with both storage parameters and tablespace", async () => {
    const sql = `
      CREATE UNIQUE INDEX idx_users_email_full_options ON users (email) 
      WITH (fillfactor = 80) 
      TABLESPACE fast_ssd;
    `;

    const indexes = await parser.parseCreateIndexStatements(sql);
    expect(indexes).toHaveLength(1);

    const index = indexes[0]!;
    expect(index.name).toBe("idx_users_email_full_options");
    expect(index.unique).toBe(true);
    expect(index.storageParameters).toEqual({
      fillfactor: "80",
    });
    expect(index.tablespace).toBe("fast_ssd");
  });

  test("should parse expression indexes with storage parameters", async () => {
    const sql = `
      CREATE INDEX idx_users_lower_email_params ON users (LOWER(email)) 
      WITH (fillfactor = 70, deduplicate_items = on);
    `;

    const indexes = await parser.parseCreateIndexStatements(sql);
    expect(indexes).toHaveLength(1);

    const index = indexes[0]!;
    expect(index.name).toBe("idx_users_lower_email_params");
    expect(index.expression).toBe("lower(email)");
    expect(index.columns).toEqual([]);
    expect(index.storageParameters).toEqual({
      fillfactor: "70",
      deduplicate_items: "on",
    });
  });

  test("should parse partial indexes with storage parameters and tablespace", async () => {
    const sql = `
      CREATE INDEX idx_active_users_email_advanced ON users (email)
      WITH (fillfactor = 85)
      TABLESPACE index_space
      WHERE active = true;
    `;

    const indexes = await parser.parseCreateIndexStatements(sql);
    expect(indexes).toHaveLength(1);

    const index = indexes[0]!;
    expect(index.name).toBe("idx_active_users_email_advanced");
    expect(index.columns).toEqual(["email"]);
    expect(index.where).toBe("active = true");
    expect(index.storageParameters).toEqual({
      fillfactor: "85",
    });
    expect(index.tablespace).toBe("index_space");
  });

  test("should handle indexes without storage parameters or tablespace", async () => {
    const sql = `
      CREATE INDEX idx_users_simple ON users (email);
    `;

    const indexes = await parser.parseCreateIndexStatements(sql);
    expect(indexes).toHaveLength(1);

    const index = indexes[0]!;
    expect(index.name).toBe("idx_users_simple");
    expect(index.storageParameters).toBeUndefined();
    expect(index.tablespace).toBeUndefined();
  });
});
