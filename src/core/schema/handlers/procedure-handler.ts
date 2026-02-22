import type { Procedure } from "../../../types/schema";
import {
  generateCreateProcedureSQL,
  generateDropProcedureSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";

function normalizeBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function normalizeParameterType(type: string): string {
  return type.replace(/\s+/g, " ").trim();
}

function getProcedureSignature(proc: Procedure): string {
  return proc.parameters.map(function (param) {
    return normalizeParameterType(param.type);
  }).join(",");
}

function getProcedureKey(proc: Procedure): string {
  return `${proc.schema || "public"}.${proc.name}(${getProcedureSignature(proc)})`;
}

const config: HandlerConfig<Procedure> = {
  name: "procedure",
  getKey: getProcedureKey,
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
