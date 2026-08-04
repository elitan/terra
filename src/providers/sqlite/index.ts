import type {
  DatabaseProvider,
  DatabaseClient,
  ConnectionConfig,
  SQLiteConnectionConfig,
  ParsedSchema,
  DatabaseFeature,
  ValidationResult,
  ValidationError,
} from "../types";
import type {
  Table,
  EnumType,
  CompositeType,
  View,
  Function,
  Procedure,
  Trigger,
  Sequence,
  Extension,
  SchemaDefinition,
  Comment,
  Index,
} from "../../types/schema";
import type { MigrationPlan } from "../../types/migration";
import { SQLiteClient } from "./client";
import { SQLiteInspector } from "./inspector";
import { SQLiteParser } from "./parser";
import { SQLiteDiffer } from "./differ";
import { MigrationError } from "../../types/errors";
import { Logger } from "../../utils/logger";
import { normalizeSQLiteIdentifier } from "../../utils/sqlite-identifier";
import { extractSQLiteForeignKeyMatchClauses } from "./sql-parser-utils";

const UNSUPPORTED_FEATURES: DatabaseFeature[] = [
  "schemas",
  "sequences",
  "enums",
  "composite_types",
  "extensions",
  "concurrent_indexes",
  "advisory_locks",
  "stored_functions",
  "stored_procedures",
  "materialized_views",
  "index_types",
];

type SQLiteParentKeyStatus = "valid" | "not_unique" | "collation_mismatch";

function sqliteColumnSetsEqual(first: string[], second: string[]): boolean {
  if (first.length !== second.length) {
    return false;
  }
  const normalizedFirst = first.map(normalizeSQLiteIdentifier).sort();
  const normalizedSecond = second.map(normalizeSQLiteIdentifier).sort();
  return normalizedFirst.every(function (column, index) {
    return column === normalizedSecond[index];
  });
}

function sqliteKeyCollationsMatch(
  table: Table,
  columns: string[],
  collations?: Array<string | undefined>
): boolean {
  if (!collations) {
    return true;
  }

  return columns.every(function (columnName, index) {
    const normalizedColumn = normalizeSQLiteIdentifier(columnName);
    const column = table.columns.find(function (candidate) {
      return normalizeSQLiteIdentifier(candidate.name) === normalizedColumn;
    });
    const declaredCollation = column?.collation?.name || "BINARY";
    const keyCollation = collations[index] || "BINARY";
    return normalizeSQLiteIdentifier(declaredCollation) ===
      normalizeSQLiteIdentifier(keyCollation);
  });
}

function getSQLiteIndexParentKey(
  index: Index
): { columns: string[]; collations?: Array<string | undefined> } | undefined {
  if (!index.unique || index.where) {
    return undefined;
  }
  if (!index.terms) {
    return { columns: index.columns };
  }
  if (index.terms.some(function (term) {
    return term.column === undefined || term.expression !== undefined;
  })) {
    return undefined;
  }
  return {
    columns: index.terms.map(function (term) {
      return term.column as string;
    }),
    collations: index.terms.map(function (term) {
      return typeof term.collation === "string"
        ? term.collation
        : term.collation?.name;
    }),
  };
}

function getSQLiteParentKeyStatus(
  table: Table,
  referencedColumns: string[]
): SQLiteParentKeyStatus {
  if (
    table.primaryKey &&
    sqliteColumnSetsEqual(table.primaryKey.columns, referencedColumns)
  ) {
    return "valid";
  }

  let collationMismatch = false;
  for (const constraint of table.uniqueConstraints || []) {
    if (!sqliteColumnSetsEqual(constraint.columns, referencedColumns)) {
      continue;
    }
    if (sqliteKeyCollationsMatch(table, constraint.columns, constraint.collations)) {
      return "valid";
    }
    collationMismatch = true;
  }

  for (const index of table.indexes || []) {
    const key = getSQLiteIndexParentKey(index);
    if (!key || !sqliteColumnSetsEqual(key.columns, referencedColumns)) {
      continue;
    }
    if (sqliteKeyCollationsMatch(table, key.columns, key.collations)) {
      return "valid";
    }
    collationMismatch = true;
  }

  return collationMismatch ? "collation_mismatch" : "not_unique";
}

