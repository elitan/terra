import { beforeAll, describe, expect, test } from "bun:test";
import { loadModule } from "pgsql-parser";
import { SchemaDiffer } from "../core/schema/differ";
import type {
  Column,
  ExclusionConstraint,
  PrimaryKeyConstraint,
  Table,
} from "../types/schema";

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

function makeExclusion(
  overrides: Partial<ExclusionConstraint> = {}
): ExclusionConstraint {
  return {
    name: "users_no_overlap",
    method: "gist",
    elements: [{ definition: "during", operator: { name: "&&" } }],
    where: "id > 0",
    ...overrides,
  };
}

function reverseCopy<T>(items: T[]): T[] {
  return [...items].reverse();
}

describe("SchemaDiffer private coverage", () => {
  beforeAll(async function () {
    await loadModule();
  });

  test("checks constraint-backed index helper", () => {
    const differ = new SchemaDiffer();
    expect(
      (differ as any).isConstraintBackedIndex({
        name: "users_email_key",
        tableName: "users",
        columns: ["email"],
        type: "btree",
        constraint: "users_email_key",
      })
    ).toBe(true);
    expect(
      (differ as any).isConstraintBackedIndex({
        name: "idx_users_email",
        tableName: "users",
        columns: ["email"],
        type: "btree",
      })
    ).toBe(false);
  });

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
      makeTable(),
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

  test("type conversion helpers handle bigint and interval without integer fallback", () => {
    const differ = new SchemaDiffer();

    const bigintSQL = (differ as any).generateTypeConversionSQL(
      "\"public\".\"metrics\"",
      "counter",
      "BIGINT",
      "TEXT"
    ) as string;
    expect(bigintSQL).toContain("TYPE BIGINT");
    expect(bigintSQL).toContain("USING TRUNC(\"counter\"::DECIMAL)::bigint");
    expect(bigintSQL).not.toContain("::integer");

    expect((differ as any).requiresUsingClause("TEXT", "INTERVAL")).toBe(false);
    const intervalExpr = (differ as any).generateUsingExpression(
      "elapsed",
      "TEXT",
      "INTERVAL"
    ) as string;
    expect(intervalExpr).toBe("\"elapsed\"::INTERVAL");
  });

  test("type conversion helpers cover widen and narrow matrix decisions", () => {
    const differ = new SchemaDiffer();

    expect((differ as any).requiresUsingClause("INT4", "INT8")).toBe(false);
    expect((differ as any).requiresUsingClause("VARCHAR(100)", "TEXT")).toBe(false);
    expect((differ as any).requiresUsingClause("TEXT", "NUMERIC(12,2)")).toBe(true);
    expect((differ as any).requiresUsingClause("TEXT", "SMALLINT")).toBe(true);
    expect((differ as any).requiresUsingClause("TEXT", "BOOLEAN")).toBe(true);

    const textToSmallintExpr = (differ as any).generateUsingExpression(
      "score",
      "TEXT",
      "SMALLINT"
    ) as string;
    expect(textToSmallintExpr).toBe("TRUNC(\"score\"::DECIMAL)::smallint");

    const textToNumericExpr = (differ as any).generateUsingExpression(
      "amount",
      "TEXT",
      "NUMERIC(12,2)"
    ) as string;
    expect(textToNumericExpr).toBe("\"amount\"::NUMERIC(12,2)");
  });

  test("generateMigrationPlan treats equivalent default expressions as no-op", () => {
    const differ = new SchemaDiffer();
    const desired = [
      makeTable({
        columns: [
          makeColumn({ name: "id", type: "INTEGER", nullable: false }),
          makeColumn({
            name: "created_at",
            type: "TIMESTAMP",
            nullable: false,
            default: "CURRENT_TIMESTAMP",
          }),
        ],
      }),
    ];
    const current = [
      makeTable({
        columns: [
          makeColumn({ name: "id", type: "INT4", nullable: false }),
          makeColumn({
            name: "created_at",
            type: "timestamp without time zone",
            nullable: false,
            default: "now()",
          }),
        ],
      }),
    ];

    const plan = differ.generateMigrationPlan(desired, current);
    expect(plan.hasChanges).toBe(false);
    expect(plan.transactional).toHaveLength(0);
    expect(plan.concurrent).toHaveLength(0);
    expect(plan.deferred).toHaveLength(0);
  });

  test("generateMigrationPlan treats equivalent generated expressions as no-op", () => {
    const differ = new SchemaDiffer();
    const desired = [
      makeTable({
        columns: [
          makeColumn({ name: "id", type: "INTEGER", nullable: false }),
          makeColumn({ name: "first_name", type: "TEXT", nullable: true }),
          makeColumn({ name: "last_name", type: "TEXT", nullable: true }),
          makeColumn({
            name: "full_name",
            type: "TEXT",
            nullable: true,
            generated: {
              always: true,
              expression: "lower(first_name) || ' ' || lower(last_name)",
              stored: true,
            },
          }),
        ],
      }),
    ];
    const current = [
      makeTable({
        columns: [
          makeColumn({ name: "id", type: "INT4", nullable: false }),
          makeColumn({ name: "first_name", type: "TEXT", nullable: true }),
          makeColumn({ name: "last_name", type: "TEXT", nullable: true }),
          makeColumn({
            name: "full_name",
            type: "TEXT",
            nullable: true,
            generated: {
              always: true,
              expression: "lower(first_name) || ' '::text || lower(last_name)",
              stored: true,
            },
          }),
        ],
      }),
    ];

    const plan = differ.generateMigrationPlan(desired, current);
    expect(plan.hasChanges).toBe(false);
    expect(plan.transactional).toHaveLength(0);
    expect(plan.concurrent).toHaveLength(0);
    expect(plan.deferred).toHaveLength(0);
  });

  test("generateMigrationPlan preserves table persistence direction", function () {
    const differ = new SchemaDiffer();
    const logged = makeTable({ unlogged: undefined });
    const unlogged = makeTable({ unlogged: true });

    expect(
      differ.generateMigrationPlan([unlogged], [logged]).transactional.join("\n")
    ).toContain("SET UNLOGGED");
    expect(
      differ.generateMigrationPlan([logged], [unlogged]).transactional.join("\n")
    ).toContain("SET LOGGED");
  });

  test("generateMigrationPlan preserves table tablespace direction", function () {
    const differ = new SchemaDiffer();
    const defaultTable = makeTable();
    const customTable = makeTable({ tablespace: "Fast Space" });
    const explicitDefault = makeTable({ tablespace: "pg_default" });

    expect(
      differ
        .generateMigrationPlan([customTable], [defaultTable])
        .transactional.join("\n")
    ).toContain('SET TABLESPACE "Fast Space"');
    expect(
      differ
        .generateMigrationPlan([defaultTable], [customTable])
        .transactional.join("\n")
    ).toContain('SET TABLESPACE "pg_default"');
    expect(
      differ.generateMigrationPlan([explicitDefault], [defaultTable]).hasChanges
    ).toBe(false);
  });

  test("generateMigrationPlan handles versioned table access methods", function () {
    const differ = new SchemaDiffer();
    const heap = makeTable({ accessMethod: "heap" });
    const custom = makeTable({ accessMethod: "custom_heap" });
    const postgres15 = {
      postgresVersionNum: 150000,
      defaultTableAccessMethod: "heap",
    };

    expect(
      differ
        .generateMigrationPlan([custom], [heap], postgres15)
        .transactional.join("\n")
    ).toContain('SET ACCESS METHOD "custom_heap"');
    expect(
      differ
        .generateMigrationPlan([makeTable()], [heap], postgres15)
        .hasChanges
    ).toBe(false);
    expect(
      differ
        .generateMigrationPlan([makeTable()], [heap], {
          ...postgres15,
          defaultTableAccessMethod: "custom_heap",
        })
        .transactional.join("\n")
    ).toContain('SET ACCESS METHOD "custom_heap"');
    expect(function rejectPostgres14Change() {
      differ.generateMigrationPlan([custom], [heap], {
        postgresVersionNum: 140000,
        defaultTableAccessMethod: "heap",
      });
    }).toThrow("PostgreSQL 14 cannot change the access method");
    expect(function rejectUnknownVersionChange() {
      differ.generateMigrationPlan([custom], [heap]);
    }).toThrow("without the PostgreSQL server version");
  });

  test("generateMigrationPlan handles inheritance transitions", function () {
    const differ = new SchemaDiffer();
    const parent = { name: "parent", schema: "public" };
    const standalone = makeTable();
    const inherited = makeTable({ inherits: [parent] });

    expect(
      differ.generateMigrationPlan([inherited], [standalone]).transactional.join("\n")
    ).toContain('INHERIT "public"."parent"');
    expect(
      differ.generateMigrationPlan([standalone], [
        makeTable({
          inherits: [parent],
          inheritedColumns: [makeColumn({ name: "parent_id" })],
        }),
      ]).transactional.join("\n")
    ).toContain('NO INHERIT "public"."parent"');
    expect(function rejectParentReplacement() {
      differ.generateMigrationPlan(
        [makeTable({ inherits: [{ name: "new_parent", schema: "public" }] })],
        [inherited]
      );
    }).toThrow("separate detach and attach migrations");
  });

  test("generateMigrationPlan handles exclusion constraint equivalence and replacement", function () {
    const differ = new SchemaDiffer();
    const current = makeExclusion();
    const equivalentUnnamed = makeExclusion({
      name: undefined,
      elements: [
        {
          definition: "(during)",
          operator: { name: "&&", schema: "pg_catalog" },
        },
      ],
      where: "(id > 0)",
    });
    expect(
      differ.generateMigrationPlan(
        [makeTable({ exclusionConstraints: [equivalentUnnamed] })],
        [makeTable({ exclusionConstraints: [current] })]
      ).hasChanges
    ).toBe(false);

    const expressionCurrent = makeExclusion({
      elements: [
        {
          definition: "int4range(lower(during), upper(during))",
          operator: { name: "&&" },
        },
      ],
    });
    const expressionDesired = makeExclusion({
      elements: [
        {
          definition: "(int4range(lower(during), upper(during)))",
          operator: { name: "&&" },
        },
      ],
    });
    expect(
      differ.generateMigrationPlan(
        [makeTable({ exclusionConstraints: [expressionDesired] })],
        [makeTable({ exclusionConstraints: [expressionCurrent] })]
      ).hasChanges
    ).toBe(false);

    const unnamedAddSql = differ
      .generateMigrationPlan(
        [
          makeTable({
            exclusionConstraints: [
              makeExclusion({ name: undefined }),
              makeExclusion({
                name: undefined,
                elements: [
                  {
                    definition: "other_range",
                    operator: { name: "&&" },
                  },
                ],
              }),
            ],
          }),
        ],
        [makeTable()]
      )
      .transactional.join("\n");
    expect(unnamedAddSql).toContain("ADD EXCLUDE");

    const replacements: ExclusionConstraint[] = [
      makeExclusion({ method: "spgist" }),
      makeExclusion({
        elements: [
          { definition: "during", operator: { name: "&&" } },
          { definition: "other_range", operator: { name: "&&" } },
        ],
      }),
      makeExclusion({
        elements: [{ definition: "other_range", operator: { name: "&&" } }],
      }),
      makeExclusion({
        elements: [{ definition: "during", operator: { name: "-|-" } }],
      }),
      makeExclusion({
        elements: [
          {
            definition: "during",
            operator: { name: "&&", schema: "custom_ops" },
          },
        ],
      }),
      makeExclusion({ include: ["id"] }),
      makeExclusion({ storageParameters: { fillfactor: "80" } }),
      makeExclusion({ tablespace: "fast_indexes" }),
      makeExclusion({ deferrable: true }),
      makeExclusion({ deferrable: true, initiallyDeferred: true }),
      makeExclusion({ where: undefined }),
      makeExclusion({ where: "id >= 0" }),
    ];

    for (const replacement of replacements) {
      const sql = differ
        .generateMigrationPlan(
          [makeTable({ exclusionConstraints: [replacement] })],
          [makeTable({ exclusionConstraints: [current] })]
        )
        .transactional.join("\n");
      expect(sql).toContain('DROP CONSTRAINT "users_no_overlap"');
      expect(sql).toContain("ADD CONSTRAINT \"users_no_overlap\" EXCLUDE");
    }
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

  test("generateConstraintStatementsWithColumnContext covers check foreign key and unique branches", () => {
    const differ = new SchemaDiffer();
    const desired = makeTable({
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "email", type: "TEXT", nullable: false }),
      ],
      checkConstraints: [
        { name: "users_email_check", expression: "email <> ''" },
        { name: "users_id_check", expression: "id > 0" },
      ],
      foreignKeys: [
        {
          name: "fk_profile",
          columns: ["id"],
          referencedTable: "profiles",
          referencedColumns: ["id"],
          onDelete: "CASCADE",
        },
        {
          columns: ["email"],
          referencedTable: "contacts",
          referencedColumns: ["email"],
          onDelete: "SET NULL",
        },
        {
          name: "fk_new_named",
          columns: ["id"],
          referencedTable: "accounts",
          referencedColumns: ["id"],
        },
        {
          columns: ["id"],
          referencedTable: "teams",
          referencedColumns: ["id"],
        },
      ],
      uniqueConstraints: [{ name: "uq_email", columns: ["email"] }],
    });
    const current = makeTable({
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "old_email", type: "TEXT", nullable: true }),
      ],
      checkConstraints: [
        { name: "users_old_check", expression: "email <> ''" },
        { name: "users_age_check", expression: "age > 0" },
      ],
      foreignKeys: [
        {
          name: "fk_profile",
          columns: ["id"],
          referencedTable: "profiles",
          referencedColumns: ["id"],
          onDelete: "RESTRICT",
        },
        {
          name: "fk_email_old",
          columns: ["email"],
          referencedTable: "contacts",
          referencedColumns: ["email"],
          onDelete: "NO ACTION",
        },
        {
          name: "fk_old_email",
          columns: ["old_email"],
          referencedTable: "contacts",
          referencedColumns: ["email"],
        },
        {
          name: "fk_unused",
          columns: ["id"],
          referencedTable: "departments",
          referencedColumns: ["id"],
        },
      ],
      uniqueConstraints: [{ name: "uq_old_email", columns: ["old_email"] }],
    });

    const statements = (differ as any).generateConstraintStatementsWithColumnContext(
      desired,
      current,
      "\"public\".\"users\""
    ) as string[];

    const sql = statements.join("\n");
    expect(sql).toContain("DROP CONSTRAINT \"users_old_check\"");
    expect(sql).toContain("ADD CONSTRAINT \"users_email_check\" CHECK");
    expect(sql).toContain("ADD CONSTRAINT \"users_id_check\" CHECK");
    expect(sql).toContain("DROP CONSTRAINT \"users_age_check\"");
    expect(sql).toContain("DROP CONSTRAINT \"fk_profile\"");
    expect(sql).toContain("DROP CONSTRAINT \"fk_email_old\"");
    expect(sql).toContain("DROP CONSTRAINT \"fk_unused\"");
    expect(sql).not.toContain("DROP CONSTRAINT \"fk_old_email\"");
    expect(sql).toContain("ADD CONSTRAINT \"fk_profile\" FOREIGN KEY");
    expect(sql).toContain("ADD CONSTRAINT \"fk_new_named\" FOREIGN KEY");
    expect(sql).toContain("REFERENCES \"teams\" (\"id\")");
    expect(sql).toContain("DROP CONSTRAINT \"uq_old_email\"");
    expect(sql).toContain("ADD CONSTRAINT \"uq_email\" UNIQUE");
  });

  test("generateMigrationPlan keeps stable order for mixed object kinds", () => {
    const differ = new SchemaDiffer();

    const current = makeTable({
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "legacy", type: "TEXT", nullable: true }),
        makeColumn({ name: "account_id", type: "INTEGER", nullable: true }),
        makeColumn({ name: "status", type: "TEXT", nullable: true, default: "'new'" }),
      ],
      primaryKey: makePrimaryKey(["id"], "users_pkey"),
      checkConstraints: [
        { name: "users_status_check", expression: "status <> ''" },
        { name: "users_legacy_check", expression: "legacy <> ''" },
      ],
      foreignKeys: [
        {
          name: "fk_users_account",
          columns: ["account_id"],
          referencedTable: "accounts",
          referencedColumns: ["id"],
          onDelete: "SET NULL",
        },
        {
          name: "fk_users_legacy_owner",
          columns: ["legacy"],
          referencedTable: "owners",
          referencedColumns: ["code"],
        },
      ],
      uniqueConstraints: [
        { name: "uq_users_legacy", columns: ["legacy"] },
        { name: "uq_users_status_account", columns: ["status", "account_id"] },
      ],
      indexes: [
        {
          name: "idx_users_legacy",
          tableName: "users",
          schema: "public",
          columns: ["legacy"],
          type: "btree",
        },
        {
          name: "idx_users_status",
          tableName: "users",
          schema: "public",
          columns: ["status"],
          where: "status <> 'archived'",
          type: "btree",
        },
        {
          name: "idx_users_account",
          tableName: "users",
          schema: "public",
          columns: ["account_id"],
          type: "btree",
        },
      ],
    });

    const desired = makeTable({
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "account_id", type: "BIGINT", nullable: false }),
        makeColumn({ name: "status", type: "TEXT", nullable: false, default: "'active'" }),
        makeColumn({ name: "email", type: "TEXT", nullable: false }),
      ],
      primaryKey: makePrimaryKey(["id", "account_id"], "users_pkey"),
      checkConstraints: [
        {
          name: "users_status_check_v2",
          expression: "status IN ('active', 'paused')",
        },
      ],
      foreignKeys: [
        {
          name: "fk_users_account",
          columns: ["account_id"],
          referencedTable: "accounts",
          referencedColumns: ["id"],
          onDelete: "RESTRICT",
        },
        {
          name: "fk_users_manager",
          columns: ["id"],
          referencedTable: "managers",
          referencedColumns: ["user_id"],
        },
      ],
      uniqueConstraints: [{ name: "uq_users_email", columns: ["email"] }],
      indexes: [
        {
          name: "idx_users_status",
          tableName: "users",
          schema: "public",
          columns: ["status"],
          where: "status IN ('active', 'paused')",
          type: "btree",
        },
        {
          name: "idx_users_email",
          tableName: "users",
          schema: "public",
          columns: ["email"],
          type: "btree",
        },
      ],
    });

    const currentReordered = makeTable({
      ...current,
      checkConstraints: reverseCopy(current.checkConstraints || []),
      foreignKeys: reverseCopy(current.foreignKeys || []),
      uniqueConstraints: reverseCopy(current.uniqueConstraints || []),
      indexes: reverseCopy(current.indexes || []),
    });

    const desiredReordered = makeTable({
      ...desired,
      checkConstraints: reverseCopy(desired.checkConstraints || []),
      foreignKeys: reverseCopy(desired.foreignKeys || []),
      uniqueConstraints: reverseCopy(desired.uniqueConstraints || []),
      indexes: reverseCopy(desired.indexes || []),
    });

    const plan1 = differ.generateMigrationPlan([desired], [current]);
    const plan2 = differ.generateMigrationPlan([desiredReordered], [currentReordered]);

    expect(plan1.transactional).toEqual(plan2.transactional);
    expect(plan1.concurrent).toEqual(plan2.concurrent);
    expect(plan1.deferred).toEqual(plan2.deferred);
  });

  test("generateMigrationPlan keeps stable order for mixed multi-table operations", () => {
    const differ = new SchemaDiffer();

    const currentAccounts = makeTable({
      name: "accounts",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "legacy", type: "TEXT", nullable: true }),
      ],
      primaryKey: makePrimaryKey(["id"], "accounts_pkey"),
      indexes: [
        {
          name: "idx_accounts_legacy",
          tableName: "accounts",
          schema: "public",
          columns: ["legacy"],
          type: "btree",
        },
      ],
    });
    const currentUsers = makeTable({
      name: "users",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "account_id", type: "INTEGER", nullable: true }),
        makeColumn({ name: "status", type: "TEXT", nullable: true, default: "'new'" }),
        makeColumn({ name: "old_col", type: "TEXT", nullable: true }),
      ],
      primaryKey: makePrimaryKey(["id"], "users_pkey"),
      foreignKeys: [
        {
          name: "fk_users_account",
          columns: ["account_id"],
          referencedTable: "accounts",
          referencedColumns: ["id"],
          onDelete: "SET NULL",
        },
      ],
      uniqueConstraints: [{ name: "uq_users_old_col", columns: ["old_col"] }],
      indexes: [
        {
          name: "idx_users_status",
          tableName: "users",
          schema: "public",
          columns: ["status"],
          type: "btree",
        },
      ],
    });
    const currentAuditLogs = makeTable({
      name: "audit_logs",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "message", type: "TEXT", nullable: true }),
      ],
      primaryKey: makePrimaryKey(["id"], "audit_logs_pkey"),
    });

    const desiredAccounts = makeTable({
      name: "accounts",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "status", type: "TEXT", nullable: false, default: "'active'" }),
      ],
      primaryKey: makePrimaryKey(["id"], "accounts_pkey"),
      indexes: [
        {
          name: "idx_accounts_status",
          tableName: "accounts",
          schema: "public",
          columns: ["status"],
          type: "btree",
        },
      ],
    });
    const desiredUsers = makeTable({
      name: "users",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "account_id", type: "BIGINT", nullable: false }),
        makeColumn({ name: "status", type: "TEXT", nullable: false, default: "'active'" }),
        makeColumn({ name: "email", type: "TEXT", nullable: false }),
      ],
      primaryKey: makePrimaryKey(["id"], "users_pkey"),
      foreignKeys: [
        {
          name: "fk_users_account",
          columns: ["account_id"],
          referencedTable: "accounts",
          referencedColumns: ["id"],
          onDelete: "CASCADE",
        },
      ],
      uniqueConstraints: [{ name: "uq_users_email", columns: ["email"] }],
      indexes: [
        {
          name: "idx_users_email",
          tableName: "users",
          schema: "public",
          columns: ["email"],
          type: "btree",
        },
      ],
    });
    const desiredTeams = makeTable({
      name: "teams",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "name", type: "TEXT", nullable: false }),
      ],
      primaryKey: makePrimaryKey(["id"], "teams_pkey"),
      uniqueConstraints: [{ name: "uq_teams_name", columns: ["name"] }],
    });
    const desiredProfiles = makeTable({
      name: "profiles",
      schema: "public",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "user_id", type: "INTEGER", nullable: false }),
      ],
      primaryKey: makePrimaryKey(["id"], "profiles_pkey"),
      foreignKeys: [
        {
          name: "fk_profiles_user",
          columns: ["user_id"],
          referencedTable: "users",
          referencedColumns: ["id"],
          onDelete: "CASCADE",
        },
      ],
    });

    const current = [currentAuditLogs, currentUsers, currentAccounts];
    const desired = [desiredProfiles, desiredTeams, desiredUsers, desiredAccounts];

    const plan1 = differ.generateMigrationPlan(desired, current);
    const plan2 = differ.generateMigrationPlan(reverseCopy(desired), reverseCopy(current));

    expect(plan1.transactional).toEqual(plan2.transactional);
    expect(plan1.concurrent).toEqual(plan2.concurrent);
    expect(plan1.deferred).toEqual(plan2.deferred);
  });

  test("generateMigrationPlan handles same table name across schemas without collisions", () => {
    const differ = new SchemaDiffer();

    const currentPublic = makeTable({
      name: "users",
      schema: "public",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });
    const currentTenant = makeTable({
      name: "users",
      schema: "tenant_a",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });

    const desiredPublic = makeTable({
      name: "users",
      schema: "public",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });
    const desiredTenant = makeTable({
      name: "users",
      schema: "tenant_a",
      columns: [
        makeColumn({ name: "id", type: "INTEGER", nullable: false }),
        makeColumn({ name: "email", type: "TEXT", nullable: true }),
      ],
    });

    const plan = differ.generateMigrationPlan(
      [desiredPublic, desiredTenant],
      [currentPublic, currentTenant]
    );

    const sql = plan.transactional.join("\n");
    expect(sql).toContain('ALTER TABLE "tenant_a"."users"');
    expect(sql).toContain('ADD COLUMN "email" TEXT');
    expect(sql).not.toContain('ALTER TABLE "public"."users"');
  });

  test("generateMigrationPlan drops only removed schema table when names match", () => {
    const differ = new SchemaDiffer();

    const currentPublic = makeTable({
      name: "users",
      schema: "public",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });
    const currentTenant = makeTable({
      name: "users",
      schema: "tenant_a",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });

    const desiredPublic = makeTable({
      name: "users",
      schema: "public",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });

    const plan = differ.generateMigrationPlan([desiredPublic], [currentPublic, currentTenant]);
    const sql = plan.transactional.join("\n");

    expect(sql).toContain('DROP TABLE "tenant_a"."users" CASCADE;');
    expect(sql).not.toContain('DROP TABLE "public"."users" CASCADE;');
  });

  test("generateMigrationPlan drops all removed same-name tables across schemas", () => {
    const differ = new SchemaDiffer();

    const currentPublic = makeTable({
      name: "users",
      schema: "public",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });
    const currentTenant = makeTable({
      name: "users",
      schema: "tenant_a",
      columns: [makeColumn({ name: "id", type: "INTEGER", nullable: false })],
    });

    const plan = differ.generateMigrationPlan([], [currentPublic, currentTenant]);
    const sql = plan.transactional.join("\n");

    expect(sql).toContain('DROP TABLE "public"."users" CASCADE;');
    expect(sql).toContain('DROP TABLE "tenant_a"."users" CASCADE;');
  });
});
