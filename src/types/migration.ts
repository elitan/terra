export interface MigrationPlan {
  statements: string[];
  hasChanges: boolean;
}
