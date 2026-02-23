import { describe, test, expect } from "bun:test";
import { generateCreateSequenceSQL } from "../../utils/sql";

describe("Regression: sequence SQL generator quotes OWNED BY targets", function () {
  test("quotes identifiers in OWNED BY target", function () {
    const sql = generateCreateSequenceSQL({
      name: "Seq 1",
      schema: "public",
      ownedBy: "User Data.Order",
    });

    expect(sql).toContain('OWNED BY "User Data"."Order"');
  });
});
