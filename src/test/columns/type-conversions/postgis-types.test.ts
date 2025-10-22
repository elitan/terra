import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "pg";
import { createTestClient, cleanDatabase, getTableColumns } from "../../utils";
import {
  createColumnTestServices,
  executeColumnMigration,
  EnhancedAssertions,
} from "../column-test-utils";

describe("PostGIS Spatial Types", () => {
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

  describe("Geography Type Parsing", () => {
    test("should parse geography(point, 4326) without errors", async () => {
      const desiredSQL = `
        CREATE TABLE locations (
          id SERIAL PRIMARY KEY,
          location geography(point, 4326)
        );
      `;

      const { tables } = await services.parser.parseSchema(desiredSQL);
      expect(tables).toHaveLength(1);
      expect(tables[0]?.name).toBe("locations");
      expect(tables[0]?.columns).toHaveLength(2);

      const locationCol = tables[0]?.columns.find(c => c.name === "location");
      expect(locationCol).toBeDefined();
      expect(locationCol?.type).toBe("GEOGRAPHY(point,4326)");
    });

    test("should parse geography with different geometry types", async () => {
      const desiredSQL = `
        CREATE TABLE geo_types (
          id SERIAL PRIMARY KEY,
          pt geography(point, 4326),
          line geography(linestring, 4326),
          poly geography(polygon, 4326),
          multipt geography(multipoint, 4326)
        );
      `;

      const { tables } = await services.parser.parseSchema(desiredSQL);
      expect(tables).toHaveLength(1);

      const columns = tables[0]?.columns || [];
      expect(columns.find(c => c.name === "pt")?.type).toBe("GEOGRAPHY(point,4326)");
      expect(columns.find(c => c.name === "line")?.type).toBe("GEOGRAPHY(linestring,4326)");
      expect(columns.find(c => c.name === "poly")?.type).toBe("GEOGRAPHY(polygon,4326)");
      expect(columns.find(c => c.name === "multipt")?.type).toBe("GEOGRAPHY(multipoint,4326)");
    });

    test("should parse geography without SRID parameter", async () => {
      const desiredSQL = `
        CREATE TABLE simple_geo (
          id SERIAL PRIMARY KEY,
          location geography(point)
        );
      `;

      const { tables } = await services.parser.parseSchema(desiredSQL);
      expect(tables).toHaveLength(1);

      const locationCol = tables[0]?.columns.find(c => c.name === "location");
      expect(locationCol?.type).toBe("GEOGRAPHY(point)");
    });

    test("should parse geography without any parameters", async () => {
      const desiredSQL = `
        CREATE TABLE generic_geo (
          id SERIAL PRIMARY KEY,
          location geography
        );
      `;

      const { tables } = await services.parser.parseSchema(desiredSQL);
      expect(tables).toHaveLength(1);

      const locationCol = tables[0]?.columns.find(c => c.name === "location");
      expect(locationCol?.type).toBe("GEOGRAPHY");
    });
  });

  describe("Geometry Type Parsing", () => {
    test("should parse geometry(point, 4326) without errors", async () => {
      const desiredSQL = `
        CREATE TABLE geo_points (
          id SERIAL PRIMARY KEY,
          location geometry(point, 4326)
        );
      `;

      const { tables } = await services.parser.parseSchema(desiredSQL);
      expect(tables).toHaveLength(1);

      const locationCol = tables[0]?.columns.find(c => c.name === "location");
      expect(locationCol?.type).toBe("GEOMETRY(point,4326)");
    });

    test("should parse geometry with different SRIDs", async () => {
      const desiredSQL = `
        CREATE TABLE srid_test (
          id SERIAL PRIMARY KEY,
          wgs84 geometry(point, 4326),
          web_mercator geometry(point, 3857),
          utm geometry(point, 32633)
        );
      `;

      const { tables } = await services.parser.parseSchema(desiredSQL);
      expect(tables).toHaveLength(1);

      const columns = tables[0]?.columns || [];
      expect(columns.find(c => c.name === "wgs84")?.type).toBe("GEOMETRY(point,4326)");
      expect(columns.find(c => c.name === "web_mercator")?.type).toBe("GEOMETRY(point,3857)");
      expect(columns.find(c => c.name === "utm")?.type).toBe("GEOMETRY(point,32633)");
    });
  });

  describe("Case Insensitivity", () => {
    test("should handle mixed case geometry type names", async () => {
      const testCases = [
        { sql: "geography(Point, 4326)", expected: "GEOGRAPHY(point,4326)" },
        { sql: "geography(POINT, 4326)", expected: "GEOGRAPHY(point,4326)" },
        { sql: "geography(point, 4326)", expected: "GEOGRAPHY(point,4326)" },
        { sql: "GEOGRAPHY(point, 4326)", expected: "GEOGRAPHY(point,4326)" },
      ];

      for (const testCase of testCases) {
        const desiredSQL = `
          CREATE TABLE test_case (
            id SERIAL PRIMARY KEY,
            location ${testCase.sql}
          );
        `;

        const { tables } = await services.parser.parseSchema(desiredSQL);
        const locationCol = tables[0]?.columns.find(c => c.name === "location");
        expect(locationCol?.type).toBe(testCase.expected);
      }
    });
  });

  describe("Advanced Geometry Types", () => {
    test("should parse complex PostGIS geometry types", async () => {
      const desiredSQL = `
        CREATE TABLE complex_geo (
          id SERIAL PRIMARY KEY,
          collection geography(geometrycollection, 4326),
          circular geography(circularstring, 4326),
          compound geography(compoundcurve, 4326),
          curve_poly geography(curvepolygon, 4326)
        );
      `;

      const { tables } = await services.parser.parseSchema(desiredSQL);
      expect(tables).toHaveLength(1);

      const columns = tables[0]?.columns || [];
      expect(columns.find(c => c.name === "collection")?.type).toBe("GEOGRAPHY(geometrycollection,4326)");
      expect(columns.find(c => c.name === "circular")?.type).toBe("GEOGRAPHY(circularstring,4326)");
      expect(columns.find(c => c.name === "compound")?.type).toBe("GEOGRAPHY(compoundcurve,4326)");
      expect(columns.find(c => c.name === "curve_poly")?.type).toBe("GEOGRAPHY(curvepolygon,4326)");
    });

    test("should parse 3D geometry types", async () => {
      const desiredSQL = `
        CREATE TABLE geo_3d (
          id SERIAL PRIMARY KEY,
          tin geography(tin, 4326),
          triangle geography(triangle, 4326),
          polyhedral geography(polyhedralsurface, 4326)
        );
      `;

      const { tables } = await services.parser.parseSchema(desiredSQL);
      expect(tables).toHaveLength(1);

      const columns = tables[0]?.columns || [];
      expect(columns.find(c => c.name === "tin")?.type).toBe("GEOGRAPHY(tin,4326)");
      expect(columns.find(c => c.name === "triangle")?.type).toBe("GEOGRAPHY(triangle,4326)");
      expect(columns.find(c => c.name === "polyhedral")?.type).toBe("GEOGRAPHY(polyhedralsurface,4326)");
    });
  });

  describe("PostGIS Types with Constraints", () => {
    test("should parse geography columns with NOT NULL constraint", async () => {
      const desiredSQL = `
        CREATE TABLE constrained_geo (
          id SERIAL PRIMARY KEY,
          location geography(point, 4326) NOT NULL
        );
      `;

      const { tables } = await services.parser.parseSchema(desiredSQL);
      expect(tables).toHaveLength(1);

      const locationCol = tables[0]?.columns.find(c => c.name === "location");
      expect(locationCol?.type).toBe("GEOGRAPHY(point,4326)");
      expect(locationCol?.nullable).toBe(false);
    });

    test("should parse nullable geography columns", async () => {
      const desiredSQL = `
        CREATE TABLE nullable_geo (
          id SERIAL PRIMARY KEY,
          location geography(point, 4326)
        );
      `;

      const { tables } = await services.parser.parseSchema(desiredSQL);
      expect(tables).toHaveLength(1);

      const locationCol = tables[0]?.columns.find(c => c.name === "location");
      expect(locationCol?.nullable).toBe(true);
    });
  });
});
