import type { FunctionParameter } from "../../../types/schema";
import { ValidationError } from "../../../types/errors";

const ROUTINE_TYPE_ALIASES: Record<string, string> = {
  "timestamp with time zone": "timestamptz",
  timestamptz: "timestamptz",
  "timestamp without time zone": "timestamp",
  timestamp: "timestamp",
  "time with time zone": "timetz",
  timetz: "timetz",
  "time without time zone": "time",
  time: "time",
};

export function normalizeRoutineType(type: string): string {
  const normalized = type
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^pg_catalog\./i, "");
  const setOfType = normalized.match(/^setof\s+(.+)$/i)?.[1];
  if (setOfType) {
    return `SETOF ${normalizeRoutineType(setOfType)}`;
  }

  const arraySuffix = normalized.match(/(\[[^\]]*\])+$/)?.[0];
  const baseType = arraySuffix
    ? normalized.slice(0, -arraySuffix.length).trim()
    : normalized;
  const canonical = ROUTINE_TYPE_ALIASES[baseType.toLowerCase()] || baseType;
  return `${canonical}${arraySuffix ? "[]" : ""}`;
}

export function routineParametersCanBeReplaced(
  desired: FunctionParameter[],
  current: FunctionParameter[],
  normalizeType: (type: string) => string,
  normalizeMode: (mode: FunctionParameter["mode"]) => string
): boolean {
  if (desired.length !== current.length) {
    return false;
  }

  return desired.every(function parameterCanBeReplaced(parameter, index) {
    const currentParameter = current[index];
    if (!currentParameter) {
      return false;
    }

    const mode = normalizeMode(parameter.mode);
    if (
      mode !== normalizeMode(currentParameter.mode) ||
      normalizeType(parameter.type) !== normalizeType(currentParameter.type)
    ) {
      return false;
    }

    const desiredName = parameter.name || undefined;
    const currentName = currentParameter.name || undefined;
    return desiredName === currentName ||
      (currentName === undefined && desiredName !== undefined && mode !== "OUT");
  });
}

export function assertRoutineHasNoDependents(
  kind: "function" | "procedure",
  identity: string,
  dependentObjects: string[] | undefined
): void {
  if (!dependentObjects || dependentObjects.length === 0) {
    return;
  }

  throw new ValidationError(
    `Cannot drop or recreate PostgreSQL ${kind} ${identity} because dependent objects would be removed: ${dependentObjects.join(", ")}. Remove those dependents in a separate apply before changing or removing the routine`,
    `${kind} ${identity}`,
    "dependentObjects",
    dependentObjects
  );
}

export function retainBlockingRoutineDependents<
  T extends { dependentObjects?: string[] }
>(routines: T[], plannedRemovals: ReadonlySet<string>): T[] {
  if (plannedRemovals.size === 0) {
    return routines;
  }

  return routines.map(function retainBlockingDependents(routine) {
    const dependentObjects = routine.dependentObjects?.filter(
      function isNotPlannedForRemoval(description) {
        return !plannedRemovals.has(description);
      }
    );
    return {
      ...routine,
      dependentObjects: dependentObjects && dependentObjects.length > 0
        ? dependentObjects
        : undefined,
    };
  });
}

export function routineConfigurationsEqual(
  desired: Record<string, string> | undefined,
  current: Record<string, string> | undefined
): boolean {
  const desiredEntries = Object.entries(desired || {}).sort(function sortByName(
    first,
    second
  ) {
    return first[0].localeCompare(second[0]);
  });
  const currentEntries = Object.entries(current || {}).sort(function sortByName(
    first,
    second
  ) {
    return first[0].localeCompare(second[0]);
  });
  return desiredEntries.length === currentEntries.length &&
    desiredEntries.every(function hasSameEntry(entry, index) {
      return entry[0] === currentEntries[index]?.[0] &&
        entry[1] === currentEntries[index]?.[1];
    });
}