export class SQLiteProvider implements DatabaseProvider {
  readonly dialect = "sqlite" as const;

  private parser: SQLiteParser;
  private inspector: SQLiteInspector;
  private differ: SQLiteDiffer;

  constructor() {
    this.parser = new SQLiteParser();
    this.inspector = new SQLiteInspector();
    this.differ = new SQLiteDiffer();
  }

  async createClient(config: ConnectionConfig): Promise<DatabaseClient> {
    if (config.dialect !== "sqlite") {
      throw new Error("SQLiteProvider requires sqlite config");
    }
    return SQLiteClient.create(config as SQLiteConnectionConfig);
  }

  async parseSchema(sql: string, filePath?: string): Promise<ParsedSchema> {
    return this.parser.parseSchema(sql, filePath);
  }

  async getCurrentSchema(
    client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Table[]> {
    return this.inspector.getCurrentSchema(client as SQLiteClient);
  }

  async getCurrentEnums(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<EnumType[]> {
    return [];
  }

  async getCurrentCompositeTypes(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<CompositeType[]> {
    return [];
  }

  async getCurrentViews(
    client: DatabaseClient,
    _schemas?: string[]
  ): Promise<View[]> {
    return this.inspector.getCurrentViews(client as SQLiteClient);
  }

  async getCurrentFunctions(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Function[]> {
    return [];
  }

  async getCurrentProcedures(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Procedure[]> {
    return [];
  }

  async getCurrentTriggers(
    client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Trigger[]> {
    return this.inspector.getCurrentTriggers(client as SQLiteClient);
  }

  async getCurrentSequences(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Sequence[]> {
    return [];
  }

  async getCurrentExtensions(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Extension[]> {
    return [];
  }

  async getCurrentSchemas(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<SchemaDefinition[]> {
    return [];
  }

  async getCurrentComments(
    _client: DatabaseClient,
    _schemas?: string[]
  ): Promise<Comment[]> {
    return [];
  }

  generateMigrationPlan(desired: Table[], current: Table[]): MigrationPlan {
    return this.differ.generateMigrationPlan(desired, current);
  }

  supportsFeature(feature: DatabaseFeature): boolean {
    return !UNSUPPORTED_FEATURES.includes(feature);
  }

  validateSchema(schema: ParsedSchema): ValidationResult {
    const errors: ValidationError[] = [];
    const tablesByName = new Map(
      schema.tables.map(function (table) {
        return [normalizeSQLiteIdentifier(table.name), table] as const;
      })
    );

    if (schema.schemas && schema.schemas.length > 0) {
      errors.push({
        code: "SQLITE_NO_SCHEMAS",
        message: "SQLite does not support schemas",
        suggestion: "Remove CREATE SCHEMA statements",
      });
    }

    if (schema.enums && schema.enums.length > 0) {
      errors.push({
        code: "SQLITE_NO_ENUMS",
        message: "SQLite does not support ENUM types",
        suggestion: "Use TEXT with CHECK constraints instead",
      });
    }

    if (schema.compositeTypes && schema.compositeTypes.length > 0) {
      errors.push({
        code: "SQLITE_NO_COMPOSITE_TYPES",
        message: "SQLite does not support composite types",
        suggestion: "Remove CREATE TYPE ... AS (...) statements",
      });
    }

    if (schema.sequences && schema.sequences.length > 0) {
      errors.push({
        code: "SQLITE_NO_SEQUENCES",
        message: "SQLite does not support sequences",
        suggestion: "Use INTEGER PRIMARY KEY AUTOINCREMENT instead",
      });
    }

    if (schema.extensions && schema.extensions.length > 0) {
      errors.push({
        code: "SQLITE_NO_EXTENSIONS",
        message: "SQLite does not support extensions",
        suggestion: "Remove CREATE EXTENSION statements",
      });
    }

    if (schema.functions && schema.functions.length > 0) {
      errors.push({
        code: "SQLITE_NO_FUNCTIONS",
        message: "SQLite does not support stored functions",
        suggestion: "Remove CREATE FUNCTION statements",
      });
    }

    if (schema.procedures && schema.procedures.length > 0) {
      errors.push({
        code: "SQLITE_NO_PROCEDURES",
        message: "SQLite does not support stored procedures",
        suggestion: "Remove CREATE PROCEDURE statements",
      });
    }

    for (const table of schema.tables) {
      const matchClauses = new Set(
        extractSQLiteForeignKeyMatchClauses(table.createStatement || "")
      );
      for (const foreignKey of table.foreignKeys || []) {
        if (foreignKey.matchType) {
          matchClauses.add(foreignKey.matchType);
        }
      }
      for (const matchClause of matchClauses) {
        if (matchClause === "SIMPLE") {
          continue;
        }
        errors.push({
          code: "SQLITE_FOREIGN_KEY_MATCH_UNSUPPORTED",
          message:
            `SQLite parses MATCH ${matchClause} on "${table.name}" but ` +
            "enforces MATCH SIMPLE semantics instead",
          object: table.name,
          suggestion:
            "Remove the MATCH clause or use MATCH SIMPLE explicitly",
        });
      }

      for (const foreignKey of table.foreignKeys || []) {
        const referencedTableName = normalizeSQLiteIdentifier(
          foreignKey.referencedTable
        );
        const referencedTable = tablesByName.get(referencedTableName);
        if (!referencedTable) {
          errors.push({
            code: "SQLITE_FOREIGN_KEY_TARGET_MISSING",
            message:
              `Foreign key on "${table.name}" references missing table ` +
              `"${foreignKey.referencedTable}"`,
            object: `${table.name}.${foreignKey.columns.join(",")}`,
            suggestion:
              `Add CREATE TABLE "${foreignKey.referencedTable}" or remove ` +
              "the foreign key",
          });
          continue;
        }

        if (
          foreignKey.referencedColumns.length !== foreignKey.columns.length
        ) {
          errors.push({
            code: "SQLITE_FOREIGN_KEY_TARGET_KEY_MISMATCH",
            message:
              `Foreign key on "${table.name}" has ` +
              `${foreignKey.columns.length} column(s), but the primary key ` +
              `of "${referencedTable.name}" cannot supply the same target`,
            object: `${table.name}.${foreignKey.columns.join(",")}`,
            suggestion:
              "Specify referenced columns explicitly or use the complete " +
              "parent primary key",
          });
          continue;
        }

        const referencedColumnNames = new Set(
          referencedTable.columns.map(function (column) {
            return normalizeSQLiteIdentifier(column.name);
          })
        );
        const missingReferencedColumns = foreignKey.referencedColumns.filter(
          function (column) {
            return !referencedColumnNames.has(normalizeSQLiteIdentifier(column));
          }
        );
        if (missingReferencedColumns.length > 0) {
          errors.push({
            code: "SQLITE_FOREIGN_KEY_TARGET_COLUMN_MISSING",
            message:
              `Foreign key on "${table.name}" references missing column(s) ` +
              `${missingReferencedColumns.join(", ")} on ` +
              `"${referencedTable.name}"`,
            object: `${table.name}.${foreignKey.columns.join(",")}`,
            suggestion:
              "Reference named columns that exist on the parent table",
          });
          continue;
        }

        const parentKeyStatus = getSQLiteParentKeyStatus(
          referencedTable,
          foreignKey.referencedColumns
        );
        if (parentKeyStatus === "collation_mismatch") {
          errors.push({
            code: "SQLITE_FOREIGN_KEY_TARGET_COLLATION_MISMATCH",
            message:
              `Foreign key on "${table.name}" references a unique key on ` +
              `"${referencedTable.name}" whose collations do not match the ` +
              "parent column declarations",
            object: `${table.name}.${foreignKey.columns.join(",")}`,
            suggestion:
              "Use the parent columns' declared collations for the complete " +
              "UNIQUE key",
          });
        } else if (parentKeyStatus === "not_unique") {
          errors.push({
            code: "SQLITE_FOREIGN_KEY_TARGET_NOT_UNIQUE",
            message:
              `Foreign key on "${table.name}" references columns on ` +
              `"${referencedTable.name}" that are not exactly covered by a ` +
              "PRIMARY KEY or non-partial UNIQUE key",
            object: `${table.name}.${foreignKey.columns.join(",")}`,
            suggestion:
              "Add a matching PRIMARY KEY, UNIQUE constraint, or non-partial " +
              "UNIQUE index",
          });
        }
      }

      for (const index of table.indexes || []) {
        if (index.type && index.type !== "btree") {
          errors.push({
            code: "SQLITE_BTREE_ONLY",
            message: `SQLite only supports btree indexes, found ${index.type}`,
            object: `${table.name}.${index.name}`,
            suggestion: "Remove USING clause or use btree",
          });
        }
        if (index.opclasses && Object.keys(index.opclasses).length > 0) {
          errors.push({
            code: "SQLITE_NO_OPCLASS",
            message: "SQLite does not support operator classes",
            object: `${table.name}.${index.name}`,
          });
        }
      }
    }

    for (const view of schema.views || []) {
      if (view.materialized) {
        errors.push({
          code: "SQLITE_NO_MATERIALIZED_VIEWS",
          message: "SQLite does not support materialized views",
          object: view.name,
          suggestion: "Use regular views or tables instead",
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  async executeInTransaction(
    client: DatabaseClient,
    statements: string[]
  ): Promise<void> {
    const sqliteClient = client as SQLiteClient;
    const useSpinner = !Logger.isSilent();
    const ora = useSpinner ? (await import("ora")).default : undefined;
    const spinner = useSpinner
      ? ora!({ text: "Applying changes...", color: "white" }).start()
      : undefined;
    const startTime = Date.now();

    let currentStatement: string | undefined;
    const foreignKeySuspensionRequired =
      this.requiresForeignKeySuspension(statements);
    let foreignKeysInitiallyEnabled = false;
    let foreignKeysSuspended = false;
    let checkConstraintsTemporarilyEnforced = false;
    let deferredForeignKeysNeedRestoration = false;
    let writableSchemaTemporarilyDisabled = false;

    try {
      if (sqliteClient.raw.inTransaction) {
        throw new Error(
          "SQLite migrations must run outside an active transaction or savepoint"
        );
      }

      currentStatement = "PRAGMA writable_schema";
      const writableSchemaResult = await sqliteClient.query<{
        writable_schema: number;
      }>("PRAGMA writable_schema");
      const writableSchemaWasEnabled =
        writableSchemaResult.rows[0]?.writable_schema === 1;

      if (writableSchemaWasEnabled) {
        currentStatement = "PRAGMA writable_schema = OFF";
        sqliteClient.execMultiple("PRAGMA writable_schema = OFF");
        writableSchemaTemporarilyDisabled = true;
      }

      currentStatement = "PRAGMA ignore_check_constraints";
      const checkConstraintResult = await sqliteClient.query<{
        ignore_check_constraints: number;
      }>("PRAGMA ignore_check_constraints");
      const checkConstraintsWereIgnored =
        checkConstraintResult.rows[0]?.ignore_check_constraints === 1;

      if (checkConstraintsWereIgnored) {
        currentStatement = "PRAGMA ignore_check_constraints = OFF";
        sqliteClient.execMultiple("PRAGMA ignore_check_constraints = OFF");
        checkConstraintsTemporarilyEnforced = true;
      }

      currentStatement = "PRAGMA defer_foreign_keys";
      const deferredForeignKeyResult = await sqliteClient.query<{
        defer_foreign_keys: number;
      }>("PRAGMA defer_foreign_keys");
      deferredForeignKeysNeedRestoration =
        deferredForeignKeyResult.rows[0]?.defer_foreign_keys === 1;

      if (foreignKeySuspensionRequired) {
        currentStatement = "PRAGMA foreign_keys";
        const result = await sqliteClient.query<{ foreign_keys: number }>(
          "PRAGMA foreign_keys"
        );
        foreignKeysInitiallyEnabled = result.rows[0]?.foreign_keys === 1;
      }

      if (foreignKeysInitiallyEnabled) {
        sqliteClient.execMultiple("PRAGMA foreign_keys = OFF");
        foreignKeysSuspended = true;
      }

      sqliteClient.inTransaction(() => {
        for (const statement of statements) {
          if (statement.startsWith("--")) {
            continue;
          }
          currentStatement = statement;
          sqliteClient.execMultiple(statement);
        }

        if (foreignKeySuspensionRequired) {
          currentStatement = "PRAGMA foreign_key_check";
          const violations = sqliteClient.raw.prepare("PRAGMA foreign_key_check").all();
          if (violations.length > 0) {
            throw new Error(`Foreign key integrity check failed (${violations.length} violation(s))`);
          }

          currentStatement = "PRAGMA integrity_check(1)";
          const integrityResult = sqliteClient.raw
            .prepare("PRAGMA integrity_check(1)")
            .get() as { integrity_check?: unknown } | undefined;
          const integrityStatus = integrityResult?.integrity_check;
          if (integrityStatus !== "ok") {
            const detail = typeof integrityStatus === "string"
              ? integrityStatus
              : "unknown result";
            throw new Error(`SQLite integrity check failed: ${detail}`);
          }
        }
      });

      if (foreignKeysSuspended) {
        sqliteClient.execMultiple("PRAGMA foreign_keys = ON");
        foreignKeysSuspended = false;
      }

      if (checkConstraintsTemporarilyEnforced) {
        currentStatement = "PRAGMA ignore_check_constraints = ON";
        sqliteClient.execMultiple("PRAGMA ignore_check_constraints = ON");
        checkConstraintsTemporarilyEnforced = false;
      }

      if (deferredForeignKeysNeedRestoration) {
        currentStatement = "PRAGMA defer_foreign_keys = ON";
        sqliteClient.execMultiple("PRAGMA defer_foreign_keys = ON");
        deferredForeignKeysNeedRestoration = false;
      }

      if (writableSchemaTemporarilyDisabled) {
        currentStatement = "PRAGMA writable_schema = ON";
        sqliteClient.execMultiple("PRAGMA writable_schema = ON");
        writableSchemaTemporarilyDisabled = false;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (spinner) {
        spinner.stopAndPersist({ symbol: "✔", text: `Applied (${elapsed}s)` });
      }
    } catch (error) {
      if (foreignKeysSuspended) {
        try {
          sqliteClient.execMultiple("PRAGMA foreign_keys = ON");
        } catch {}
      }
      if (checkConstraintsTemporarilyEnforced) {
        try {
          sqliteClient.execMultiple("PRAGMA ignore_check_constraints = ON");
        } catch {}
      }
      if (deferredForeignKeysNeedRestoration) {
        try {
          sqliteClient.execMultiple("PRAGMA defer_foreign_keys = ON");
        } catch {}
      }
      if (writableSchemaTemporarilyDisabled) {
        try {
          sqliteClient.execMultiple("PRAGMA writable_schema = ON");
        } catch {}
      }
      if (spinner) {
        spinner.stopAndPersist({ symbol: "✗", text: "Failed to apply changes" });
      }

      throw new MigrationError(
        error instanceof Error ? error.message : String(error),
        currentStatement
      );
    }
  }

  private requiresForeignKeySuspension(statements: string[]): boolean {
    return statements.some(function (statement) {
      return /^DROP TABLE\s+/i.test(statement.trim());
    });
  }
}

export { SQLiteClient } from "./client";
export { SQLiteInspector } from "./inspector";
export { SQLiteParser } from "./parser";
export { SQLiteDiffer } from "./differ";
