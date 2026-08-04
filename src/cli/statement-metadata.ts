import type { MigrationPlan } from "../types/migration";
import type {
  CliStatementChannel,
  CliStatementMetadata,
} from "../types/cli-output";
import {
  getStatementCategory,
  getStatementRisk,
} from "../utils/statement-classifier";

function appendChannelMetadata(
  target: CliStatementMetadata[],
  statements: string[],
  channel: CliStatementChannel,
  offset: number
): number {
  let order = offset;
  for (const statement of statements) {
    order += 1;
    target.push({
      order,
      channel,
      category: getStatementCategory(statement),
      risk: getStatementRisk(statement, channel),
      sql: statement,
    });
  }
  return order;
}

export function buildStatementMetadata(plan: MigrationPlan): CliStatementMetadata[] {
  const metadata: CliStatementMetadata[] = [];
  let order = 0;
  order = appendChannelMetadata(
    metadata,
    plan.preTransactional ?? [],
    "pre-transactional",
    order
  );
  order = appendChannelMetadata(metadata, plan.transactional, "transactional", order);
  order = appendChannelMetadata(metadata, plan.deferred, "deferred", order);
  appendChannelMetadata(metadata, plan.concurrent, "concurrent", order);
  return metadata;
}
