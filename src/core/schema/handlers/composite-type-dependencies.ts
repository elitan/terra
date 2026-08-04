import type {
  CompositeType,
  CompositeTypeAttribute,
  CompositeTypeAttributeDependent,
  Table,
  View,
} from "../../../types/schema";

export function getCompositeTypeKey(compositeType: CompositeType): string {
  return `${compositeType.schema || "public"}.${compositeType.name}`;
}

function getBaseTypeName(type: string): string {
  return type
    .trim()
    .replace(/(?:\[[^\]]*\])+$/, "")
    .replace(/\([^)]*\)$/, "");
}

export function parseTypeReference(type: string): string[] | undefined {
  const baseType = getBaseTypeName(type);
  const parts: string[] = [];
  let part = "";
  let quoted = false;
  let partWasQuoted = false;

  for (let index = 0; index < baseType.length; index += 1) {
    const character = baseType[index];
    if (character === '"') {
      if (quoted && baseType[index + 1] === '"') {
        part += '"';
        index += 1;
        continue;
      }
      quoted = !quoted;
      partWasQuoted = true;
      continue;
    }
    if (character === "." && !quoted) {
      const value = partWasQuoted ? part : part.trim();
      if (!value) return undefined;
      parts.push(partWasQuoted ? value : value.toLowerCase());
      part = "";
      partWasQuoted = false;
      continue;
    }
    part += character;
  }

  const value = partWasQuoted ? part : part.trim();
  if (quoted || !value) return undefined;
  parts.push(partWasQuoted ? value : value.toLowerCase());
  return parts;
}

function typeReferencesComposite(
  type: string,
  compositeType: CompositeType
): boolean {
  const reference = parseTypeReference(type);
  if (!reference) return false;
  if (reference.length === 1) {
    return reference[0] === compositeType.name;
  }
  return (
    reference.length === 2 &&
    reference[0] === (compositeType.schema || "public") &&
    reference[1] === compositeType.name
  );
}

function findCompositeTypeDependency(
  attribute: CompositeTypeAttribute,
  compositeTypes: CompositeType[]
): CompositeType | undefined {
  const reference = parseTypeReference(attribute.type);
  if (!reference) return undefined;
  if (reference.length === 2) {
    return compositeTypes.find(function findQualified(candidate) {
      return (
        reference[0] === (candidate.schema || "public") &&
        reference[1] === candidate.name
      );
    });
  }
  if (reference.length !== 1) return undefined;

  const matches = compositeTypes.filter(function findUnqualified(candidate) {
    return reference[0] === candidate.name;
  });
  if (matches.length > 1) {
    throw new Error(
      `Composite attribute type '${attribute.type}' is ambiguous across desired schemas; schema-qualify it`
    );
  }
  return matches[0];
}

export function sortCompositeTypesForCreation(
  compositeTypes: CompositeType[]
): CompositeType[] {
  const keys = compositeTypes.map(getCompositeTypeKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Desired schema contains duplicate composite type names");
  }
  for (const compositeType of compositeTypes) {
    const attributeNames = compositeType.attributes.map(
      function getName(attribute) {
        return attribute.name;
      }
    );
    if (new Set(attributeNames).size !== attributeNames.length) {
      throw new Error(
        `Composite type '${compositeType.name}' contains duplicate attribute names`
      );
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const sorted: CompositeType[] = [];

  function visit(compositeType: CompositeType): void {
    const key = getCompositeTypeKey(compositeType);
    const currentState = state.get(key);
    if (currentState === "visited") return;
    if (currentState === "visiting") {
      throw new Error(
        `Composite type dependency cycle includes '${key}'; recursive composite types require a manual shell-type migration`
      );
    }

    state.set(key, "visiting");
    for (const attribute of compositeType.attributes) {
      const dependency = findCompositeTypeDependency(attribute, compositeTypes);
      if (dependency) visit(dependency);
    }
    state.set(key, "visited");
    sorted.push(compositeType);
  }

  for (const compositeType of compositeTypes) {
    visit(compositeType);
  }
  return sorted;
}

export function attributeDependentIsRetained(
  dependent: CompositeTypeAttributeDependent,
  removedType: CompositeType,
  desiredCompositeTypes: CompositeType[],
  desiredTables: Table[],
  desiredViews: View[],
  managedSchemas: string[]
): boolean {
  if (!managedSchemas.includes(dependent.schema)) return true;

  if (dependent.relationKind === "c") {
    const desiredComposite = desiredCompositeTypes.find(
      function findComposite(candidate) {
        return (
          getCompositeTypeKey(candidate) ===
          `${dependent.schema}.${dependent.relation}`
        );
      }
    );
    const desiredAttribute = desiredComposite?.attributes.find(
      function findAttribute(attribute) {
        return attribute.name === dependent.attribute;
      }
    );
    return Boolean(
      desiredAttribute &&
        typeReferencesComposite(desiredAttribute.type, removedType)
    );
  }

  if (["r", "p", "f"].includes(dependent.relationKind)) {
    const desiredTable = desiredTables.find(function findTable(table) {
      return (
        `${table.schema || "public"}.${table.name}` ===
        `${dependent.schema}.${dependent.relation}`
      );
    });
    const desiredColumn = desiredTable?.columns.find(
      function findColumn(column) {
        return column.name === dependent.attribute;
      }
    );
    return Boolean(
      desiredColumn && typeReferencesComposite(desiredColumn.type, removedType)
    );
  }

  if (["v", "m"].includes(dependent.relationKind)) {
    return desiredViews.some(function findView(view) {
      return (
        `${view.schema || "public"}.${view.name}` ===
        `${dependent.schema}.${dependent.relation}`
      );
    });
  }

  if (["i", "I"].includes(dependent.relationKind)) {
    return desiredTables.some(function tableRetainsIndex(table) {
      return (table.indexes ?? []).some(function findIndex(index) {
        return (
          `${index.schema || table.schema || "public"}.${index.name}` ===
          `${dependent.schema}.${dependent.relation}`
        );
      });
    });
  }

  return true;
}
