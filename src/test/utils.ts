import { Client } from "pg";
import type { DatabaseConfig } from "../types/config";
import { DatabaseService } from "../core/database/client";
import type { PostgresConnectionConfig } from "../providers/types";
import { PostgresProvider } from "../providers/postgres";

function getTestDbConfig(): DatabaseConfig {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL environment variable is required for running tests. " +
      "Please set it to your PostgreSQL connection string, e.g.: " +
      "postgres://user:password@localhost:5432/database_name"
    );
  }

  const url = new URL(databaseUrl);

  return {
    host: url.hostname,
    port: parseInt(url.port) || 5432,
    database: url.pathname.slice(1),
    user: url.username,
    password: url.password,
  };
}

export function getTestConnectionConfig(): PostgresConnectionConfig {
  const config = getTestDbConfig();
  return {
    dialect: "postgres",
    ...config,
  };
}

export const TEST_DB_CONFIG = getTestDbConfig();

export { getTestDbConfig };

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

export function createTestProvider(): PostgresProvider {
  return new PostgresProvider();
}

export function createTestSchemaService() {
  const { SchemaService } = require("../core/schema/service");
  const provider = createTestProvider();
  const config = getTestConnectionConfig();
  return new SchemaService(provider, config);
}

export async function cleanDatabase(client: Client, schemas: string[] = ['public']): Promise<void> {
  for (const schema of schemas) {
    if (schema !== 'public') {
      await client.query(`DROP SCHEMA IF EXISTS ${client.escapeIdentifier(schema)} CASCADE`);
    } else {
      await client.query(`
        DO $$
        DECLARE
          r RECORD;
        BEGIN
          -- Drop all tables in the public schema
          FOR r IN (
            SELECT quote_ident(tablename) as quoted_tablename
            FROM pg_tables
            WHERE schemaname = 'public'
          ) LOOP
            EXECUTE 'DROP TABLE IF EXISTS ' || r.quoted_tablename || ' CASCADE';
          END LOOP;

          -- Drop all custom types (including ENUMs)
          FOR r IN (
            SELECT quote_ident(typname) as quoted_typename
            FROM pg_type
            WHERE typtype = 'e'
              AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
          ) LOOP
            EXECUTE 'DROP TYPE IF EXISTS ' || r.quoted_typename || ' CASCADE';
          END LOOP;

          -- Drop all extensions in the public schema (except built-in ones like plpgsql)
          FOR r IN (
            SELECT e.extname
            FROM pg_extension e
            JOIN pg_namespace n ON e.extnamespace = n.oid
            WHERE n.nspname = 'public'
              AND e.extname != 'plpgsql'
          ) LOOP
            EXECUTE 'DROP EXTENSION IF EXISTS ' || quote_ident(r.extname) || ' CASCADE';
          END LOOP;
        END $$;
      `);
    }
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
      a.attname as column_name,
      format_type(a.atttypid, a.atttypmod) as data_type,
      NOT a.attnotnull as is_nullable,
      pg_get_expr(ad.adbin, ad.adrelid) as column_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef ad ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = $1 AND n.nspname = 'public'
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `,
    [tableName]
  );

  return result.rows.map((row) => {
    let dataType = row.data_type;
    if (!dataType.endsWith('[]')) {
      dataType = dataType.replace(/\(\d+(?:,\d+)?\)$/, '');
    }
    return {
      name: row.column_name,
      type: dataType,
      nullable: row.is_nullable,
      default: row.column_default,
    };
  });
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
