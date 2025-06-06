export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  primary?: boolean;
}

export interface Table {
  name: string;
  columns: Column[];
}
