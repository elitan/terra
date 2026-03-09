import { describe, test, expect } from "bun:test";
import { ExtensionHandler } from "../../core/schema/handlers/extension-handler";

describe("Regression: extension schema drift generates migration", function () {
  test("generates ALTER EXTENSION SET SCHEMA when desired schema differs", function () {
    const handler = new ExtensionHandler();

    const result = handler.generateStatements(
      [{ name: "pgcrypto", schema: "extensions" }],
      [{ name: "pgcrypto", schema: "public" }]
    );

    expect(result.create).toEqual([
      "ALTER EXTENSION \"pgcrypto\" SET SCHEMA \"extensions\";",
    ]);
    expect(result.drop).toEqual([]);
  });
});
