export interface PostgresTypeIdentity {
  name: string;
  schema?: string;
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

function removeSchemaQualification(type: string): string | undefined {
  let quoted = false;
  for (let index = 0; index < type.length; index += 1) {
    const character = type[index];
    if (character === '"') {
      if (quoted && type[index + 1] === '"') {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (character === "." && !quoted) {
      return type.slice(index + 1).trim();
    }
  }
  return undefined;
}

function getTypeReferenceDecorators(type: string): string | undefined {
  const trimmed = type.trim();
  if (trimmed.startsWith('"')) {
    for (let index = 1; index < trimmed.length; index += 1) {
      if (trimmed[index] !== '"') continue;
      if (trimmed[index + 1] === '"') {
        index += 1;
        continue;
      }
      return trimmed.slice(index + 1);
    }
    return undefined;
  }

  const identifier = trimmed.match(/^[a-z_][a-z0-9_$]*/i)?.[0];
  return identifier ? trimmed.slice(identifier.length) : undefined;
}

function normalizeTypeReferenceDecorators(type: string): string | undefined {
  const decorators = getTypeReferenceDecorators(type);
  if (decorators === undefined) return undefined;
  return decorators
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([(),\[\]])\s*/g, "$1")
    .replace(/(?:\[(?:\d*)\])+$/, "[]")
    .toUpperCase();
}

export function qualifiedTypeReferenceMatchesCatalogIdentity(
  desiredType: string,
  currentType: string,
  currentTypeSchema: string | undefined
): boolean {
  if (!currentTypeSchema) return false;

  const desiredReference = parseTypeReference(desiredType);
  const currentReference = parseTypeReference(currentType);
  if (
    desiredReference?.length !== 2 ||
    !currentReference ||
    currentReference.length > 2 ||
    desiredReference[0] !== currentTypeSchema ||
    desiredReference[1] !== currentReference[currentReference.length - 1]
  ) {
    return false;
  }
  if (
    currentReference.length === 2 &&
    currentReference[0] !== currentTypeSchema
  ) {
    return false;
  }

  const unqualifiedDesired = removeSchemaQualification(desiredType);
  const unqualifiedCurrent = currentReference.length === 2
    ? removeSchemaQualification(currentType)
    : currentType;
  if (!unqualifiedDesired || !unqualifiedCurrent) return false;

  return (
    normalizeTypeReferenceDecorators(unqualifiedDesired) ===
    normalizeTypeReferenceDecorators(unqualifiedCurrent)
  );
}

export function typeReferenceMatches(
  type: string,
  target: PostgresTypeIdentity
): boolean {
  const reference = parseTypeReference(type.replace(/^SETOF\s+/i, ""));
  if (!reference) return false;
  if (reference.length === 1) {
    return reference[0] === target.name;
  }
  return (
    reference.length === 2 &&
    reference[0] === (target.schema || "public") &&
    reference[1] === target.name
  );
}
