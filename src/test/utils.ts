import { Client } from "pg";
import type { DatabaseConfig } from "../types/config";
import { DatabaseService } from "../core/database/client";

export const TEST_DB_CONFIG: DatabaseConfig = {
  host: "localhost",
  port: 5487,
  database: "sql_terraform_test",
  user: "test_user",
  password: "test_password",
};

function getTestDbConfig(): DatabaseConfig {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (databaseUrl) {
    // Parse DATABASE_URL if provided
    const url = new URL(databaseUrl);
    return {
      host: url.hostname,
      port: parseInt(url.port) || 5432,
      database: url.pathname.slice(1), // Remove leading slash
      user: url.username,
      password: url.password,
    };
  }
  
  // Fall back to default config
  return TEST_DB_CONFIG;
}

export async function createTestClient(): Promise<Client> {
  const config = getTestDbConfig();
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
