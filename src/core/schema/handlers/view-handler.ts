import type { View } from "../../../types/schema";
import { Logger } from "../../../utils/logger";
import {
  generateCreateViewSQL,
  generateDropViewSQL,
  generateCreateOrReplaceViewSQL,
} from "../../../utils/sql";

export class ViewHandler {
  generateStatements(desiredViews: View[], currentViews: View[]): string[] {
    const statements: string[] = [];
    const currentViewMap = new Map(currentViews.map(v => [v.name, v]));
    const desiredViewNames = new Set(desiredViews.map(v => v.name));

    for (const currentView of currentViews) {
      if (!desiredViewNames.has(currentView.name)) {
        statements.push(generateDropViewSQL(currentView.name, currentView.materialized));
        Logger.info(`Dropping view '${currentView.name}'`);
      }
    }

    for (const desiredView of desiredViews) {
      const currentView = currentViewMap.get(desiredView.name);

      if (!currentView) {
        statements.push(generateCreateViewSQL(desiredView));
        Logger.info(`Creating view '${desiredView.name}'`);
      } else {
        if (this.needsUpdate(desiredView, currentView)) {
          statements.push(generateCreateOrReplaceViewSQL(desiredView));
          Logger.info(`Updating view '${desiredView.name}'`);
        } else {
          Logger.info(`View '${desiredView.name}' is up to date, skipping`);
        }
      }
    }

    return statements;
  }

  private needsUpdate(desired: View, current: View): boolean {
    if (desired.materialized !== current.materialized) {
      return true;
    }

    const normalizeDefinition = (def: string) => def.replace(/\s+/g, ' ').trim();
    const normalizedDesired = normalizeDefinition(desired.definition);
    const normalizedCurrent = normalizeDefinition(current.definition);

    if (normalizedDesired !== normalizedCurrent) {
      Logger.info(`View '${desired.name}' needs update:`);
      Logger.info(`  Desired: ${normalizedDesired.substring(0, 100)}...`);
      Logger.info(`  Current: ${normalizedCurrent.substring(0, 100)}...`);
      return true;
    }

    if (desired.checkOption !== current.checkOption) {
      return true;
    }

    if (desired.securityBarrier !== current.securityBarrier) {
      return true;
    }

    return false;
  }
}
