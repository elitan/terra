import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { SchemaService } from "../../core/schema/service";
import { DatabaseInspector } from "../../core/schema/inspector";
import { PostgresProvider } from "../../providers/postgres";

const POSTGIS_CONFIG = {
  host: "localhost",
  port: 5489,
  database: "sql_terraform_test",
  user: "test_user",
  password: "test_password",
};

async function createPostgisClient(): Promise<Client> {
  const client = new Client(POSTGIS_CONFIG);
  await client.connect();
  return client;
}

function createPostgisSchemaService(): SchemaService {
  const provider = new PostgresProvider();
  return new SchemaService(provider, { dialect: "postgres", ...POSTGIS_CONFIG });
}

async function cleanDatabase(client: Client) {
  const tables = await client.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('spatial_ref_sys')
  `);

  for (const row of tables.rows) {
    await client.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
  }

  const types = await client.query(`
    SELECT t.typname
    FROM pg_type t
    JOIN pg_namespace n ON t.typnamespace = n.oid
    LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public'
      AND t.typtype = 'e'
      AND d.objid IS NULL
  `);

  for (const row of types.rows) {
    await client.query(`DROP TYPE IF EXISTS "${row.typname}" CASCADE`);
  }
}

describe("Extension Support - PostGIS", () => {
  let client: Client;
  let schemaService: SchemaService;
  let inspector: DatabaseInspector;

  beforeEach(async () => {
    client = await createPostgisClient();
    await cleanDatabase(client);
    schemaService = createPostgisSchemaService();
    inspector = new DatabaseInspector();
  });

  afterEach(async () => {
    await cleanDatabase(client);
    await client.end();
  });

  describe("Extension Object Filtering", () => {
    test("should not detect spatial_ref_sys as user table", async () => {
      await client.query(`CREATE EXTENSION IF NOT EXISTS postgis`);

      const spatialRefSys = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'spatial_ref_sys'
      `);
      expect(spatialRefSys.rows).toHaveLength(1);

      const tables = await inspector.getCurrentSchema(client, ['public']);

      const foundTable = tables.find(t => t.name === 'spatial_ref_sys');
      expect(foundTable).toBeUndefined();
    });

    test("should not try to drop spatial_ref_sys on schema apply", async () => {
      const initialSchema = `
        CREATE EXTENSION IF NOT EXISTS postgis;

        CREATE TABLE locations (
          id SERIAL PRIMARY KEY,
          name TEXT,
          point GEOMETRY(Point, 4326)
        );
      `;

      await schemaService.apply(initialSchema, ['public'], true);

      const tables1 = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'locations'
      `);
      expect(tables1.rows).toHaveLength(1);

      const schemaWithoutTable = `
        CREATE EXTENSION IF NOT EXISTS postgis;
      `;
      await schemaService.apply(schemaWithoutTable, ['public'], true);

      const tables2 = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'locations'
      `);
      expect(tables2.rows).toHaveLength(0);

      const spatialRefSys = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'spatial_ref_sys'
      `);
      expect(spatialRefSys.rows).toHaveLength(1);
    });

    test("should be idempotent with PostGIS extension", async () => {
      const schema = `
        CREATE EXTENSION IF NOT EXISTS postgis;

        CREATE TABLE locations (
          id SERIAL PRIMARY KEY,
          point GEOMETRY(Point, 4326)
        );
      `;

      await schemaService.apply(schema, ['public'], true);
      await schemaService.apply(schema, ['public'], true);
      await schemaService.apply(schema, ['public'], true);

      const spatialRefSys = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'spatial_ref_sys'
      `);
      expect(spatialRefSys.rows).toHaveLength(1);

      const locations = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'locations'
      `);
      expect(locations.rows).toHaveLength(1);
    });

    test("should not detect PostGIS views as user views", async () => {
      await client.query(`CREATE EXTENSION IF NOT EXISTS postgis`);

      const pgViews = await client.query(`
        SELECT table_name FROM information_schema.views
        WHERE table_schema = 'public'
          AND table_name IN ('geometry_columns', 'geography_columns')
      `);
      expect(pgViews.rows.length).toBeGreaterThan(0);

      const views = await inspector.getCurrentViews(client, ['public']);
      const postgisViews = views.filter(v =>
        v.name === 'geometry_columns' || v.name === 'geography_columns'
      );
      expect(postgisViews).toHaveLength(0);
    });
  });

  describe("PostGIS Type Support", () => {
    test("should allow using geometry types in schema", async () => {
      const schema = `
        CREATE EXTENSION IF NOT EXISTS postgis;

        CREATE TABLE geo_data (
          id SERIAL PRIMARY KEY,
          point GEOMETRY(Point, 4326),
          line GEOMETRY(LineString, 4326),
          poly GEOMETRY(Polygon, 4326)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      const result = await client.query(`
        SELECT column_name, udt_name
        FROM information_schema.columns
        WHERE table_name = 'geo_data'
        ORDER BY ordinal_position
      `);

      expect(result.rows).toHaveLength(4);
      expect(result.rows[1].column_name).toBe('point');
      expect(result.rows[1].udt_name).toBe('geometry');
    });

    test("should allow using geography types in schema", async () => {
      const schema = `
        CREATE EXTENSION IF NOT EXISTS postgis;

        CREATE TABLE locations (
          id SERIAL PRIMARY KEY,
          coords GEOGRAPHY(Point, 4326)
        );
      `;

      await schemaService.apply(schema, ['public'], true);

      const result = await client.query(`
        SELECT column_name, udt_name
        FROM information_schema.columns
        WHERE table_name = 'locations' AND column_name = 'coords'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].udt_name).toBe('geography');
    });
  });
});
