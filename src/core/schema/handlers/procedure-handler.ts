import type { Procedure } from "../../../types/schema";
import {
  generateCreateProcedureSQL,
  generateDropProcedureSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";

function normalizeBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

const config: HandlerConfig<Procedure> = {
  name: "procedure",
  getKey: (p) => p.name,
  generateDrop: generateDropProcedureSQL,
  generateCreate: generateCreateProcedureSQL,
  needsUpdate: (desired, current) =>
    normalizeBody(desired.body) !== normalizeBody(current.body) ||
    desired.language !== current.language,
};

export class ProcedureHandler {
  generateStatements(desiredProcedures: Procedure[], currentProcedures: Procedure[]): string[] {
    return generateStatements(desiredProcedures, currentProcedures, config);
  }
}
