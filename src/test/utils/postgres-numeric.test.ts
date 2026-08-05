import { describe, expect, test } from "bun:test";
import type {
  CompositeType,
  SqlObject,
  Table,
} from "../../types/schema";
import {
  type PostgresNumericModifierSchema,
  validatePostgresNumericModifiers,
} from "../../utils/postgres-numeric";

function makeSchema(
  tables: Table[] = [],
  compositeTypes: CompositeType[] = [],
  sqlObjects: SqlObject[] = []
): PostgresNumericModifierSchema {
  return { tables, compositeTypes, sqlObjects };
}

function makeTable(type: string): Table {
  return {
    name: "measurements",
    schema: "app",
    columns: [{ name: "value", type }],
  };
}

function makeComposite(type: string): CompositeType {
  return {
    name: "measurement_pair",
    schema: "app",
    attributes: [{ name: "value", type }],
  };
}

function makeDomain(type: string): SqlObject {
  return {
    kind: "domain-type",
    key: "domain-type:app.measurement",
    name: "measurement",
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
    key: "range-type:app.measurement_range",
    name: "measurement_range",
    schema: "app",
    createStatement: "",
    typeDefinition: { kind: "range", subtype: type },
  };
}

function makePartition(type: string): SqlObject {
  return {
    kind: "partition",
    key: "partition:app.measurement_partitions",
    name: "measurement_partitions",
    schema: "app",
    createStatement: "",
    partitionColumnTypes: { value: type },
  };
}

describe("PostgreSQL numeric modifier validation", function () {
  test("accepts portable and PostgreSQL 15 extended boundaries", function () {
    const portable = makeSchema([
      {
        name: "portable_values",
        columns: [
          { name: "minimum", type: "NUMERIC(1)" },
          { name: "maximum", type: "DECIMAL(1000,1000)" },
          { name: "unconstrained", type: "NUMERIC" },
          { name: "custom", type: "app.numeric(0)" },
        ],
      },
    ]);
    expect(function validatePortable() {
      validatePostgresNumericModifiers(portable, 140000);
    }).not.toThrow();

    const extended = makeSchema(
      [makeTable("NUMERIC(2,-1000)[]")],
      [makeComposite("DECIMAL(3,1000)")],
      [makeDomain("NUMERIC(4,-2)")]
    );
    expect(function validateExtended() {
      validatePostgresNumericModifiers(extended, 150000);
    }).not.toThrow();
  });

  test("rejects precision outside one through one thousand", function () {
    for (const precision of [0, 1001]) {
      expect(function validatePrecision() {
        validatePostgresNumericModifiers(
          makeSchema([makeTable(`NUMERIC(${precision})`)]),
          180000
        );
      }).toThrow(
        new RegExp(
          `column app\\.measurements\\.value has numeric precision ${precision}.*between 1 and 1000`,
          "i"
        )
      );
    }
  });

  test("rejects numeric modifier syntax that PostgreSQL cannot execute", function () {
    for (const type of [
      "NUMERIC(foo)",
      "NUMERIC(2,1,3)",
      "NUMERIC(+ 2,+ 1)",
    ]) {
      expect(function validateModifierSyntax() {
        validatePostgresNumericModifiers(
          makeSchema([makeTable(type)]),
          180000
        );
      }).toThrow(/invalid numeric modifier.*integer constants/i);
    }
  });

  test("rejects absolute scale limits across composite and domain types", function () {
    expect(function validateCompositeScale() {
      validatePostgresNumericModifiers(
        makeSchema([], [makeComposite("NUMERIC(2,-1001)")]),
        180000
      );
    }).toThrow(/composite attribute app\.measurement_pair\.value.*scale -1001/i);

    expect(function validateDomainScale() {
      validatePostgresNumericModifiers(
        makeSchema([], [], [makeDomain("DECIMAL(2,1001)")]),
        180000
      );
    }).toThrow(/domain app\.measurement.*scale 1001/i);

    expect(function validatePartitionScale() {
      validatePostgresNumericModifiers(
        makeSchema([], [], [makePartition("NUMERIC(2,-1001)")]),
        180000
      );
    }).toThrow(/partition column app\.measurement_partitions\.value.*scale -1001/i);
  });

  test("gates negative and above-precision scales by server version", function () {
    for (const type of ["NUMERIC(2,-3)", "NUMERIC(3,5)"]) {
      expect(function validatePostgres14() {
        validatePostgresNumericModifiers(
          makeSchema([makeTable(type)]),
          140000
        );
      }).toThrow(/PostgreSQL 14 requires numeric scale.*PostgreSQL 15/i);
    }

    expect(function validateUnknownVersion() {
      validatePostgresNumericModifiers(
        makeSchema([], [makeComposite("NUMERIC(3,5)")]),
        undefined
      );
    }).toThrow(/without the PostgreSQL server version/i);
  });

  test("rejects numeric range modifiers because the catalog drops them", function () {
    expect(function validateRangeModifier() {
      validatePostgresNumericModifiers(
        makeSchema([], [], [makeRange("NUMERIC(2,1)")]),
        180000
      );
    }).toThrow(/range subtype app\.measurement_range.*does not retain/i);

    expect(function validatePlainRange() {
      validatePostgresNumericModifiers(
        makeSchema([], [], [makeRange("NUMERIC")]),
        140000
      );
    }).not.toThrow();
  });
});
