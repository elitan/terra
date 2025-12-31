export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  generated?: {
    always: boolean;
    expression: string;
    stored: boolean;
  };
}

export interface PrimaryKeyConstraint {
  name?: string;
  columns: string[];
}

export interface ForeignKeyConstraint {
  name?: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';
  onUpdate?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';
  deferrable?: boolean;
  initiallyDeferred?: boolean;
}

export interface CheckConstraint {
  name?: string;
  expression: string;
}

export interface UniqueConstraint {
  name?: string;
  columns: string[];
  deferrable?: boolean;
  initiallyDeferred?: boolean;
}

export interface Index {
  name: string;
  tableName: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  columns: string[];
  opclasses?: Record<string, string>; // Maps column name to operator class (e.g., gin_trgm_ops)
  type?: "btree" | "hash" | "gist" | "spgist" | "gin" | "brin";
  unique?: boolean;
  concurrent?: boolean;
  where?: string; // For partial indexes
  expression?: string; // For expression indexes
  storageParameters?: Record<string, string>;
  tablespace?: string;
  // Marks if this index is backed by a constraint (e.g., UNIQUE constraint).
  // When present, this index should be managed via ALTER TABLE ADD/DROP CONSTRAINT
  // rather than CREATE/DROP INDEX. This enables proper batching with other table alterations.
  constraint?: {
    type: 'u' | 'p' | 'x'; // u = unique, p = primary key, x = exclude
    name?: string; // constraint name (may differ from index name)
  };
}

export interface EnumType {
  name: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  values: string[];
}

export interface View {
  name: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  definition: string; // The SELECT statement
  materialized?: boolean;
  columns?: Column[]; // For typed views or materialized views
  indexes?: Index[]; // Only for materialized views
  checkOption?: 'CASCADED' | 'LOCAL'; // WITH CHECK OPTION
  securityBarrier?: boolean; // security_barrier option
  dependencies?: string[]; // Tables/views this view depends on
}

export interface FunctionParameter {
  name?: string;
  type: string;
  mode?: 'IN' | 'OUT' | 'INOUT' | 'VARIADIC';
  default?: string;
}

export interface Function {
  name: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  parameters: FunctionParameter[];
  returnType: string;
  language: string;
  body: string;
  volatility?: 'VOLATILE' | 'STABLE' | 'IMMUTABLE';
  parallel?: 'SAFE' | 'UNSAFE' | 'RESTRICTED';
  securityDefiner?: boolean;
  strict?: boolean;
  cost?: number;
  rows?: number;
}

export interface Procedure {
  name: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  parameters: FunctionParameter[];
  language: string;
  body: string;
  securityDefiner?: boolean;
}

export interface Trigger {
  name: string;
  tableName: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: ('INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE')[];
  forEach?: 'ROW' | 'STATEMENT';
  when?: string;
  functionName: string;
  functionArgs?: string[];
}

export interface Sequence {
  name: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  dataType?: 'SMALLINT' | 'INTEGER' | 'BIGINT';
  increment?: number;
  minValue?: number;
  maxValue?: number;
  start?: number;
  cache?: number;
  cycle?: boolean;
  ownedBy?: string;
}

export interface Extension {
  name: string;
  schema?: string; // Schema where extension is installed, defaults to 'public'
  version?: string; // Extension version
  cascade?: boolean; // If true, install dependencies
}

export interface SchemaDefinition {
  name: string;
  owner?: string;
  ifNotExists?: boolean;
}

export type CommentObjectType = 'SCHEMA' | 'TABLE' | 'COLUMN' | 'VIEW' | 'FUNCTION' | 'INDEX' | 'TYPE';

export interface Comment {
  objectType: CommentObjectType;
  objectName: string;
  schemaName?: string;
  columnName?: string;
  comment: string;
}

export interface Table {
  name: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  columns: Column[];
  primaryKey?: PrimaryKeyConstraint;
  foreignKeys?: ForeignKeyConstraint[];
  checkConstraints?: CheckConstraint[];
  uniqueConstraints?: UniqueConstraint[];
  indexes?: Index[];
}

export interface Schema {
  tables: Table[];
  views: View[];
  enumTypes: EnumType[];
  functions?: Function[];
  procedures?: Procedure[];
  triggers?: Trigger[];
  sequences?: Sequence[];
  extensions?: Extension[];
  schemas?: SchemaDefinition[];
  comments?: Comment[];
}
