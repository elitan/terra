import type {
  Table,
  EnumType,
  View,
  Function,
  Procedure,
  Trigger,
  Sequence,
  Extension,
  SchemaDefinition,
  Comment,
} from "../types/schema";
import type { MigrationPlan } from "../types/migration";

export type DatabaseDialect = "postgres" | "sqlite";

export interface PostgresConnectionConfig {
  dialect: "postgres";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
}

export interface SQLiteConnectionConfig {
  dialect: "sqlite";
  filename: string;
}

export type ConnectionConfig = PostgresConnectionConfig | SQLiteConnectionConfig;

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
}

export interface DatabaseClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
  end(): Promise<void>;
}

export interface ParsedSchema {
  tables: Table[];
  enums: EnumType[];
  views: View[];
  functions: Function[];
  procedures: Procedure[];
  triggers: Trigger[];
  sequences: Sequence[];
  extensions: Extension[];
  schemas: SchemaDefinition[];
  comments: Comment[];
}

export type DatabaseFeature =
  | "schemas"
  | "sequences"
  | "enums"
  | "extensions"
  | "concurrent_indexes"
  | "advisory_locks"
  | "alter_column_type"
  | "alter_drop_column"
  | "stored_functions"
  | "stored_procedures"
  | "materialized_views"
  | "triggers"
  | "index_types";

export interface ValidationError {
  code: string;
  message: string;
  object?: string;
  suggestion?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  object?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface AdvisoryLockOptions {
  lockName: string;
  lockTimeout: number;
}

export interface DatabaseProvider {
  readonly dialect: DatabaseDialect;

  createClient(config: ConnectionConfig): Promise<DatabaseClient>;

  parseSchema(sql: string, filePath?: string): Promise<ParsedSchema>;

  getCurrentSchema(client: DatabaseClient, schemas?: string[]): Promise<Table[]>;
  getCurrentEnums(client: DatabaseClient, schemas?: string[]): Promise<EnumType[]>;
  getCurrentViews(client: DatabaseClient, schemas?: string[]): Promise<View[]>;
  getCurrentFunctions(client: DatabaseClient, schemas?: string[]): Promise<Function[]>;
  getCurrentProcedures(client: DatabaseClient, schemas?: string[]): Promise<Procedure[]>;
  getCurrentTriggers(client: DatabaseClient, schemas?: string[]): Promise<Trigger[]>;
  getCurrentSequences(client: DatabaseClient, schemas?: string[]): Promise<Sequence[]>;
  getCurrentExtensions(client: DatabaseClient, schemas?: string[]): Promise<Extension[]>;
  getCurrentSchemas(client: DatabaseClient, schemas?: string[]): Promise<SchemaDefinition[]>;
  getCurrentComments(client: DatabaseClient, schemas?: string[]): Promise<Comment[]>;

  generateMigrationPlan(desired: Table[], current: Table[]): MigrationPlan;

  supportsFeature(feature: DatabaseFeature): boolean;
  validateSchema(schema: ParsedSchema): ValidationResult;

  executeInTransaction(
    client: DatabaseClient,
    statements: string[]
  ): Promise<void>;

  acquireAdvisoryLock?(
    client: DatabaseClient,
    options: AdvisoryLockOptions
  ): Promise<void>;

  releaseAdvisoryLock?(client: DatabaseClient, lockName: string): Promise<void>;
}
