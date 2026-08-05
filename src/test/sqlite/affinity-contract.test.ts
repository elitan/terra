import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SchemaService } from "../../core/schema/service";
import { SQLiteProvider } from "../../providers/sqlite";
import type { SQLiteConnectionConfig } from "../../providers/types";

interface AffinityRow {
  charintType: string;
  floatingPointType: string;
  characterType: string;
  varcharType: string;
  varcharValue: string;
  clobType: string;
  blobType: string;
  typelessType: string;
  realType: string;
  floatType: string;
  doubleType: string;
  stringType: string;
  booleanType: string;
  decimalType: string;
  anyType: string;
  anyValue: string;
  markerType: string;
}

interface StrictRow {
  intType: string;
  intValue: string;
  integerType: string;
  integerValue: string;
  realType: string;
  realValue: string;
  textType: string;
  textValue: string;
  blobType: string;
  blobValue: string;
  anyType: string;
  anyValue: string;
  markerType: string;
}

function createDatabasePath(label: string): string {
  return path.join(
    os.tmpdir(),
    `terradb-affinity-${label}-${process.pid}-${Date.now()}.db`
  );
}

function removeDatabase(pathname: string): void {
  try {
    if (fs.existsSync(pathname)) {
      fs.unlinkSync(pathname);
    }
  } catch {
    // Best-effort cleanup for a test-only temporary database.
  }
}

async function readAffinityRows(
  client: Awaited<ReturnType<SQLiteProvider["createClient"]>>
): Promise<AffinityRow[]> {
  const result = await client.query<AffinityRow>(`
    SELECT
      typeof(charint_value) AS charintType,
      typeof(floating_point_value) AS floatingPointType,
      typeof(character_value) AS characterType,
      typeof(varchar_value) AS varcharType,
      quote(varchar_value) AS varcharValue,
      typeof(clob_value) AS clobType,
      typeof(blob_value) AS blobType,
      typeof(typeless_value) AS typelessType,
      typeof(real_value) AS realType,
      typeof(float_value) AS floatType,
      typeof(double_value) AS doubleType,
      typeof(string_value) AS stringType,
      typeof(boolean_value) AS booleanType,
      typeof(decimal_value) AS decimalType,
      typeof(any_value) AS anyType,
      quote(any_value) AS anyValue,
      typeof(marker) AS markerType
    FROM affinity_values
  `);
  return result.rows;
}

