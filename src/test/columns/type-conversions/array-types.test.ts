import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "../../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  EnhancedAssertions,
} from "../column-test-utils";

describe("Array Type Operations", () => {
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

  describe("Array Type Idempotency", () => {
    test("should not generate changes for text[] column", async () => {
      await client.query(`
        CREATE TABLE exercises (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          muscle_groups text[]
        );
      `);

      const desiredSQL = `
        CREATE TABLE exercises (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          muscle_groups text[]
        );
      `;

      const { parser, differ, inspector } = services;
      const currentSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.transactional).toHaveLength(0);
      expect(plan.concurrent).toHaveLength(0);
      expect(plan.deferred).toHaveLength(0);
    });

    test("should not generate changes for integer[] column", async () => {
      await client.query(`
        CREATE TABLE data (
          id serial PRIMARY KEY,
          values integer[]
        );
      `);

      const desiredSQL = `
        CREATE TABLE data (
          id serial PRIMARY KEY,
          values integer[]
        );
      `;

      const { parser, differ, inspector } = services;
      const currentSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.transactional).toHaveLength(0);
      expect(plan.concurrent).toHaveLength(0);
      expect(plan.deferred).toHaveLength(0);
    });

    test("should not generate changes for varchar[] column", async () => {
      await client.query(`
        CREATE TABLE tags (
          id serial PRIMARY KEY,
          names varchar(100)[]
        );
      `);

      const desiredSQL = `
        CREATE TABLE tags (
          id serial PRIMARY KEY,
          names varchar(100)[]
        );
      `;

      const { parser, differ, inspector } = services;
      const currentSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.transactional).toHaveLength(0);
      expect(plan.concurrent).toHaveLength(0);
      expect(plan.deferred).toHaveLength(0);
    });

    test("should not generate changes for boolean[] column", async () => {
      await client.query(`
        CREATE TABLE flags (
          id serial PRIMARY KEY,
          states boolean[]
        );
      `);

      const desiredSQL = `
        CREATE TABLE flags (
          id serial PRIMARY KEY,
          states boolean[]
        );
      `;

      const { parser, differ, inspector } = services;
      const currentSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.transactional).toHaveLength(0);
      expect(plan.concurrent).toHaveLength(0);
      expect(plan.deferred).toHaveLength(0);
    });
  });

  describe("Array Type Addition", () => {
    test("should add text[] column to existing table", async () => {
      await client.query(`
        CREATE TABLE exercises (
          id serial PRIMARY KEY
        );
      `);

      const desiredSQL = `
        CREATE TABLE exercises (
          id serial PRIMARY KEY,
          muscle_groups text[]
        );
      `;

      await executeColumnMigration(client, desiredSQL, services);

      const columns = await getTableColumns(client, "exercises");
      EnhancedAssertions.assertColumnType(
        columns,
        "muscle_groups",
        "text[]",
        "array column addition"
      );
    });

    test("should add integer[] column with default", async () => {
      await client.query(`
        CREATE TABLE scores (
          id serial PRIMARY KEY
        );
      `);

      const desiredSQL = `
        CREATE TABLE scores (
          id serial PRIMARY KEY,
          values integer[] DEFAULT '{}'
        );
      `;

      await executeColumnMigration(client, desiredSQL, services);

      const columns = await getTableColumns(client, "scores");
      EnhancedAssertions.assertColumnType(
        columns,
        "values",
        "integer[]",
        "array column with default"
      );
    });
  });

  describe("Multidimensional Arrays", () => {
    test("should not generate changes for 2D integer array", async () => {
      await client.query(`
        CREATE TABLE matrix (
          id serial PRIMARY KEY,
          data integer[][]
        );
      `);

      const desiredSQL = `
        CREATE TABLE matrix (
          id serial PRIMARY KEY,
          data integer[][]
        );
      `;

      const { parser, differ, inspector } = services;
      const currentSchema = await inspector.getCurrentSchema(client);
      const desiredTables = await parser.parseCreateTableStatements(desiredSQL);
      const plan = differ.generateMigrationPlan(desiredTables, currentSchema);

      expect(plan.transactional).toHaveLength(0);
      expect(plan.concurrent).toHaveLength(0);
      expect(plan.deferred).toHaveLength(0);
    });
  });
});
