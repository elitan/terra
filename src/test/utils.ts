import { Client } from "pg";
import type { DatabaseConfig } from "../types/config";
import { DatabaseService } from "../core/database/client";

// Legacy config kept for reference only - DO NOT EXPORT
const LEGACY_TEST_DB_CONFIG: DatabaseConfig = {
  host: "localhost",
  port: 5487,
  database: "sql_terraform_test",
  user: "test_user",
  password: "test_password",
};

function getTestDbConfig(): DatabaseConfig {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL environment variable is required for running tests. " +
      "Please set it to your PostgreSQL connection string, e.g.: " +
      "postgres://user:password@localhost:5432/database_name"
    );
  }

  // Parse DATABASE_URL
  const url = new URL(databaseUrl);
  const baseDatabase = url.pathname.slice(1); // Remove leading slash

  // Generate unique database name per test file for parallel execution
  // Use the test file path as a seed for consistent DB names across runs
  const testFilePath = Bun.main || 'default';
  const hash = Bun.hash(testFilePath).toString(36).slice(0, 8);
  const uniqueDatabase = `${baseDatabase}_${hash}`;

  return {
    host: url.hostname,
    port: parseInt(url.port) || 5432,
    database: uniqueDatabase,
    user: url.username,
    password: url.password,
  };
}

// Export for compatibility with existing tests (like enum-types.test.ts from main branch)
// Note: This will return the same config for the current test file
export const TEST_DB_CONFIG = getTestDbConfig();

// Export factory function for when you need the config
export { getTestDbConfig };

async function ensureTestDatabase(config: DatabaseConfig): Promise<void> {
  // Connect to postgres database to create test database if needed
  const adminClient = new Client({
    ...config,
    database: 'postgres',
  });

  try {
    await adminClient.connect();

    // Check if database exists
    const result = await adminClient.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [config.database]
    );

    if (result.rows.length === 0) {
      // Database doesn't exist, create it
      await adminClient.query(`CREATE DATABASE ${adminClient.escapeIdentifier(config.database)}`);
    }
  } finally {
    await adminClient.end();
  }
}

export async function createTestClient(): Promise<Client> {
  const config = getTestDbConfig();
  await ensureTestDatabase(config);
  const client = new Client(config);
  await client.connect();
  return client;
}

export function createTestDatabaseService(): DatabaseService {
  const config = getTestDbConfig();
  return new DatabaseService(config);
}

export async function cleanDatabase(client: Client): Promise<void> {
  // Drop all tables in the public schema
  const result = await client.query(`
    SELECT
      schemaname,
      tablename,
      quote_ident(tablename) as quoted_tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  `);

  for (const row of result.rows) {
    // Use quote_ident to properly handle case-sensitive table names
    await client.query(`DROP TABLE IF EXISTS ${row.quoted_tablename} CASCADE`);
  }

  // Drop all custom types (including ENUMs)
  const typeResult = await client.query(`
    SELECT typname
    FROM pg_type
    WHERE typtype = 'e'
      AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  `);

  for (const row of typeResult.rows) {
    await client.query(`DROP TYPE IF EXISTS ${row.typname} CASCADE`);
  }

  // Drop all extensions in the public schema (except built-in ones like plpgsql)
  const extResult = await client.query(`
    SELECT e.extname
    FROM pg_extension e
    JOIN pg_namespace n ON e.extnamespace = n.oid
    WHERE n.nspname = 'public'
      AND e.extname != 'plpgsql'
  `);

  for (const row of extResult.rows) {
    // Use quote_ident to properly handle extension names with special characters (like uuid-ossp)
    await client.query(`DROP EXTENSION IF EXISTS ${client.escapeIdentifier(row.extname)} CASCADE`);
  }
}

export async function getTableNames(client: Client): Promise<string[]> {
  const result = await client.query(`
    SELECT tablename 
    FROM pg_tables 
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  return result.rows.map((row) => row.tablename);
}

export async function getTableColumns(client: Client, tableName: string) {
  const result = await client.query(
    `
    SELECT 
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns 
    WHERE table_name = $1 AND table_schema = 'public'
    ORDER BY ordinal_position
  `,
    [tableName]
  );

  return result.rows.map((row) => ({
    name: row.column_name,
    type: row.data_type,
    nullable: row.is_nullable === "YES",
    default: row.column_default,
  }));
}

export function waitForDb(timeoutMs: number = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const tryConnect = async () => {
      try {
        const client = await createTestClient();
        await client.end();
        resolve();
      } catch (error) {
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error("Database connection timeout"));
        } else {
          setTimeout(tryConnect, 500);
        }
      }
    };

    tryConnect();
  });
}
