import { describe, test, expect, beforeEach } from "bun:test";
import { SchemaParser } from "../../core/schema/parser";

describe("Procedure Parsing", () => {
  let parser: SchemaParser;

  beforeEach(() => {
    parser = new SchemaParser();
  });

  test("should parse CREATE PROCEDURE from CreateFunctionStmt with is_procedure", async () => {
    const sql = `
      CREATE PROCEDURE public.sync_user(IN p_id INT, INOUT p_name TEXT DEFAULT 'x')
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NULL;
      END;
      $$
      SECURITY DEFINER;
    `;

    const result = await parser.parseSchema(sql);

    expect(result.procedures).toHaveLength(1);
    expect(result.functions).toHaveLength(0);

    const proc = result.procedures[0];
    expect(proc.name).toBe("sync_user");
    expect(proc.schema).toBe("public");
    expect(proc.language).toBe("plpgsql");
    expect(proc.body).toContain("BEGIN");
    expect(proc.securityDefiner).toBe(true);

    expect(proc.parameters).toHaveLength(2);
    expect(proc.parameters[0]).toEqual({
      name: "p_id",
      type: "integer",
      mode: "IN",
    });
    expect(proc.parameters[1]?.name).toBe("p_name");
    expect(proc.parameters[1]?.type).toBe("text");
    expect(proc.parameters[1]?.mode).toBe("INOUT");
    expect(proc.parameters[1]?.default).toBe("'x'");
  });

  test("should keep CREATE FUNCTION in functions and CREATE PROCEDURE in procedures", async () => {
    const sql = `
      CREATE FUNCTION public.add_one(v INT)
      RETURNS INT
      LANGUAGE SQL
      AS $$ SELECT v + 1 $$;

      CREATE PROCEDURE public.reset_counter()
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NULL;
      END;
      $$;
    `;

    const result = await parser.parseSchema(sql);

    expect(result.functions).toHaveLength(1);
    expect(result.procedures).toHaveLength(1);
    expect(result.functions[0]?.name).toBe("add_one");
    expect(result.procedures[0]?.name).toBe("reset_counter");
  });
});
