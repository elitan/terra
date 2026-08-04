import type {
  CompositeType,
  EnumType,
  Function,
  Procedure,
  SqlObject,
  Table,
} from "../../../types/schema";
import { ParserError } from "../../../types/errors";

type RoutineTypeCanonicalizationInput = {
  tables: Table[];
  enums: EnumType[];
  compositeTypes: CompositeType[];
  sqlObjects: SqlObject[];
  functions: Function[];
  procedures: Procedure[];
  filePath?: string;
};

function renderTypeIdentifier(value: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function collectDeclaredTypeCandidates(
  input: RoutineTypeCanonicalizationInput
): Map<string, Set<string>> {
  const candidates = new Map<string, Set<string>>();
  const declaredTypes = [
    ...input.tables,
    ...input.enums,
    ...input.compositeTypes,
    ...input.sqlObjects.filter(function isStructuredType(sqlObject) {
      return sqlObject.kind === "domain-type" || sqlObject.kind === "range-type";
    }),
  ];

  for (const declaredType of declaredTypes) {
    const name = renderTypeIdentifier(declaredType.name);
    const schema = renderTypeIdentifier(declaredType.schema || "public");
    const matches = candidates.get(name) || new Set<string>();
    matches.add(`${schema}.${name}`);
    candidates.set(name, matches);
  }

  return candidates;
}

function qualifyRoutineType(
  type: string,
  candidates: Map<string, Set<string>>,
  filePath?: string
): string {
  const setOfPrefix = /^setof\s+/i.test(type) ? "SETOF " : "";
  const withoutSetOf = setOfPrefix ? type.replace(/^setof\s+/i, "") : type;
  const arraySuffix = withoutSetOf.match(/(\[[^\]]*\])+$/)?.[0] || "";
  const baseType = arraySuffix
    ? withoutSetOf.slice(0, -arraySuffix.length).trim()
    : withoutSetOf.trim();
  const matches = candidates.get(baseType);
  if (!matches || matches.size === 0) {
    return type;
  }
  if (matches.size > 1) {
    throw new ParserError(
      `PostgreSQL routine type ${baseType} is ambiguous across desired schemas (${Array.from(matches).sort().join(", ")}); schema-qualify the routine type`,
      filePath
    );
  }

  return `${setOfPrefix}${matches.values().next().value}${arraySuffix}`;
}

export function qualifyDeclaredRoutineTypes(
  input: RoutineTypeCanonicalizationInput
): void {
  const candidates = collectDeclaredTypeCandidates(input);

  for (const routine of input.functions) {
    for (const parameter of routine.parameters) {
      parameter.type = qualifyRoutineType(
        parameter.type,
        candidates,
        input.filePath
      );
    }
    routine.returnType = qualifyRoutineType(
      routine.returnType,
      candidates,
      input.filePath
    );
  }

  for (const routine of input.procedures) {
    for (const parameter of routine.parameters) {
      parameter.type = qualifyRoutineType(
        parameter.type,
        candidates,
        input.filePath
      );
    }
  }
}
