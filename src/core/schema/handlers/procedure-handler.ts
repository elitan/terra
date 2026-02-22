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
  const normalized = type.replace(/\s+/g, " ").trim().replace(/^pg_catalog\./i, "");
  const arraySuffixMatch = normalized.match(/(\[\])+$/);
  const arraySuffix = arraySuffixMatch ? arraySuffixMatch[0] : "";
  const baseType = arraySuffix ? normalized.slice(0, -arraySuffix.length).trim() : normalized;
  const lowerType = baseType.toLowerCase();

  const aliases: Record<string, string> = {
    "timestamp with time zone": "timestamptz",
    timestamptz: "timestamptz",
    "timestamp without time zone": "timestamp",
    timestamp: "timestamp",
    "time with time zone": "timetz",
    timetz: "timetz",
    "time without time zone": "time",
    time: "time",
  };

  const canonical = aliases[lowerType] || baseType;
  return `${canonical}${arraySuffix}`;
}

function getProcedureSignature(proc: Procedure): string {
  return proc.parameters.map(function (param) {
    return normalizeParameterType(param.type);
  }).join(",");
}

function getProcedureKey(proc: Procedure): string {
  return `${proc.schema || "public"}.${proc.name}(${getProcedureSignature(proc)})`;
}

function normalizeSecurityDefiner(value: Procedure['securityDefiner']): boolean {
  return Boolean(value);
}

const config: HandlerConfig<Procedure> = {
  name: "procedure",
  getKey: getProcedureKey,
  generateDrop: generateDropProcedureSQL,
  generateCreate: generateCreateProcedureSQL,
  needsUpdate: (desired, current) =>
    normalizeBody(desired.body) !== normalizeBody(current.body) ||
    desired.language !== current.language ||
    normalizeSecurityDefiner(desired.securityDefiner) !==
      normalizeSecurityDefiner(current.securityDefiner),
};

export class ProcedureHandler {
  generateStatements(desiredProcedures: Procedure[], currentProcedures: Procedure[]): string[] {
    return generateStatements(desiredProcedures, currentProcedures, config);
  }
}
