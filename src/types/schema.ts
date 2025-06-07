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

export interface Table {
  name: string;
  columns: Column[];
  primaryKey?: PrimaryKeyConstraint;
  indexes?: Index[];
}
