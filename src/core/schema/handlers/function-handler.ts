import type { Function } from "../../../types/schema";
import {
  generateCreateFunctionSQL,
  generateCreateOrReplaceFunctionSQL,
  generateDropFunctionSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";
import {
  assertRoutineHasNoDependents,
  normalizeRoutineType,
  retainBlockingRoutineDependents,
  routineConfigurationsEqual,
  routineParametersCanBeReplaced,
} from "./routine-handler-utils";
import { getDefaultFunctionCost } from "../../../utils/function-cost";

function normalizeBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function normalizeVolatility(v: Function['volatility']): string {
  return v || 'VOLATILE';
}

function normalizeParallel(p: Function['parallel']): string {
  return p || 'UNSAFE';
}

function normalizeLeakproof(value: Function['leakproof']): boolean {
  return Boolean(value);
}

function normalizeSecurityDefiner(value: Function['securityDefiner']): boolean {
  return Boolean(value);
}

function normalizeStrict(value: Function['strict']): boolean {
  return Boolean(value);
}

function normalizeCost(value: Function['cost'], language: string): number {
  return value ?? getDefaultFunctionCost(language);
}

function normalizeRows(value: Function['rows'], returnType: string): number | undefined {
  if (!normalizeRoutineType(returnType).toUpperCase().startsWith("SETOF ")) {
    return undefined;
  }

  return value ?? 1000;
}

function normalizeParameterMode(mode: Function["parameters"][number]["mode"]): string {
  if (!mode || mode === "IN") {
    return "IN";
  }

  return mode;
}

function isIdentityParameterMode(mode: Function["parameters"][number]["mode"]): boolean {
  return normalizeParameterMode(mode) !== "OUT";
}

function getFunctionSignature(func: Function): string {
  return func.parameters
    .filter(function (param) {
      return isIdentityParameterMode(param.mode);
    })
    .map(function (param) {
      return normalizeRoutineType(param.type);
    })
    .join(",");
}

function normalizeFunctionParameters(
  func: Function
): Array<{ name?: string; mode: string; type: string; default?: string }> {
  return func.parameters.map(function (param) {
    return {
      name: param.name || undefined,
      mode: normalizeParameterMode(param.mode),
      type: normalizeRoutineType(param.type),
      default: normalizeParameterDefault(param.default),
    };
  });
}

function normalizeParameterDefault(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .replace(
      /::\s*(?:"[^"]+"|[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)(?:\s+[a-z_][a-z0-9_]*)*(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?(?:\[\])*/gi,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
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

function functionCanBeReplaced(desired: Function, current: Function): boolean {
  if (
    normalizeRoutineType(desired.returnType) !==
    normalizeRoutineType(current.returnType)
  ) {
    return false;
  }
  return routineParametersCanBeReplaced(
    desired.parameters,
    current.parameters,
    normalizeRoutineType,
    normalizeParameterMode
  );
}

function generateFunctionDrop(current: Function): string {
  assertRoutineHasNoDependents(
    "function",
    getFunctionKey(current),
    current.dependentObjects
  );
  return generateDropFunctionSQL(current);
}

function generateFunctionUpdate(
  desired: Function,
  current: Function
): string | string[] {
  if (functionCanBeReplaced(desired, current)) {
    return generateCreateOrReplaceFunctionSQL(desired);
  }
  return [
    generateFunctionDrop(current),
    generateCreateFunctionSQL(desired),
  ];
}

const config: HandlerConfig<Function> = {
  name: "function",
  getKey: getFunctionKey,
  generateDrop: generateFunctionDrop,
  generateCreate: generateCreateFunctionSQL,
  generateUpdate: generateFunctionUpdate,
  needsUpdate: function functionNeedsUpdate(desired, current) {
    return JSON.stringify(normalizeFunctionParameters(desired)) !==
      JSON.stringify(normalizeFunctionParameters(current)) ||
    normalizeBody(desired.body) !== normalizeBody(current.body) ||
    normalizeRoutineType(desired.returnType) !== normalizeRoutineType(current.returnType) ||
    desired.language !== current.language ||
    normalizeVolatility(desired.volatility) !== normalizeVolatility(current.volatility) ||
    normalizeParallel(desired.parallel) !== normalizeParallel(current.parallel) ||
    normalizeLeakproof(desired.leakproof) !==
      normalizeLeakproof(current.leakproof) ||
    normalizeSecurityDefiner(desired.securityDefiner) !==
      normalizeSecurityDefiner(current.securityDefiner) ||
    normalizeStrict(desired.strict) !== normalizeStrict(current.strict) ||
    normalizeCost(desired.cost, desired.language) !==
      normalizeCost(current.cost, current.language) ||
    normalizeRows(desired.rows, desired.returnType) !==
      normalizeRows(current.rows, current.returnType) ||
    !routineConfigurationsEqual(
      desired.configuration,
      current.configuration
    );
  },
};

export class FunctionHandler {
  generateStatements(
    desiredFunctions: Function[],
    currentFunctions: Function[],
    plannedDependentRemovals: ReadonlySet<string> = new Set()
  ): string[] {
    const current = retainBlockingRoutineDependents(
      currentFunctions,
      plannedDependentRemovals
    );
    return generateStatements(dedupeFunctions(desiredFunctions), current, config);
  }
}
