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

export interface Table {
  name: string;
  columns: Column[];
  primaryKey?: PrimaryKeyConstraint;
  foreignKeys?: ForeignKeyConstraint[];
  checkConstraints?: CheckConstraint[];
  uniqueConstraints?: UniqueConstraint[];
  indexes?: Index[];
}
