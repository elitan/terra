import type {
  CheckConstraint,
  Column,
  ExclusionConstraint,
  Table,
  UniqueConstraint,
} from "../../../types/schema";
import { collationsAreDifferent } from "../../../utils/collation";
import { expressionsEqual } from "../../../utils/expression-comparator";
import { identityColumnsAreDifferent } from "../../../utils/identity";
import { normalizeDefault, normalizeType } from "../../../utils/sql";

export type PartitionParent = {
  definition: string;
  table: Table;
};

function stableSerialize(value: unknown): string | undefined {
  function normalize(item: unknown): unknown {
    if (Array.isArray(item)) {
      return item.map(normalize);
    }
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .sort(function sortEntry(left, right) {
            return left[0].localeCompare(right[0]);
          })
          .map(function normalizeEntry(entry) {
            return [entry[0], normalize(entry[1])];
          })
      );
    }
    return item;
  }

  return JSON.stringify(normalize(value));
}

function defaultsAreEquivalent(
  desired: string | undefined,
  current: string | undefined
): boolean {
  const normalizedDesired = normalizeDefault(desired);
  const normalizedCurrent = normalizeDefault(current);
  if (normalizedDesired === normalizedCurrent) {
    return true;
  }
  return Boolean(
    normalizedDesired &&
      normalizedCurrent &&
      expressionsEqual(normalizedDesired, normalizedCurrent)
  );
}

function generatedColumnsAreEquivalent(
  desired: Column["generated"],
  current: Column["generated"]
): boolean {
  if (!desired || !current) {
    return desired === current;
  }
  return (
    desired.always === current.always &&
    desired.stored === current.stored &&
    expressionsEqual(desired.expression, current.expression)
  );
}

function partitionColumnsAreEquivalent(
  desired: Column,
  current: Column
): boolean {
  return (
    desired.name === current.name &&
    normalizeType(desired.type) === normalizeType(current.type) &&
    desired.nullable === current.nullable &&
    defaultsAreEquivalent(desired.default, current.default) &&
    !collationsAreDifferent(desired.collation, current.collation) &&
    !identityColumnsAreDifferent(desired.identity, current.identity) &&
    generatedColumnsAreEquivalent(desired.generated, current.generated)
  );
}

function sortConstraintsByName<T extends { name?: string }>(
  constraints: T[] | undefined
): T[] {
  return [...(constraints || [])].sort(function sortConstraint(left, right) {
    return (left.name || "").localeCompare(right.name || "");
  });
}

function checkConstraintsAreEquivalent(
  desired: CheckConstraint[] | undefined,
  current: CheckConstraint[] | undefined
): boolean {
  const desiredConstraints = sortConstraintsByName(desired);
  const currentConstraints = sortConstraintsByName(current);
  if (desiredConstraints.length !== currentConstraints.length) {
    return false;
  }

  return desiredConstraints.every(function constraintMatches(desiredConstraint, index) {
    const currentConstraint = currentConstraints[index]!;
    const desiredOptions = { ...desiredConstraint, expression: undefined };
    const currentOptions = { ...currentConstraint, expression: undefined };
    return (
      stableSerialize(desiredOptions) === stableSerialize(currentOptions) &&
      expressionsEqual(desiredConstraint.expression, currentConstraint.expression)
    );
  });
}

function namedConstraintsAreEquivalent<
  T extends UniqueConstraint | ExclusionConstraint,
>(desired: T[] | undefined, current: T[] | undefined): boolean {
  return (
    stableSerialize(sortConstraintsByName(desired)) ===
    stableSerialize(sortConstraintsByName(current))
  );
}

export function partitionParentsAreEquivalent(
  desired: PartitionParent | undefined,
  current: PartitionParent | undefined
): boolean {
  if (!desired || !current || desired.definition !== current.definition) {
    return false;
  }
  if (desired.table.columns.length !== current.table.columns.length) {
    return false;
  }
  if (
    !desired.table.columns.every(function columnMatches(desiredColumn, index) {
      const currentColumn = current.table.columns[index];
      return Boolean(
        currentColumn && partitionColumnsAreEquivalent(desiredColumn, currentColumn)
      );
    })
  ) {
    return false;
  }

  return (
    stableSerialize(desired.table.primaryKey) ===
      stableSerialize(current.table.primaryKey) &&
    checkConstraintsAreEquivalent(
      desired.table.checkConstraints,
      current.table.checkConstraints
    ) &&
    namedConstraintsAreEquivalent(
      desired.table.uniqueConstraints,
      current.table.uniqueConstraints
    ) &&
    namedConstraintsAreEquivalent(
      desired.table.exclusionConstraints,
      current.table.exclusionConstraints
    )
  );
}
