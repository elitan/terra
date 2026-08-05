export interface QualifiedName {
  name: string;
  schema?: string;
}

export type IdentitySequenceName = QualifiedName;

export type ColumnStorage = 'PLAIN' | 'EXTERNAL' | 'EXTENDED' | 'MAIN';

export interface IdentityColumn {
  generation: 'ALWAYS' | 'BY DEFAULT';
  sequenceName?: IdentitySequenceName;
  sequencePersistence?: 'logged' | 'unlogged';
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
  /** Catalog namespace of an inspected PostgreSQL type reference. */
  typeSchema?: string;
  nullable: boolean;
  default?: string;
  /** Set by PostgreSQL inspection when a matching owned sequence is a default dependency. */
  serial?: boolean;
  /** Whether an inspected serial sequence retains PostgreSQL's canonical definition options. */
  serialSequenceOptionsMatch?: boolean;
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

export interface PostgresColumnStatistics {
  column: string;
  statisticsTarget?: number;
  nDistinct?: number;
  nDistinctInherited?: number;
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
  matchType?: 'FULL' | 'SIMPLE';
  onDelete?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';
  onDeleteColumns?: string[];
  onUpdate?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';
  deferrable?: boolean;
  initiallyDeferred?: boolean;
  notValid?: boolean;
}

export interface CheckConstraint {
  name?: string;
  expression: string;
  noInherit?: boolean;
  notValid?: boolean;
}

export interface UniqueConstraint {
  name?: string;
  columns: string[];
  collations?: string[]; // SQLite effective collations for each constrained column
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
  collation?: string | QualifiedName;
  opclass?: QualifiedName;
  opclassOptions?: Record<string, string>;
  opclassDefault?: boolean;
  order?: 'ASC' | 'DESC';
  nullsOrder?: 'FIRST' | 'LAST';
  statisticsTarget?: number;
}

export interface Index {
  name: string;
  tableName: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  columns: string[];
  include?: string[]; // PostgreSQL non-key payload columns for covering indexes
  collations?: Array<QualifiedName | undefined>; // Explicit PostgreSQL collation override per key
  sortOrders?: ('ASC' | 'DESC')[]; // Sort order per column (defaults to ASC if not specified)
  nullsOrders?: ('FIRST' | 'LAST')[]; // Effective null placement when any key uses a non-default order
  terms?: IndexTerm[]; // Complete ordered keys, including expressions and per-key metadata
  createStatement?: string; // Complete CREATE INDEX statement when exact syntax must be preserved
  opclasses?: Record<string, string>; // Maps column name to operator class (e.g., gin_trgm_ops)
  expressionOpclass?: string;
  type?: "btree" | "hash" | "gist" | "spgist" | "gin" | "brin" | (string & {});
  unique?: boolean;
  nullsNotDistinct?: boolean;
  concurrent?: boolean;
  where?: string; // For partial indexes
  expression?: string; // For expression indexes
  expressionStatisticsTarget?: number; // PostgreSQL target for a single expression key
  dependentColumns?: string[]; // PostgreSQL columns that make this index auto-drop with DROP COLUMN
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
  attributeDependents?: CompositeTypeAttributeDependent[];
  typeDependents?: CompositeTypeTypeDependent[];
  routineDependents?: PostgresTypeRoutineDependent[];
  catalogDependents?: PostgresTypeCatalogDependent[];
}

export interface CompositeTypeAttribute {
  name: string;
  type: string;
  /** Catalog namespace of an inspected PostgreSQL type reference. */
  typeSchema?: string;
  collation?: QualifiedName;
}

export interface CompositeTypeAttributeDependent {
  schema: string;
  relation: string;
  attribute: string;
  relationKind: string;
}

export interface CompositeTypeTypeDependent {
  schema: string;
  name: string;
  kind: "domain" | "range";
}

export interface CompositeType {
  name: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  attributes: CompositeTypeAttribute[];
  attributeDependents?: CompositeTypeAttributeDependent[];
  typeDependents?: CompositeTypeTypeDependent[];
  routineDependents?: PostgresTypeRoutineDependent[];
  catalogDependents?: PostgresTypeCatalogDependent[];
}

export interface View {
  name: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  definition: string; // The SELECT statement
  createStatement?: string; // Complete CREATE VIEW statement when exact syntax must be preserved
  materialized?: boolean;
  columnNames?: string[]; // Effective output names in ordinal order
  columns?: Column[]; // For typed views or materialized views
  indexes?: Index[]; // Only for materialized views
  clusterIndex?: string; // PostgreSQL index remembered for future CLUSTER operations
  columnStatistics?: PostgresColumnStatistics[]; // PostgreSQL materialized-view column planner statistics
  populated?: boolean; // Materialized view scannability from WITH [NO] DATA
  storageParameters?: Record<string, string>; // Materialized view storage parameters
  tablespace?: string; // Materialized view tablespace; undefined means pg_default
  accessMethod?: string; // Materialized view table access method
  checkOption?: 'CASCADED' | 'LOCAL'; // WITH CHECK OPTION
  securityBarrier?: boolean; // security_barrier option
  securityInvoker?: boolean; // security_invoker option (PostgreSQL 15+)
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
  leakproof?: boolean;
  securityDefiner?: boolean;
  strict?: boolean;
  cost?: number;
  rows?: number;
  configuration?: Record<string, string>;
  dependentObjects?: string[];
}

export interface Procedure {
  name: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  parameters: FunctionParameter[];
  language: string;
  body: string;
  securityDefiner?: boolean;
  configuration?: Record<string, string>;
  dependentObjects?: string[];
}

export type PostgresTriggerEnabledMode =
  | 'origin'
  | 'disabled'
  | 'replica'
  | 'always';

export type PostgresReplicaIdentity =
  | { mode: 'full' }
  | { mode: 'nothing' }
  | { mode: 'index'; indexName: string }
  | { mode: 'index-missing' };

export interface Trigger {
  name: string;
  tableName: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: ('INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE')[];
  updateColumns?: string[];
  forEach?: 'ROW' | 'STATEMENT';
  oldTransitionTable?: string;
  newTransitionTable?: string;
  when?: string;
  functionName: string;
  functionSchema?: string;
  functionArgs?: string[];
  enabled?: PostgresTriggerEnabledMode;
  definition?: string;
}

export interface Sequence {
  name: string;
  schema?: string; // PostgreSQL schema name, defaults to 'public'
  unlogged?: boolean;
  dataType?: 'SMALLINT' | 'INTEGER' | 'BIGINT';
  increment?: number | string;
  minValue?: number | string;
  maxValue?: number | string;
  start?: number | string;
  cache?: number | string;
  cycle?: boolean;
  ownedBy?: string;
}

export interface Extension {
  name: string;
  schema?: string; // Schema where extension is installed, defaults to 'public'
  version?: string; // Extension version
  cascade?: boolean; // If true, install dependencies
  dependencies?: string[]; // Installed extensions required by this extension
}

export type SqlObjectKind =
  | "constraint-trigger"
  | "domain-type"
  | "event-trigger"
  | "default-privilege"
  | "foreign-server"
  | "grant"
  | "partition"
  | "policy"
  | "range-type"
  | "role"
  | "row-level-security";

export interface PartitionKeyOperatorClass extends QualifiedName {
  inputType: QualifiedName;
  isDefault: boolean;
}

export interface DomainTypeConstraint {
  name?: string;
  expression: string;
  validated: boolean;
}

export interface DomainTypeDefinition {
  kind: "domain";
  baseType: string;
  /** Catalog namespace of an inspected PostgreSQL base type. */
  baseTypeSchema?: string;
  collation?: QualifiedName;
  default?: string;
  notNull: boolean;
  constraints: DomainTypeConstraint[];
}

export interface RangeTypeDefinition {
  kind: "range";
  subtype: string;
  /** Catalog namespace of an inspected PostgreSQL subtype. */
  subtypeSchema?: string;
  subtypeOperatorClass?: QualifiedName;
  subtypeOperatorClassIsDefault?: boolean;
  collation?: QualifiedName;
  canonicalFunction?: QualifiedName;
  subtypeDiffFunction?: QualifiedName;
  multirangeTypeName?: QualifiedName;
}

export type PostgresTypeDefinition =
  | DomainTypeDefinition
  | RangeTypeDefinition;

export type PostgresPolicyRole =
  | { kind: "name"; name: string }
  | {
      kind:
        | "public"
        | "current_role"
        | "current_user"
        | "session_user";
    };

export interface PostgresPolicyDefinition {
  command: "all" | "select" | "insert" | "update" | "delete";
  permissive: boolean;
  roles: PostgresPolicyRole[];
  using?: string;
  withCheck?: string;
}

export interface PostgresForeignServerOption {
  name: string;
  value: string;
}

export interface PostgresForeignServerDefinition {
  foreignDataWrapper: string;
  owner?: string;
  type?: string;
  version?: string;
  options: PostgresForeignServerOption[];
}

export interface PostgresRoleDefinition {
  login: boolean;
  superuser: boolean;
  createDatabase: boolean;
  createRole: boolean;
  inherit: boolean;
  replication: boolean;
  bypassRowLevelSecurity: boolean;
  connectionLimit: number;
}

export type PostgresGrantObjectType =
  | "TABLE"
  | "SEQUENCE"
  | "SCHEMA"
  | "FOREIGN SERVER";

export interface PostgresGrantDefinition {
  objectType: PostgresGrantObjectType;
  objectName: string;
  schema?: string;
  grantee: string;
  granteeIsPublic: boolean;
  privilege: string;
  grantable: boolean;
  implicitDefault: boolean;
}

export type PostgresDefaultPrivilegeObjectType =
  | "TABLES"
  | "SEQUENCES"
  | "ROUTINES"
  | "TYPES"
  | "SCHEMAS";

export interface PostgresDefaultPrivilegeDefinition {
  owner: string;
  objectType: PostgresDefaultPrivilegeObjectType;
  schema?: string;
  grantee: string;
  granteeIsPublic: boolean;
  privilege: string;
  granted: boolean;
  grantable: boolean;
  baselineGranted: boolean;
}

export interface PostgresTypeRoutineDependent {
  schema: string;
  name: string;
  kind: "function" | "procedure";
  identityArguments: string;
}

export interface PostgresTypeCatalogDependent {
  type: string;
  schema?: string;
  name?: string;
  identity: string;
  ownerSchema?: string;
  ownerRelation?: string;
  ownerRelationKind?: string;
  ownerAttributes?: string[];
}

export interface SqlObject {
  kind: SqlObjectKind;
  key: string;
  name: string;
  desiredAbsent?: boolean;
  schema?: string;
  createStatement: string;
  dropStatement?: string;
  dependencies?: string[];
  partitionKeyOperatorClasses?: PartitionKeyOperatorClass[];
  /** Catalog namespaces for columns reconstructed from an inspected partition. */
  partitionColumnTypeSchemas?: Record<string, string>;
  typeDefinition?: PostgresTypeDefinition;
  policyDefinition?: PostgresPolicyDefinition;
  foreignServerDefinition?: PostgresForeignServerDefinition;
  roleDefinition?: PostgresRoleDefinition;
  grantDefinition?: PostgresGrantDefinition;
  defaultPrivilegeDefinition?: PostgresDefaultPrivilegeDefinition;
  triggerTable?: QualifiedName;
  triggerFunction?: QualifiedName;
  triggerEnabled?: PostgresTriggerEnabledMode;
  replicaIdentity?: PostgresReplicaIdentity;
  attributeDependents?: CompositeTypeAttributeDependent[];
  typeDependents?: CompositeTypeTypeDependent[];
  routineDependents?: PostgresTypeRoutineDependent[];
  catalogDependents?: PostgresTypeCatalogDependent[];
  hasContainerColumnDependents?: boolean;
}

export interface SchemaDefinition {
  name: string;
  owner?: string;
}

export type CommentObjectType =
  | 'SCHEMA'
  | 'TABLE'
  | 'COLUMN'
  | 'VIEW'
  | 'MATERIALIZED VIEW'
  | 'INDEX'
  | 'SEQUENCE'
  | 'TYPE';

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
  replicaIdentity?: PostgresReplicaIdentity;
  clusterIndex?: string; // PostgreSQL index remembered for future CLUSTER operations
  columnStatistics?: PostgresColumnStatistics[]; // PostgreSQL per-column planner statistics and n_distinct overrides
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
