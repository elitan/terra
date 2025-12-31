import type { View } from "../../../types/schema";
import {
  generateCreateViewSQL,
  generateDropViewSQL,
  generateCreateOrReplaceViewSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";

function normalizeDefinition(def: string): string {
  return def.replace(/\s+/g, ' ').trim();
}

const config: HandlerConfig<View> = {
  name: "view",
  getKey: (v) => v.name,
  generateDrop: (v) => generateDropViewSQL(v.name, v.materialized),
  generateCreate: generateCreateViewSQL,
  generateUpdate: generateCreateOrReplaceViewSQL,
  needsUpdate: (desired, current) =>
    desired.materialized !== current.materialized ||
    normalizeDefinition(desired.definition) !== normalizeDefinition(current.definition) ||
    desired.checkOption !== current.checkOption ||
    desired.securityBarrier !== current.securityBarrier,
};

export class ViewHandler {
  generateStatements(desiredViews: View[], currentViews: View[]): string[] {
    return generateStatements(desiredViews, currentViews, config);
  }
}
