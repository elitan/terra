import { describe, test, expect } from "bun:test";
import { ExtensionHandler } from "../../core/schema/handlers/extension-handler";

describe("Regression: extension version drift generates migration", function () {
  test("generates ALTER EXTENSION UPDATE when desired version differs", function () {
    const handler = new ExtensionHandler();

    const result = handler.generateStatements(
      [{ name: "pgcrypto", version: "1.4" }],
      [{ name: "pgcrypto", version: "1.3" }]
    );

    expect(result.create).toEqual([
      "ALTER EXTENSION \"pgcrypto\" UPDATE TO '1.4';",
    ]);
    expect(result.drop).toEqual([]);
  });
});
