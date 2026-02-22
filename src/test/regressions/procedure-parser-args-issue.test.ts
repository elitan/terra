import { describe, test, expect, beforeEach } from "bun:test";
import { SchemaParser } from "../../core/schema/parser";

describe("Regression: procedure parser argument handling", () => {
  let parser: SchemaParser;

  beforeEach(() => {
    parser = new SchemaParser();
  });

  test("parses array and catalog-qualified builtin types consistently", async () => {
    const schema = `
      CREATE OR REPLACE PROCEDURE sync_tags(IN p_tags text[], IN p_price numeric(10,2))
      LANGUAGE plpgsql AS $$
      BEGIN
        NULL;
      END;
      $$;
    `;

    const parsed = await parser.parseSchema(schema);

    expect(parsed.procedures).toHaveLength(1);
    expect(parsed.procedures[0]?.parameters).toHaveLength(2);
    expect(parsed.procedures[0]?.parameters[0]?.type).toBe("text[]");
    expect(parsed.procedures[0]?.parameters[1]?.type).toBe("numeric");
  });
});
