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

function normalizeParameterType(type: string): string {
  return type.replace(/\s+/g, " ").trim();
}

function getFunctionSignature(func: Function): string {
  return func.parameters.map(function (param) {
    return normalizeParameterType(param.type);
  }).join(",");
}

function getFunctionKey(func: Function): string {
  return `${func.schema || "public"}.${func.name}(${getFunctionSignature(func)})`;
}

function dedupeFunctions(functions: Function[]): Function[] {
  const deduped = new Map<string, Function>();

  for (const func of functions) {
    const key = getFunctionKey(func);
    if (deduped.has(key)) {
      deduped.delete(key);
    }
    deduped.set(key, func);
  }

  return Array.from(deduped.values());
}

const config: HandlerConfig<Function> = {
  name: "function",
  getKey: getFunctionKey,
  generateDrop: generateDropFunctionSQL,
  generateCreate: generateCreateFunctionSQL,
  needsUpdate: (desired, current) =>
    normalizeBody(desired.body) !== normalizeBody(current.body) ||
    desired.returnType !== current.returnType ||
    desired.language !== current.language ||
    normalizeVolatility(desired.volatility) !== normalizeVolatility(current.volatility) ||
    normalizeParallel(desired.parallel) !== normalizeParallel(current.parallel),
};

export class FunctionHandler {
  generateStatements(desiredFunctions: Function[], currentFunctions: Function[]): string[] {
    return generateStatements(dedupeFunctions(desiredFunctions), currentFunctions, config);
  }
}
