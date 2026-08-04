import type { Procedure } from "../../../types/schema";
import {
  generateCreateProcedureSQL,
  generateCreateOrReplaceProcedureSQL,
  generateDropProcedureSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";
import {
  assertRoutineHasNoDependents,
  normalizeRoutineType,
  retainBlockingRoutineDependents,
  routineConfigurationsEqual,
  routineParametersCanBeReplaced,
} from "./routine-handler-utils";

function normalizeBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function normalizeParameterMode(mode: Procedure["parameters"][number]["mode"]): string {
  if (!mode || mode === "IN") {
    return "IN";
  }

  return mode;
}

function isIdentityParameterMode(mode: Procedure["parameters"][number]["mode"]): boolean {
  return normalizeParameterMode(mode) !== "OUT";
}

function getProcedureSignature(proc: Procedure): string {
  return proc.parameters
    .filter(function (param) {
      return isIdentityParameterMode(param.mode);
    })
    .map(function (param) {
      return normalizeRoutineType(param.type);
    })
    .join(",");
}

function normalizeProcedureParameters(
  proc: Procedure
): Array<{ name?: string; mode: string; type: string; default?: string }> {
  return proc.parameters.map(function (param) {
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

function getProcedureKey(proc: Procedure): string {
  return `${proc.schema || "public"}.${proc.name}(${getProcedureSignature(proc)})`;
}

function normalizeSecurityDefiner(value: Procedure['securityDefiner']): boolean {
  return Boolean(value);
}

function procedureCanBeReplaced(
  desired: Procedure,
  current: Procedure
): boolean {
  return routineParametersCanBeReplaced(
    desired.parameters,
    current.parameters,
    normalizeRoutineType,
    normalizeParameterMode
  );
}

function generateProcedureDrop(current: Procedure): string {
  assertRoutineHasNoDependents(
    "procedure",
    getProcedureKey(current),
    current.dependentObjects
  );
  return generateDropProcedureSQL(current);
}

function generateProcedureUpdate(
  desired: Procedure,
  current: Procedure
): string | string[] {
  if (procedureCanBeReplaced(desired, current)) {
    return generateCreateOrReplaceProcedureSQL(desired);
  }
  return [
    generateProcedureDrop(current),
    generateCreateProcedureSQL(desired),
  ];
}

const config: HandlerConfig<Procedure> = {
  name: "procedure",
  getKey: getProcedureKey,
  generateDrop: generateProcedureDrop,
  generateCreate: generateCreateProcedureSQL,
  generateUpdate: generateProcedureUpdate,
  needsUpdate: function procedureNeedsUpdate(desired, current) {
    return JSON.stringify(normalizeProcedureParameters(desired)) !==
      JSON.stringify(normalizeProcedureParameters(current)) ||
    normalizeBody(desired.body) !== normalizeBody(current.body) ||
    desired.language !== current.language ||
    normalizeSecurityDefiner(desired.securityDefiner) !==
      normalizeSecurityDefiner(current.securityDefiner) ||
    !routineConfigurationsEqual(
      desired.configuration,
      current.configuration
    );
  },
};

export class ProcedureHandler {
  generateStatements(
    desiredProcedures: Procedure[],
    currentProcedures: Procedure[],
    plannedDependentRemovals: ReadonlySet<string> = new Set()
  ): string[] {
    const current = retainBlockingRoutineDependents(
      currentProcedures,
      plannedDependentRemovals
    );
    return generateStatements(desiredProcedures, current, config);
  }
}
