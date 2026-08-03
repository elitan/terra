export interface QualifiedName {
  name: string;
  schema?: string;
}

export type IdentitySequenceName = QualifiedName;

export type ColumnStorage = 'PLAIN' | 'EXTERNAL' | 'EXTENDED' | 'MAIN';

export interface IdentityColumn {
  generation: 'ALWAYS' | 'BY DEFAULT';
  sequenceName?: IdentitySequenceName;
  start?: string;
  increment?: string;
  minValue?: string;
  maxValue?: string;
  cache?: string;
  cycle?: boolean;
}

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  collation?: QualifiedName;
  storage?: ColumnStorage;
  storageDefault?: ColumnStorage;
  compression?: 'pglz' | 'lz4' | (string & {});
  identity?: IdentityColumn;
  generated?: {
    always: boolean;
    expression: string;
    stored: boolean;
  };
}

export interface PrimaryKeyConstraint {
  name?: string;
  columns: string[];
  include?: string[];
  storageParameters?: Record<string, string>;
  tablespace?: string;
  deferrable?: boolean;
  initiallyDeferred?: boolean;
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
  include?: string[];
  storageParameters?: Record<string, string>;
  tablespace?: string;
  nullsNotDistinct?: boolean;
  deferrable?: boolean;
  initiallyDeferred?: boolean;
}

export interface ExclusionConstraintElement {
  definition: string;
  operator: QualifiedName;
}

export interface ExclusionConstraint {
  name?: string;
  method?: string;
  elements: ExclusionConstraintElement[];
  include?: string[];
  storageParameters?: Record<string, string>;
  tablespace?: string;
  where?: string;
  deferrable?: boolean;
  initiallyDeferred?: boolean;
}

export interface IndexTerm {
  column?: string;
  expression?: string;
  collation?: string;
  order?: 'ASC' | 'DESC';
}

export interface Index {
  name: string;
  tableName: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  columns: string[];
  include?: string[]; // PostgreSQL non-key payload columns for covering indexes
  sortOrders?: ('ASC' | 'DESC')[]; // Sort order per column (defaults to ASC if not specified)
  nullsOrders?: ('FIRST' | 'LAST')[]; // Effective null placement when any key uses a non-default order
  terms?: IndexTerm[]; // Complete ordered keys, including SQLite expressions and collations
  createStatement?: string; // Complete CREATE INDEX statement when exact syntax must be preserved
  opclasses?: Record<string, string>; // Maps column name to operator class (e.g., gin_trgm_ops)
  expressionOpclass?: string;
  type?: "btree" | "hash" | "gist" | "spgist" | "gin" | "brin" | (string & {});
  unique?: boolean;
  nullsNotDistinct?: boolean;
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

export interface CompositeTypeAttribute {
  name: string;
  type: string;
}

export interface CompositeType {
  name: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  attributes: CompositeTypeAttribute[];
}

export interface View {
  name: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  definition: string; // The SELECT statement
  createStatement?: string; // Complete CREATE VIEW statement when exact syntax must be preserved
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
  functionSchema?: string;
  functionArgs?: string[];
  definition?: string;
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

export type SqlObjectKind =
  | "constraint-trigger"
  | "domain-type"
  | "event-trigger"
  | "foreign-server"
  | "grant"
  | "partition"
  | "policy"
  | "range-type"
  | "role"
  | "row-level-security"
  | "user";

export interface SqlObject {
  kind: SqlObjectKind;
  key: string;
  name: string;
  schema?: string;
  createStatement: string;
  dropStatement?: string;
  dependencies?: string[];
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
  unlogged?: boolean;
  storageParameters?: Record<string, string>;
  tablespace?: string;
  accessMethod?: string;
  inherits?: QualifiedName[];
  inheritedColumns?: Column[];
  inheritedCheckConstraints?: CheckConstraint[];
  createStatement?: string; // Complete SQLite CREATE TABLE statement for lossless recreation
  virtual?: boolean; // SQLite virtual table backed by a registered module
  strict?: boolean; // SQLite STRICT table option
  withoutRowid?: boolean; // SQLite WITHOUT ROWID table option
  autoincrementColumns?: string[]; // SQLite INTEGER PRIMARY KEY AUTOINCREMENT columns
  primaryKey?: PrimaryKeyConstraint;
  foreignKeys?: ForeignKeyConstraint[];
  checkConstraints?: CheckConstraint[];
  uniqueConstraints?: UniqueConstraint[];
  exclusionConstraints?: ExclusionConstraint[];
  indexes?: Index[];
}

export interface Schema {
  tables: Table[];
  views: View[];
  enumTypes: EnumType[];
  compositeTypes?: CompositeType[];
  functions?: Function[];
  procedures?: Procedure[];
  triggers?: Trigger[];
  sequences?: Sequence[];
  extensions?: Extension[];
  schemas?: SchemaDefinition[];
  comments?: Comment[];
  sqlObjects?: SqlObject[];
}
