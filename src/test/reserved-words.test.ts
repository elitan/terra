import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../core/schema/service";
import { createTestClient, cleanDatabase, createTestDatabaseService } from "./utils";

describe("Reserved Word Identifiers", () => {
  let client: Client;
  let schemaService: SchemaService;

  beforeEach(async () => {
    client = await createTestClient();
    await cleanDatabase(client);
    const databaseService = createTestDatabaseService();
    schemaService = new SchemaService(databaseService);
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("Table Names", () => {
    test("should handle reserved word 'user' as table name", async () => {
      const schema = `
        CREATE TABLE "user" (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL
        );
      `;

      await schemaService.apply(schema, ["public"], true);

      const result = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user'
      `);

      expect(result.rows.length).toBe(1);
    });

    test("should handle reserved word 'order' as table name", async () => {
      const schema = `
        CREATE TABLE "order" (
          id SERIAL PRIMARY KEY,
          total NUMERIC(10,2) NOT NULL
        );
      `;

      await schemaService.apply(schema, ["public"], true);

      const result = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'order'
      `);

      expect(result.rows.length).toBe(1);
    });

    test("should handle reserved word 'group' as table name with columns and constraints", async () => {
      const schema = `
        CREATE TABLE "group" (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          CONSTRAINT group_name_check CHECK (name <> '')
        );
      `;

      await schemaService.apply(schema, ["public"], true);

      const result = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'group'
      `);

      expect(result.rows.length).toBe(1);
    });
  });

  describe("Table Names with Foreign Keys", () => {
    test("should handle foreign keys referencing reserved word table names", async () => {
      const schema = `
        CREATE TABLE "user" (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL
        );

        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER,
          title TEXT NOT NULL,
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES "user"(id)
        );
      `;

      await schemaService.apply(schema, ["public"], true);

      const result = await client.query(`
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_name = 'posts' AND constraint_type = 'FOREIGN KEY'
      `);

      expect(result.rows.length).toBe(1);
    });
  });

  describe("Indexes on Reserved Word Tables", () => {
    test("should create indexes on reserved word table names", async () => {
      const schema = `
        CREATE TABLE "user" (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL
        );

        CREATE INDEX idx_user_email ON "user" (email);
      `;

      await schemaService.apply(schema, ["public"], true);

      const result = await client.query(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'user' AND indexname = 'idx_user_email'
      `);

      expect(result.rows.length).toBe(1);
    });
  });

  describe("ALTER TABLE on Reserved Word Tables", () => {
    test("should alter table with reserved word name", async () => {
      const initialSchema = `
        CREATE TABLE "user" (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL
        );
      `;

      await schemaService.apply(initialSchema, ["public"], true);

      const updatedSchema = `
        CREATE TABLE "user" (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT
        );
      `;

      await schemaService.apply(updatedSchema, ["public"], true);

      const result = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'user' AND column_name = 'email'
      `);

      expect(result.rows.length).toBe(1);
    });
  });
});
