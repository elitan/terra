import type { Function } from "../../../types/schema";
import {
  generateCreateFunctionSQL,
  generateDropFunctionSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";

function normalizeBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

const config: HandlerConfig<Function> = {
  name: "function",
  getKey: (f) => f.name,
  generateDrop: generateDropFunctionSQL,
  generateCreate: generateCreateFunctionSQL,
  needsUpdate: (desired, current) =>
    normalizeBody(desired.body) !== normalizeBody(current.body) ||
    desired.returnType !== current.returnType ||
    desired.language !== current.language ||
    desired.volatility !== current.volatility,
};

export class FunctionHandler {
  generateStatements(desiredFunctions: Function[], currentFunctions: Function[]): string[] {
    return generateStatements(desiredFunctions, currentFunctions, config);
  }
}
