import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SchemaParser } from "../../core/schema/parser";
import { DatabaseInspector } from "../../core/schema/inspector";
import { createTestClient, cleanDatabase } from "../utils";
import type { Client } from "pg";
import type { Table } from "../../types/schema";

describe("PostgreSQL Index Operator Class Support", () => {
  let client: Client;
  let parser: SchemaParser;
  let inspector: DatabaseInspector;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    parser = new SchemaParser();
    inspector = new DatabaseInspector();
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("Parser - Operator Class Support", () => {
    test("should parse GIN index with gin_trgm_ops operator class", async () => {
      const sql = `
        CREATE TABLE docs (
          id SERIAL PRIMARY KEY,
          title TEXT
        );
        CREATE INDEX idx_docs_title ON docs USING GIN (title gin_trgm_ops);
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe("idx_docs_title");
      expect(indexes[0].columns).toEqual(["title"]);
      expect(indexes[0].type).toBe("gin");
      expect(indexes[0].opclasses).toEqual({ title: "gin_trgm_ops" });
    });

    test("should parse index without operator class", async () => {
      const sql = `
        CREATE TABLE docs (
          id SERIAL PRIMARY KEY,
          data JSONB
        );
        CREATE INDEX idx_docs_data ON docs USING GIN (data);
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(1);
      expect(indexes[0].opclasses).toBeUndefined();
    });

    test("should parse multi-column index with mixed operator classes", async () => {
      const sql = `
        CREATE TABLE docs (
          id SERIAL PRIMARY KEY,
          title TEXT,
          body TEXT
        );
        CREATE INDEX idx_docs_search ON docs USING GIN (title gin_trgm_ops, body gin_trgm_ops);
      `;

      const indexes = await parser.parseCreateIndexStatements(sql);

      expect(indexes).toHaveLength(1);
      expect(indexes[0].columns).toEqual(["title", "body"]);
      expect(indexes[0].opclasses).toEqual({
        title: "gin_trgm_ops",
        body: "gin_trgm_ops",
      });
    });
  });

  describe("Inspector - Operator Class Detection", () => {
    test("should detect gin_trgm_ops operator class from database", async () => {
      await client.query(`
        CREATE TABLE test_docs (
          id SERIAL PRIMARY KEY,
          title TEXT
        );
      `);

      await client.query(`
        CREATE INDEX idx_test_docs_title ON test_docs USING GIN (title gin_trgm_ops);
      `);

      const indexes = await inspector.getTableIndexes(client, "test_docs", "public");

      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe("idx_test_docs_title");
      expect(indexes[0].type).toBe("gin");
      expect(indexes[0].opclasses).toEqual({ title: "gin_trgm_ops" });
    });

    test("should not include default operator class", async () => {
      await client.query(`
        CREATE TABLE test_docs (
          id SERIAL PRIMARY KEY,
          data JSONB
        );
      `);

      await client.query(`
        CREATE INDEX idx_test_docs_data ON test_docs USING GIN (data);
      `);

      const indexes = await inspector.getTableIndexes(client, "test_docs", "public");

      expect(indexes).toHaveLength(1);
      expect(indexes[0].opclasses).toBeUndefined();
    });
  });

  describe("Differ - Operator Class Comparison", () => {
    test("should generate SQL with operator class", async () => {
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();

      const currentSchema: Table[] = [
        {
          name: "docs",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "title", type: "TEXT", nullable: true },
          ],
          indexes: [],
        },
      ];

      const desiredSchema: Table[] = [
        {
          name: "docs",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "title", type: "TEXT", nullable: true },
          ],
          indexes: [
            {
              name: "idx_docs_title",
              tableName: "docs",
              columns: ["title"],
              opclasses: { title: "gin_trgm_ops" },
              type: "gin",
              unique: false,
              concurrent: false,
            },
          ],
        },
      ];

      const plan = differ.generateMigrationPlan(desiredSchema, currentSchema);

      const allStatements = [...plan.transactional, ...plan.concurrent];
      expect(allStatements).toContain(
        'CREATE INDEX "idx_docs_title" ON "docs" USING GIN ("title" gin_trgm_ops);'
      );
    });

    test("should detect opclass change as index modification", async () => {
      const { SchemaDiffer } = require("../../core/schema/differ");
      const differ = new SchemaDiffer();

      const currentSchema: Table[] = [
        {
          name: "docs",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "title", type: "TEXT", nullable: true },
          ],
          indexes: [
            {
              name: "idx_docs_title",
              tableName: "docs",
              columns: ["title"],
              type: "gin",
              unique: false,
              concurrent: false,
            },
          ],
        },
      ];

      const desiredSchema: Table[] = [
        {
          name: "docs",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "title", type: "TEXT", nullable: true },
          ],
          indexes: [
            {
              name: "idx_docs_title",
              tableName: "docs",
              columns: ["title"],
              opclasses: { title: "gin_trgm_ops" },
              type: "gin",
              unique: false,
              concurrent: false,
            },
          ],
        },
      ];

      const plan = differ.generateMigrationPlan(desiredSchema, currentSchema);

      const allStatements = [...plan.transactional, ...plan.concurrent];
      expect(allStatements).toContain(
        'DROP INDEX CONCURRENTLY "idx_docs_title";'
      );
      expect(allStatements).toContain(
        'CREATE INDEX "idx_docs_title" ON "docs" USING GIN ("title" gin_trgm_ops);'
      );
    });
  });

  describe("Integration - Full Roundtrip", () => {
    test("should apply and detect gin_trgm_ops index correctly", async () => {
      await client.query(`
        CREATE TABLE test_articles (
          id SERIAL PRIMARY KEY,
          title TEXT
        );
      `);

      await client.query(`
        CREATE INDEX idx_articles_title ON test_articles USING GIN (title gin_trgm_ops);
      `);

      const schema = `
        CREATE TABLE test_articles (
          id SERIAL PRIMARY KEY,
          title TEXT
        );
        CREATE INDEX idx_articles_title ON test_articles USING GIN (title gin_trgm_ops);
      `;

      const parsedIndexes = await parser.parseCreateIndexStatements(schema);
      const dbIndexes = await inspector.getTableIndexes(client, "test_articles", "public");

      expect(parsedIndexes[0].opclasses).toEqual({ title: "gin_trgm_ops" });
      expect(dbIndexes[0].opclasses).toEqual({ title: "gin_trgm_ops" });

      expect(parsedIndexes[0].opclasses).toEqual(dbIndexes[0].opclasses);
    });
  });
});
