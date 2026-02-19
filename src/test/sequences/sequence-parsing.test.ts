import { describe, test, expect, beforeEach } from "bun:test";
import { SchemaParser } from "../../core/schema/parser";

describe("Sequence Parsing", () => {
  let parser: SchemaParser;

  beforeEach(() => {
    parser = new SchemaParser();
  });

  test("should parse CREATE SEQUENCE options", async () => {
    const sql = `
      CREATE SEQUENCE public.order_seq
      AS BIGINT
      INCREMENT BY 5
      MINVALUE 10
      MAXVALUE 1000
      START WITH 25
      CACHE 20
      CYCLE
      OWNED BY public.orders.id;
    `;

    const result = await parser.parseSchema(sql);

    expect(result.sequences).toHaveLength(1);

    const seq = result.sequences[0];
    expect(seq.name).toBe("order_seq");
    expect(seq.schema).toBe("public");
    expect(seq.dataType).toBe("BIGINT");
    expect(seq.increment).toBe(5);
    expect(seq.minValue).toBe(10);
    expect(seq.maxValue).toBe(1000);
    expect(seq.start).toBe(25);
    expect(seq.cache).toBe(20);
    expect(seq.cycle).toBe(true);
    expect(seq.ownedBy).toBe("public.orders.id");
  });

  test("should parse NO CYCLE and OWNED BY NONE", async () => {
    const sql = `
      CREATE SEQUENCE user_id_seq
      NO CYCLE
      OWNED BY NONE;
    `;

    const result = await parser.parseSchema(sql);

    expect(result.sequences).toHaveLength(1);

    const seq = result.sequences[0];
    expect(seq.name).toBe("user_id_seq");
    expect(seq.cycle).toBe(false);
    expect(seq.ownedBy).toBeUndefined();
  });
});
