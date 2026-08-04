import type { FunctionParameter } from "../../../types/schema";

export function routineParameterIdentitiesEqual(
  desired: FunctionParameter[],
  current: FunctionParameter[],
  normalizeType: (type: string) => string,
  normalizeMode: (mode: FunctionParameter["mode"]) => string
): boolean {
  function normalizeParameter(parameter: FunctionParameter): {
    name: string | undefined;
    mode: string;
    type: string;
  } {
    return {
      name: parameter.name,
      mode: normalizeMode(parameter.mode),
      type: normalizeType(parameter.type),
    };
  }

  return JSON.stringify(desired.map(normalizeParameter)) ===
    JSON.stringify(current.map(normalizeParameter));
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
