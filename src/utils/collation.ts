import type { QualifiedName } from "../types/schema";

export const DEFAULT_COLLATION: QualifiedName = { name: "default" };

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isDefaultCollation(collation: QualifiedName | undefined): boolean {
  if (!collation || collation.name !== "default") return false;
  return !collation.schema || collation.schema === "pg_catalog";
}

export function normalizeCollation(
  collation: QualifiedName | undefined
): QualifiedName | undefined {
  return isDefaultCollation(collation) ? undefined : collation;
}

export function renderCollationName(collation: QualifiedName): string {
  const name = quoteIdentifier(collation.name);
  if (!collation.schema) return name;
  return `${quoteIdentifier(collation.schema)}.${name}`;
}

export function collationsAreDifferent(
  desired: QualifiedName | undefined,
  current: QualifiedName | undefined
): boolean {
  const normalizedDesired = normalizeCollation(desired);
  const normalizedCurrent = normalizeCollation(current);
  if (!normalizedDesired || !normalizedCurrent) {
    return normalizedDesired !== normalizedCurrent;
  }
  if (normalizedDesired.name !== normalizedCurrent.name) return true;
  return (
    normalizedDesired.schema !== undefined &&
    normalizedDesired.schema !== normalizedCurrent.schema
  );
}

export function getAlterColumnCollation(
  desired: QualifiedName | undefined,
  current: QualifiedName | undefined,
  typeIsChanging: boolean
): QualifiedName | undefined {
  const normalizedDesired = normalizeCollation(desired);
  if (normalizedDesired) return normalizedDesired;
  if (!typeIsChanging && collationsAreDifferent(desired, current)) {
    return DEFAULT_COLLATION;
  }
  return undefined;
}
