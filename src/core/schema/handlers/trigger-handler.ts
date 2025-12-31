import type { Trigger } from "../../../types/schema";
import {
  generateCreateTriggerSQL,
  generateDropTriggerSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";

const config: HandlerConfig<Trigger> = {
  name: "trigger",
  getKey: (t) => `${t.tableName}.${t.name}`,
  getLogName: (t) => `${t.name}' on '${t.tableName}`,
  generateDrop: generateDropTriggerSQL,
  generateCreate: generateCreateTriggerSQL,
  needsUpdate: (desired, current) =>
    desired.timing !== current.timing ||
    desired.forEach !== current.forEach ||
    desired.functionName !== current.functionName ||
    JSON.stringify(desired.events) !== JSON.stringify(current.events),
};

export class TriggerHandler {
  generateStatements(desiredTriggers: Trigger[], currentTriggers: Trigger[]): string[] {
    return generateStatements(desiredTriggers, currentTriggers, config);
  }
}
