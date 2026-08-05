import { describe, expect, test } from "bun:test";
import type {
  CompositeType,
  SqlObject,
  Table,
} from "../../types/schema";
import {
  type PostgresTemporalModifierSchema,
  validatePostgresTemporalModifiers,
} from "../../utils/postgres-temporal";

function makeSchema(
  tables: Table[] = [],
  compositeTypes: CompositeType[] = [],
  sqlObjects: SqlObject[] = []
): PostgresTemporalModifierSchema {
  return { tables, compositeTypes, sqlObjects };
}

function makeTable(type: string): Table {
  return {
    name: "events",
    schema: "app",
    columns: [{ name: "recorded_at", type }],
  };
}

function makeComposite(type: string): CompositeType {
  return {
    name: "event_window",
    schema: "app",
    attributes: [{ name: "duration", type }],
  };
}

function makeDomain(type: string): SqlObject {
  return {
    kind: "domain-type",
    key: "domain-type:app.duration",
    name: "duration",
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
    key: "range-type:app.event_range",
    name: "event_range",
    schema: "app",
    createStatement: "",
    typeDefinition: { kind: "range", subtype: type },
  };
}

function makePartition(type: string): SqlObject {
  return {
    kind: "partition",
    key: "partition:app.events_partitioned",
    name: "events_partitioned",
    schema: "app",
    createStatement: "",
    partitionColumnTypes: { recorded_at: type },
  };
}

describe("PostgreSQL temporal modifier validation", function () {
  test("accepts documented boundaries, aliases, fields, and arrays", function () {
    const schema = makeSchema(
      [{
        name: "events",
        columns: [
          { name: "time_min", type: "TIME(0)" },
          { name: "timetz_max", type: "TIMETZ(6)[]" },
          { name: "timestamp_min", type: "TIMESTAMP(0)" },
          { name: "timestamptz_max", type: "TIMESTAMPTZ(6)" },
          { name: "interval_min", type: "INTERVAL(0)" },
          { name: "interval_max", type: "INTERVAL DAY TO SECOND(6)" },
          { name: "interval_fields", type: "INTERVAL YEAR TO MONTH" },
          { name: "unconstrained", type: "TIMESTAMP" },
          { name: "custom", type: "app.timestamp(7)" },
        ],
      }],
      [makeComposite("INTERVAL SECOND(0)")],
      [makeDomain("TIME(6)"), makePartition("TIMESTAMP(0)")]
    );

    expect(function validateBoundaries() {
      validatePostgresTemporalModifiers(schema);
    }).not.toThrow();
  });

  test("rejects precision outside zero through six in every object family", function () {
    const invalidSchemas = [
      makeSchema([makeTable("TIME(7)")]),
      makeSchema([], [makeComposite("INTERVAL SECOND(7)")]),
      makeSchema([], [], [makeDomain("TIMESTAMP(-1)")]),
      makeSchema([], [], [makePartition("TIMESTAMPTZ(8)")]),
    ];

    for (const schema of invalidSchemas) {
      expect(function validatePrecision() {
        validatePostgresTemporalModifiers(schema);
      }).toThrow(/temporal precision.*between 0 and 6/i);
    }
  });

  test("rejects malformed modifiers and precision on fields without seconds", function () {
    for (const type of [
      "TIME(foo)",
      "TIMESTAMP(1,2)",
      "INTERVAL WEEKS",
      "INTERVAL DAY(3)",
      "INTERVAL HOUR TO MINUTE(2)",
    ]) {
      expect(function validateModifierSyntax() {
        validatePostgresTemporalModifiers(makeSchema([makeTable(type)]));
      }).toThrow(/(invalid temporal modifier|precision only when.*SECOND)/i);
    }
  });

  test("rejects temporal range modifiers because the catalog drops them", function () {
    for (const type of [
      "TIMESTAMP(3)",
      "INTERVAL(2)",
      "INTERVAL DAY TO SECOND",
    ]) {
      expect(function validateRangeModifier() {
        validatePostgresTemporalModifiers(
          makeSchema([], [], [makeRange(type)])
        );
      }).toThrow(/range subtype app\.event_range.*does not retain/i);
    }

    expect(function validatePlainRange() {
      validatePostgresTemporalModifiers(
        makeSchema([], [], [makeRange("TIMESTAMP")])
      );
    }).not.toThrow();
  });
});
