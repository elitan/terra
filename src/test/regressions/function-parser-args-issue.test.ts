import { describe, test, expect, beforeEach } from "bun:test";
import { SchemaParser } from "../../core/schema/parser";

describe("Regression: function parser argument handling", () => {
  let parser: SchemaParser;

  beforeEach(() => {
    parser = new SchemaParser();
  });

  test("parses array parameter and array default without losing signature parts", async () => {
    const schema = `
      CREATE OR REPLACE FUNCTION fn_price(price numeric(10,2), tags text[] DEFAULT ARRAY['a','b'])
      RETURNS numeric(10,2)
      LANGUAGE plpgsql AS $$
      BEGIN
        RETURN price;
      END;
      $$;
    `;

    const parsed = await parser.parseSchema(schema);

    expect(parsed.functions).toHaveLength(1);
    expect(parsed.functions[0]?.parameters).toHaveLength(2);
    expect(parsed.functions[0]?.parameters[0]?.type).toBe("numeric");
    expect(parsed.functions[0]?.parameters[1]?.type).toBe("text[]");
    expect(parsed.functions[0]?.parameters[1]?.default).toContain("ARRAY");
    expect(parsed.functions[0]?.parameters[1]?.default).toContain("'a'");
    expect(parsed.functions[0]?.parameters[1]?.default).toContain("'b'");
    expect(parsed.functions[0]?.returnType).toBe("numeric");
  });
});
