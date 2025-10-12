export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
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
  onDelete?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT';
  onUpdate?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT';
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
  columns: string[];
  type?: "btree" | "hash" | "gist" | "spgist" | "gin" | "brin";
  unique?: boolean;
  concurrent?: boolean;
  where?: string; // For partial indexes
  expression?: string; // For expression indexes
  storageParameters?: Record<string, string>;
  tablespace?: string;
}

export interface EnumType {
  name: string;
  values: string[];
}

export interface View {
  name: string;
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
  parameters: FunctionParameter[];
  language: string;
  body: string;
  securityDefiner?: boolean;
}

export interface Trigger {
  name: string;
  tableName: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: ('INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE')[];
  forEach?: 'ROW' | 'STATEMENT';
  when?: string;
  functionName: string;
  functionArgs?: string[];
}

export interface Sequence {
  name: string;
  dataType?: 'SMALLINT' | 'INTEGER' | 'BIGINT';
  increment?: number;
  minValue?: number;
  maxValue?: number;
  start?: number;
  cache?: number;
  cycle?: boolean;
  ownedBy?: string;
}

export interface Table {
  name: string;
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
}
