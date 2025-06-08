export interface MigrationPlan {
  transactional: string[];
  concurrent: string[];
  hasChanges: boolean;
}

export interface MigrationOptions {
  /** Use CREATE INDEX CONCURRENTLY by default for production safety (default: true) */
  useConcurrentIndexes?: boolean;
  /** Use DROP INDEX CONCURRENTLY by default for production safety (default: true) */
  useConcurrentDrops?: boolean;
  /** Timeout for concurrent operations in milliseconds (default: 30000) */
  concurrentTimeout?: number;
  /** Whether to provide progress feedback for long-running operations (default: true) */
  showProgress?: boolean;
  /** Fallback to non-concurrent operations if concurrent fails (default: true) */
  allowFallback?: boolean;
}

export const DEFAULT_MIGRATION_OPTIONS: MigrationOptions = {
  useConcurrentIndexes: true,
  useConcurrentDrops: true,
  concurrentTimeout: 30000, // 30 seconds
  showProgress: true,
  allowFallback: true,
};
