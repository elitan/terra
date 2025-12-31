import type { Trigger } from "../../../types/schema";
import { Logger } from "../../../utils/logger";
import {
  generateCreateTriggerSQL,
  generateDropTriggerSQL,
} from "../../../utils/sql";

export class TriggerHandler {
  generateStatements(desiredTriggers: Trigger[], currentTriggers: Trigger[]): string[] {
    const statements: string[] = [];
    const currentTriggerMap = new Map(currentTriggers.map(t => [`${t.tableName}.${t.name}`, t]));
    const desiredTriggerKeys = new Set(desiredTriggers.map(t => `${t.tableName}.${t.name}`));

    for (const currentTrig of currentTriggers) {
      const key = `${currentTrig.tableName}.${currentTrig.name}`;
      if (!desiredTriggerKeys.has(key)) {
        statements.push(generateDropTriggerSQL(currentTrig));
        Logger.info(`Dropping trigger '${currentTrig.name}' on '${currentTrig.tableName}'`);
      }
    }

    for (const desiredTrig of desiredTriggers) {
      const key = `${desiredTrig.tableName}.${desiredTrig.name}`;
      const currentTrig = currentTriggerMap.get(key);

      if (!currentTrig) {
        statements.push(generateCreateTriggerSQL(desiredTrig));
        Logger.info(`Creating trigger '${desiredTrig.name}' on '${desiredTrig.tableName}'`);
      } else {
        if (this.needsUpdate(desiredTrig, currentTrig)) {
          statements.push(generateDropTriggerSQL(currentTrig));
          statements.push(generateCreateTriggerSQL(desiredTrig));
          Logger.info(`Updating trigger '${desiredTrig.name}' on '${desiredTrig.tableName}'`);
        } else {
          Logger.info(`Trigger '${desiredTrig.name}' is up to date, skipping`);
        }
      }
    }

    return statements;
  }

  private needsUpdate(desired: Trigger, current: Trigger): boolean {
    return desired.timing !== current.timing ||
           desired.forEach !== current.forEach ||
           desired.functionName !== current.functionName ||
           JSON.stringify(desired.events) !== JSON.stringify(current.events);
  }
}