describe("SQLite declared type and affinity contract", function () {
  test("preserves the ordered ordinary affinity rules through recreation", async function () {
    const dbPath = createDatabasePath("ordinary");
    const config: SQLiteConnectionConfig = {
      dialect: "sqlite",
      filename: dbPath,
    };
    const provider = new SQLiteProvider();
    const service = new SchemaService(provider, config);
    const initialSchema = `
      CREATE TABLE affinity_values (
        id INTEGER PRIMARY KEY,
        charint_value CHARINT,
        floating_point_value FLOATING POINT,
        character_value CHARACTER(20),
        varchar_value VARCHAR(2),
        clob_value CLOB,
        blob_value BLOB,
        typeless_value,
        real_value REAL,
        float_value FLOAT,
        double_value DOUBLE PRECISION,
        string_value STRING,
        boolean_value BOOLEAN,
        decimal_value DECIMAL(10,5),
        any_value ANY,
        marker INTEGER
      );
    `;
    const recreatedSchema = initialSchema.replace(
      "marker INTEGER",
      "marker TEXT"
    );
    const resizedSchema = recreatedSchema.replace(
      "VARCHAR(2)",
      "VARCHAR(100)"
    );
    const client = await provider.createClient(config);

    try {
      await service.apply(initialSchema, ["public"], true);
      await client.query(`
        INSERT INTO affinity_values (
          charint_value,
          floating_point_value,
          character_value,
          varchar_value,
          clob_value,
          blob_value,
          typeless_value,
          real_value,
          float_value,
          double_value,
          string_value,
          boolean_value,
          decimal_value,
          any_value,
          marker
        ) VALUES (
          '500.0',
          '500.0',
          '500.0',
          'longer than two',
          '500.0',
          '500.0',
          '500.0',
          '500.0',
          '500.0',
          '500.0',
          '500.0',
          '500.0',
          '500.0',
          '000123',
          1
        )
      `);

      const expectedInitialRow: AffinityRow = {
        charintType: "integer",
        floatingPointType: "integer",
        characterType: "text",
        varcharType: "text",
        varcharValue: "'longer than two'",
        clobType: "text",
        blobType: "text",
        typelessType: "text",
        realType: "real",
        floatType: "real",
        doubleType: "real",
        stringType: "integer",
        booleanType: "integer",
        decimalType: "integer",
        anyType: "integer",
        anyValue: "123",
        markerType: "integer",
      };
      expect(await readAffinityRows(client)).toEqual([expectedInitialRow]);

      const recreation = await service.apply(
        recreatedSchema,
        ["public"],
        true
      );
      expect(recreation.transactional.some(function (statement) {
        return statement.includes("_affinity_values_new");
      })).toBe(true);
      expect(await readAffinityRows(client)).toEqual([{
        ...expectedInitialRow,
        markerType: "text",
      }]);

      const resizedPlan = await service.plan(resizedSchema);
      expect(resizedPlan.hasChanges).toBe(true);
      await service.apply(resizedSchema, ["public"], true);
      const tables = await provider.getCurrentSchema(client);
      const affinityTable = tables.find(function (table) {
        return table.name === "affinity_values";
      });
      expect(affinityTable?.columns.map(function (column) {
        return column.type;
      })).toEqual([
        "INTEGER",
        "CHARINT",
        "FLOATING POINT",
        "CHARACTER(20)",
        "VARCHAR(100)",
        "CLOB",
        "BLOB",
        "",
        "REAL",
        "FLOAT",
        "DOUBLE PRECISION",
        "STRING",
        "BOOLEAN",
        "DECIMAL(10,5)",
        "ANY",
        "TEXT",
      ]);
      const preserved = await client.query<{
        value: string;
        markerType: string;
      }>(`
        SELECT
          varchar_value AS value,
          typeof(marker) AS markerType
        FROM affinity_values
      `);
      expect(preserved.rows).toEqual([{
        value: "longer than two",
        markerType: "text",
      }]);
      expect((await service.plan(resizedSchema)).hasChanges).toBe(false);
    } finally {
      await client.end();
      removeDatabase(dbPath);
    }
  });

  test("enforces the STRICT type whitelist and storage rules before mutation", async function () {
    const dbPath = createDatabasePath("strict");
    const config: SQLiteConnectionConfig = {
      dialect: "sqlite",
      filename: dbPath,
    };
    const provider = new SQLiteProvider();
    const service = new SchemaService(provider, config);
    const initialSchema = `
      CREATE TABLE strict_values (
        id INTEGER PRIMARY KEY,
        int_value INT,
        integer_value INTEGER,
        real_value REAL,
        text_value TEXT,
        blob_value BLOB,
        any_value ANY,
        marker INT
      ) STRICT;
    `;
    const recreatedSchema = initialSchema.replace("marker INT", "marker TEXT");
    const invalidTypes = [
      "BIGINT",
      "VARCHAR(20)",
      "NUMERIC",
      "BOOLEAN",
      "DOUBLE PRECISION",
      "ANYTHING",
      "",
    ];
    const client = await provider.createClient(config);

    try {
      await service.apply(initialSchema, ["public"], true);
      await client.query(
        `INSERT INTO strict_values (
          int_value,
          integer_value,
          real_value,
          text_value,
          blob_value,
          any_value,
          marker
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["500", "500.0", "500", 500, Uint8Array.from([1, 2]), "000123", 1]
      );

      const recreation = await service.apply(
        recreatedSchema,
        ["public"],
        true
      );
      expect(recreation.transactional.some(function (statement) {
        return statement.includes("_strict_values_new");
      })).toBe(true);
      const rows = await client.query<StrictRow>(`
        SELECT
          typeof(int_value) AS intType,
          quote(int_value) AS intValue,
          typeof(integer_value) AS integerType,
          quote(integer_value) AS integerValue,
          typeof(real_value) AS realType,
          quote(real_value) AS realValue,
          typeof(text_value) AS textType,
          quote(text_value) AS textValue,
          typeof(blob_value) AS blobType,
          quote(blob_value) AS blobValue,
          typeof(any_value) AS anyType,
          quote(any_value) AS anyValue,
          typeof(marker) AS markerType
        FROM strict_values
      `);
      expect(rows.rows).toEqual([{
        intType: "integer",
        intValue: "500",
        integerType: "integer",
        integerValue: "500",
        realType: "real",
        realValue: "500.0",
        textType: "text",
        textValue: "'500.0'",
        blobType: "blob",
        blobValue: "X'0102'",
        anyType: "text",
        anyValue: "'000123'",
        markerType: "text",
      }]);

      for (const invalidType of invalidTypes) {
        const invalidColumn = invalidType
          ? `invalid_value ${invalidType}`
          : "invalid_value";
        const invalidSchema = `${recreatedSchema}\nCREATE TABLE invalid_type (${invalidColumn}) STRICT;`;
        await expect(
          service.apply(invalidSchema, ["public"], true)
        ).rejects.toThrow();

        const preserved = await client.query<{
          count: number;
          anyValue: string;
        }>(`
          SELECT
            COUNT(*) AS count,
            quote(any_value) AS anyValue
          FROM strict_values
        `);
        expect(preserved.rows).toEqual([{
          count: 1,
          anyValue: "'000123'",
        }]);
      }

      const tables = await provider.getCurrentSchema(client);
      expect(tables.some(function (table) {
        return table.name === "invalid_type";
      })).toBe(false);
      expect((await service.plan(recreatedSchema)).hasChanges).toBe(false);
    } finally {
      await client.end();
      removeDatabase(dbPath);
    }
  });
});
