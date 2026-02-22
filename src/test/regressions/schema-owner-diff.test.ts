import { describe, test, expect } from "bun:test";
import { SchemaHandler } from "../../core/schema/handlers/schema-handler";

describe("Regression: schema owner drift generates migration", function () {
  test("generates ALTER SCHEMA OWNER TO when desired owner differs", function () {
    const handler = new SchemaHandler();

    const statements = handler.generateStatements(
      [{ name: "analytics", owner: "reporter" }],
      [{ name: "analytics", owner: "postgres" }]
    );

    expect(statements).toEqual([
      'ALTER SCHEMA "analytics" OWNER TO "reporter";',
    ]);
  });
});
