import { describe, expect, test } from "bun:test";
import { SchemaDiffer } from "../core/schema/differ";
import type { Column, PrimaryKeyConstraint, Table } from "../types/schema";

function makeColumn(overrides: Partial<Column> = {}): Column {
  return {
    name: "id",
    type: "INTEGER",
    nullable: false,
    ...overrides,
  };
}

function makeTable(overrides: Partial<Table> = {}): Table {
  return {
    name: "users",
    schema: "public",
    columns: [makeColumn()],
    ...overrides,
  };
}

function makePrimaryKey(columns: string[], name?: string): PrimaryKeyConstraint {
  return { columns, name };
}

describe("SchemaDiffer private coverage", () => {
  test("generateColumnStatements handles add modify and drop", () => {
    const differ = new SchemaDiffer();
    const desired = makeTable({
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "name", type: "INTEGER", nullable: false, default: "1" }),
        makeColumn({
          name: "created_at",
          type: "TIMESTAMP",
          nullable: false,
          default: "CURRENT_TIMESTAMP",
        }),
      ],
    });
    const current = makeTable({
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "name", type: "TEXT", nullable: true, default: "'old'" }),
        makeColumn({ name: "old_col", type: "TEXT", nullable: true }),
      ],
    });

    const statements = (differ as any).generateColumnStatements(desired, current) as string[];
    const sql = statements.join("\n");

    expect(sql).toContain("ADD COLUMN");
    expect(sql).toContain("\"created_at\"");
    expect(sql).toContain("DROP DEFAULT");
    expect(sql).toContain("TYPE INTEGER");
    expect(sql).toContain("TRUNC(\"name\"::DECIMAL)::integer");
    expect(sql).toContain("SET DEFAULT 1");
    expect(sql).toContain("SET NOT NULL");
    expect(sql).toContain("DROP COLUMN");
    expect(sql).toContain("\"old_col\"");
  });

  test("generateColumnModificationStatements handles generated columns", () => {
    const differ = new SchemaDiffer();
    const desired = makeColumn({
      name: "full_name",
      type: "TEXT",
      nullable: false,
      generated: {
        always: true,
        expression: "first_name || ' ' || last_name",
        stored: true,
      },
    });
    const current = makeColumn({
      name: "full_name",
      type: "TEXT",
      nullable: false,
    });

    const statements = (differ as any).generateColumnModificationStatements(
      "\"public\".\"users\"",
      desired,
      current
    ) as string[];

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("DROP COLUMN");
    expect(statements[1]).toContain("ADD COLUMN");
    expect(statements[1]).toContain("GENERATED ALWAYS AS");
    expect(statements[1]).toContain("STORED");
  });

  test("type conversion helpers cover serial and boolean branches", () => {
    const differ = new SchemaDiffer();

    const serialSQL = (differ as any).generateTypeConversionSQL(
      "\"public\".\"users\"",
      "order_id",
      "SERIAL",
      "TEXT"
    ) as string;
    expect(serialSQL).toContain("TYPE INTEGER");
    expect(serialSQL).toContain("USING TRUNC(\"order_id\"::DECIMAL)::integer");

    const boolSQL = (differ as any).generateTypeConversionSQL(
      "\"public\".\"users\"",
      "is_active",
      "BOOLEAN",
      "TEXT"
    ) as string;
    expect(boolSQL).toContain("TYPE BOOLEAN");
    expect(boolSQL).toContain("USING TRIM(\"is_active\")::boolean");

    expect((differ as any).requiresUsingClause("INTEGER", "BIGINT")).toBe(false);
    expect((differ as any).requiresUsingClause("TEXT", "INTEGER")).toBe(true);
  });

  test("primary key helpers cover add drop modify and none", () => {
    const differ = new SchemaDiffer();
    const add = (differ as any).comparePrimaryKeys(makePrimaryKey(["id"]), undefined);
    const drop = (differ as any).comparePrimaryKeys(undefined, makePrimaryKey(["id"], "users_pkey"));
    const modify = (differ as any).comparePrimaryKeys(
      makePrimaryKey(["id", "tenant_id"], "users_pkey"),
      makePrimaryKey(["id"], "users_pkey")
    );
    const none = (differ as any).comparePrimaryKeys(
      makePrimaryKey(["id"]),
      makePrimaryKey(["id"], "other_name")
    );

    expect(add.type).toBe("add");
    expect(drop.type).toBe("drop");
    expect(modify.type).toBe("modify");
    expect(none.type).toBe("none");

    const desired = makeTable({ primaryKey: makePrimaryKey(["id", "tenant_id"], "users_pkey") });
    const current = makeTable({ primaryKey: makePrimaryKey(["id"], "users_pkey") });

    const full = (differ as any).generatePrimaryKeyStatements(desired, current) as string[];
    expect(full).toHaveLength(2);
    expect(full[0]).toContain("DROP CONSTRAINT");
    expect(full[1]).toContain("ADD CONSTRAINT");

    const dropOnly = (differ as any).generatePrimaryKeyDropStatements(
      desired,
      current,
      "\"public\".\"users\""
    ) as string[];
    const addOnly = (differ as any).generatePrimaryKeyAddStatements(
      desired,
      current,
      "\"public\".\"users\""
    ) as string[];

    expect(dropOnly).toHaveLength(1);
    expect(addOnly).toHaveLength(1);
  });
});
