import type { Function } from "../../../types/schema";
import {
  generateCreateFunctionSQL,
  generateDropFunctionSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";

function normalizeBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function normalizeVolatility(v: Function['volatility']): string {
  return v || 'VOLATILE';
}

function normalizeParallel(p: Function['parallel']): string {
  return p || 'UNSAFE';
}

function normalizeType(type: string): string {
  const normalized = type.replace(/\s+/g, " ").trim().replace(/^pg_catalog\./i, "");
  const setOfMatch = normalized.match(/^setof\s+(.+)$/i);
  if (setOfMatch) {
    return `SETOF ${normalizeType(setOfMatch[1])}`;
  }

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

function normalizeParameterType(type: string): string {
  return normalizeType(type);
}

function normalizeReturnType(type: string): string {
  return normalizeType(type);
}

function getFunctionSignature(func: Function): string {
  return func.parameters.map(function (param) {
    return normalizeParameterType(param.type);
  }).join(",");
}

function getFunctionKey(func: Function): string {
  return `${func.schema || "public"}.${func.name}(${getFunctionSignature(func)})`;
}

const config: HandlerConfig<Function> = {
  name: "function",
  getKey: getFunctionKey,
  generateDrop: generateDropFunctionSQL,
  generateCreate: generateCreateFunctionSQL,
  needsUpdate: (desired, current) =>
    normalizeBody(desired.body) !== normalizeBody(current.body) ||
    normalizeReturnType(desired.returnType) !== normalizeReturnType(current.returnType) ||
    desired.language !== current.language ||
    normalizeVolatility(desired.volatility) !== normalizeVolatility(current.volatility) ||
    normalizeParallel(desired.parallel) !== normalizeParallel(current.parallel),
};

export class FunctionHandler {
  generateStatements(desiredFunctions: Function[], currentFunctions: Function[]): string[] {
    return generateStatements(desiredFunctions, currentFunctions, config);
  }
}
