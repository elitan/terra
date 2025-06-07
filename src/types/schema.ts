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

export interface Table {
  name: string;
  columns: Column[];
  primaryKey?: PrimaryKeyConstraint;
}
