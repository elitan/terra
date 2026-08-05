import { describe, expect, test } from "bun:test";
import type {
  CompositeType,
  SqlObject,
  Table,
} from "../../types/schema";
import {
  type PostgresLengthModifierSchema,
  validatePostgresLengthModifiers,
} from "../../utils/postgres-length";

function makeSchema(
  tables: Table[] = [],
  compositeTypes: CompositeType[] = [],
  sqlObjects: SqlObject[] = []
): PostgresLengthModifierSchema {
  return { tables, compositeTypes, sqlObjects };
}

function makeTable(type: string): Table {
  return {
    name: "records",
    schema: "app",
    columns: [{ name: "value", type }],
  };
}

function makeComposite(type: string): CompositeType {
  return {
    name: "record_pair",
    schema: "app",
    attributes: [{ name: "value", type }],
  };
}

function makeDomain(type: string): SqlObject {
  return {
    kind: "domain-type",
    key: "domain-type:app.record_value",
    name: "record_value",
    schema: "app",
    createStatement: "",
    typeDefinition: {
      kind: "domain",
      baseType: type,
      notNull: false,
      constraints: [],
    },
  };
}

function makeRange(type: string): SqlObject {
  return {
    kind: "range-type",
    key: "range-type:app.record_range",
    name: "record_range",
    schema: "app",
    createStatement: "",
    typeDefinition: { kind: "range", subtype: type },
  };
}

function makePartition(type: string): SqlObject {
  return {
    kind: "partition",
    key: "partition:app.records_partitioned",
    name: "records_partitioned",
    schema: "app",
    createStatement: "",
    partitionColumnTypes: { value: type },
  };
}

describe("PostgreSQL length modifier validation", function () {
  test("accepts documented character and bit boundaries", function () {
    const schema = makeSchema(
      [makeTable("VARCHAR(1)")],
      [makeComposite("BPCHAR(10485760)[]")],
      [
        makeDomain("BIT(1)"),
        makePartition("VARBIT(83886080)"),
      ]
    );
    schema.tables[0]!.columns.push(
      { name: "character_max", type: "CHARACTER VARYING(10485760)" },
      { name: "bit_max", type: "BIT VARYING(83886080)" },
      { name: "unbounded", type: "BPCHAR" },
      { name: "custom", type: "app.varchar(0)" },
      { name: "internal", type: '"char"' }
    );

    expect(function validateBoundaries() {
      validatePostgresLengthModifiers(schema);
    }).not.toThrow();
  });

  test("rejects character lengths outside one through 10485760", function () {
    for (const type of [
      "VARCHAR(0)",
      "CHAR(10485761)",
      "BPCHAR(-1)",
    ]) {
      expect(function validateCharacterLength() {
        validatePostgresLengthModifiers(makeSchema([makeTable(type)]));
      }).toThrow(/length.*between 1 and 10485760/i);
    }
  });

  test("rejects bit lengths outside one through 83886080", function () {
    for (const type of [
      "BIT(0)",
      "VARBIT(83886081)",
      "BIT VARYING(-1)",
    ]) {
      expect(function validateBitLength() {
        validatePostgresLengthModifiers(makeSchema([makeTable(type)]));
      }).toThrow(/length.*between 1 and 83886080/i);
    }
  });

  test("rejects malformed length modifiers", function () {
    for (const type of [
      "BIT(foo)",
      "VARBIT(+ 1)",
      "BIT(1,2)",
      "VARCHAR(foo)",
    ]) {
      expect(function validateModifierSyntax() {
        validatePostgresLengthModifiers(makeSchema([makeTable(type)]));
      }).toThrow(/invalid length modifier.*single integer/i);
    }
  });

  test("rejects constrained range subtypes because the catalog drops lengths", function () {
    for (const type of [
      "VARCHAR(5)",
      "BPCHAR(1)",
      "BIT(5)",
      "VARBIT(5)",
    ]) {
      expect(function validateRangeModifier() {
        validatePostgresLengthModifiers(
          makeSchema([], [], [makeRange(type)])
        );
      }).toThrow(/range subtype app\.record_range.*does not retain/i);
    }

    for (const type of ["VARCHAR", "BPCHAR", "VARBIT", '"char"']) {
      expect(function validateUnconstrainedRange() {
        validatePostgresLengthModifiers(
          makeSchema([], [], [makeRange(type)])
        );
      }).not.toThrow();
    }
  });
});
