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

export async function cleanDatabase(client: Client | undefined, schemas: string[] = ['public']): Promise<void> {
  if (!client) {
    return;
  }

  for (const schema of schemas) {
    if (schema !== 'public') {
      await client.query(`DROP SCHEMA IF EXISTS ${client.escapeIdentifier(schema)} CASCADE`);
    } else {
      await client.query(`
        DO $$
        DECLARE
          r RECORD;
        BEGIN
          FOR r IN (
            SELECT quote_ident(matviewname) as quoted_name
            FROM pg_matviews
            WHERE schemaname = 'public'
          ) LOOP
            EXECUTE 'DROP MATERIALIZED VIEW IF EXISTS ' || r.quoted_name || ' CASCADE';
          END LOOP;

          FOR r IN (
            SELECT quote_ident(viewname) as quoted_name
            FROM pg_views
            WHERE schemaname = 'public'
          ) LOOP
            EXECUTE 'DROP VIEW IF EXISTS ' || r.quoted_name || ' CASCADE';
          END LOOP;

          FOR r IN (
            SELECT quote_ident(tablename) as quoted_tablename
            FROM pg_tables
            WHERE schemaname = 'public'
          ) LOOP
            EXECUTE 'DROP TABLE IF EXISTS ' || r.quoted_tablename || ' CASCADE';
          END LOOP;

          FOR r IN (
            SELECT quote_ident(sequence_name) as quoted_name
            FROM information_schema.sequences
            WHERE sequence_schema = 'public'
          ) LOOP
            EXECUTE 'DROP SEQUENCE IF EXISTS ' || r.quoted_name || ' CASCADE';
          END LOOP;

          FOR r IN (
            SELECT quote_ident(p.proname) as quoted_name,
                   pg_get_function_identity_arguments(p.oid) as args
            FROM pg_proc p
            JOIN pg_namespace n ON p.pronamespace = n.oid
            LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
            WHERE n.nspname = 'public'
              AND d.objid IS NULL
          ) LOOP
            EXECUTE 'DROP ROUTINE IF EXISTS ' || r.quoted_name || '(' || r.args || ') CASCADE';
          END LOOP;

          FOR r IN (
            SELECT quote_ident(typname) as quoted_typename
            FROM pg_type t
            LEFT JOIN pg_class c ON c.oid = t.typrelid
            LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
            WHERE (
                typtype = 'e'
                OR (
                typtype = 'c'
                AND c.relkind = 'c'
              ))
              AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
              AND d.objid IS NULL
          ) LOOP
            EXECUTE 'DROP TYPE IF EXISTS ' || r.quoted_typename || ' CASCADE';
          END LOOP;

          FOR r IN (
            SELECT quote_ident(typname) as quoted_typename
            FROM pg_type t
            LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
            WHERE typtype = 'd'
              AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
              AND d.objid IS NULL
          ) LOOP
            EXECUTE 'DROP DOMAIN IF EXISTS ' || r.quoted_typename || ' CASCADE';
          END LOOP;

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

export type PostgresTestHarness = {
  setup: (schemas?: string[]) => Promise<Client>;
  teardown: (schemas?: string[]) => Promise<void>;
  getClient: () => Client;
};

export function createPostgresTestHarness(): PostgresTestHarness {
  let client: Client | undefined;

  async function setup(schemas: string[] = ['public']): Promise<Client> {
    client = await createTestClient();
    await cleanDatabase(client, schemas);
    return client;
  }

  async function teardown(schemas: string[] = ['public']): Promise<void> {
    if (!client) {
      return;
    }

    try {
      await cleanDatabase(client, schemas);
    } finally {
      await client.end();
      client = undefined;
    }
  }

  function getClient(): Client {
    if (!client) {
      throw new Error("Test client is not initialized");
    }
    return client;
  }

  return { setup, teardown, getClient };
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

export interface PublicSchemaObjectSnapshot {
  tables: string[];
  views: string[];
  materializedViews: string[];
  sequences: string[];
  routines: string[];
  enums: string[];
  domains: string[];
}

export async function getPublicSchemaObjectSnapshot(
  client: Client
): Promise<PublicSchemaObjectSnapshot> {
  const [
    tableResult,
    viewResult,
    materializedViewResult,
    sequenceResult,
    routineResult,
    enumResult,
    domainResult,
  ] = await Promise.all([
    client.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `),
    client.query(`
      SELECT viewname
      FROM pg_views
      WHERE schemaname = 'public'
      ORDER BY viewname
    `),
    client.query(`
      SELECT matviewname
      FROM pg_matviews
      WHERE schemaname = 'public'
      ORDER BY matviewname
    `),
    client.query(`
      SELECT sequence_name
      FROM information_schema.sequences
      WHERE sequence_schema = 'public'
      ORDER BY sequence_name
    `),
    client.query(`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public'
      ORDER BY p.proname
    `),
    client.query(`
      SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE n.nspname = 'public'
        AND t.typtype = 'e'
      ORDER BY t.typname
    `),
    client.query(`
      SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE n.nspname = 'public'
        AND t.typtype = 'd'
      ORDER BY t.typname
    `),
  ]);

  return {
    tables: tableResult.rows.map((row) => row.tablename),
    views: viewResult.rows.map((row) => row.viewname),
    materializedViews: materializedViewResult.rows.map((row) => row.matviewname),
    sequences: sequenceResult.rows.map((row) => row.sequence_name),
    routines: routineResult.rows.map((row) => row.proname),
    enums: enumResult.rows.map((row) => row.typname),
    domains: domainResult.rows.map((row) => row.typname),
  };
}

export async function assertPublicSchemaClean(
  client: Client,
  allowlist: Partial<PublicSchemaObjectSnapshot> = {}
): Promise<void> {
  const snapshot = await getPublicSchemaObjectSnapshot(client);
  const leaked: string[] = [];
  for (const key of Object.keys(snapshot) as (keyof PublicSchemaObjectSnapshot)[]) {
    const allowedSet = new Set(allowlist[key] || []);
    const extras = snapshot[key].filter((name) => !allowedSet.has(name));
    if (extras.length > 0) {
      leaked.push(`${key}: ${extras.join(", ")}`);
    }
  }
  if (leaked.length > 0) {
    throw new Error(`public schema not clean: ${leaked.join(" | ")}`);
  }
}
