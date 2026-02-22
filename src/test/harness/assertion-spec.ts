export interface PlanAssertionSpec {
  hasChanges: boolean;
  transactionalContains?: string[];
  transactionalExcludes?: string[];
  deferredContains?: string[];
  concurrentContains?: string[];
}

export interface ApplyAssertionSpec {
  shouldSucceed: boolean;
  expectedError?: string;
  expectedTableNames?: string[];
  expectedRowCounts?: Record<string, number>;
}

