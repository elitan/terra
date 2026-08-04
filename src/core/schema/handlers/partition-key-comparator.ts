import type {
  PartitionKeyOperatorClass,
  QualifiedName,
  Table,
} from "../../../types/schema";
import {
  collationsAreDifferent,
  normalizeCollation,
} from "../../../utils/collation";
import { normalizeType } from "../../../utils/sql";
import { extractDataType } from "../parser/tables/column-parser";

type PartitionKeyElement = {
  castType?: string;
  collation?: QualifiedName;
  effectiveOperatorClass?: PartitionKeyOperatorClass;
  expression: string | undefined;
  operatorClass?: QualifiedName;
  uncastExpression?: string;
};

export type PartitionKey = {
  elements: PartitionKeyElement[];
  strategy: string;
};

const AST_LOCATION_FIELDS = new Set([
  "location",
  "list_start",
  "list_end",
  "rexpr_list_start",
  "rexpr_list_end",
]);

function serializeExpression(value: unknown): string | undefined {
  return JSON.stringify(value);
}

function getQualifiedName(nodes: any[] | undefined): QualifiedName | undefined {
  const parts = (nodes || [])
    .map(function getNamePart(node) {
      return node?.String?.sval;
    })
    .filter(function hasNamePart(value): value is string {
      return typeof value === "string" && value.length > 0;
    });
  const name = parts.at(-1);
  if (!name) {
    return undefined;
  }
  const schema = parts.length > 1 ? parts.at(-2) : undefined;
  return {
    name,
    ...(schema && schema !== "pg_catalog" ? { schema } : {}),
  };
}

function normalizeFunctionName(nodes: any[] | undefined): unknown[] | undefined {
  const qualifiedName = getQualifiedName(nodes);
  if (!qualifiedName) {
    return nodes;
  }
  return [
    ...(qualifiedName.schema
      ? [{ String: { sval: qualifiedName.schema } }]
      : []),
    { String: { sval: qualifiedName.name } },
  ];
}

function getColumnReferenceName(node: any): string | undefined {
  const fields = node?.ColumnRef?.fields;
  if (!Array.isArray(fields) || fields.length !== 1) {
    return undefined;
  }
  return fields[0]?.String?.sval;
}

function castMatchesColumn(typeCast: any, table: Table): boolean {
  const columnName = getColumnReferenceName(typeCast?.arg);
  const column = columnName
    ? table.columns.find(function findColumn(item) {
        return item.name === columnName;
      })
    : undefined;
  return Boolean(
    column &&
      normalizeType(extractDataType(typeCast.typeName)) ===
        normalizeType(column.type)
  );
}

function normalizePartitionExpression(node: unknown, table: Table): unknown {
  if (node === null || node === undefined || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(function normalizeArrayItem(item) {
      return normalizePartitionExpression(item, table);
    });
  }

  const object = node as Record<string, any>;
  if (object.ColumnRef) {
    const columnName = getColumnReferenceName(object);
    if (columnName) {
      return { PartitionColumn: columnName };
    }
  }
  if (object.TypeCast) {
    const typeCast = object.TypeCast;
    if (castMatchesColumn(typeCast, table)) {
      return normalizePartitionExpression(typeCast.arg, table);
    }
    return {
      TypeCast: {
        arg: normalizePartitionExpression(typeCast.arg, table),
        type: normalizeType(extractDataType(typeCast.typeName)),
      },
    };
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (AST_LOCATION_FIELDS.has(key)) {
      continue;
    }
    result[key] = normalizePartitionExpression(value, table);
  }
  if (result.FuncCall) {
    const functionCall = result.FuncCall as Record<string, any>;
    functionCall.funcname = normalizeFunctionName(functionCall.funcname);
  }
  return result;
}

function getPartitionElementExpression(
  element: any,
  table: Table
): Pick<PartitionKeyElement, "castType" | "expression" | "uncastExpression"> {
  const expression = element?.name
    ? { PartitionColumn: element.name }
    : normalizePartitionExpression(element?.expr, table);
  const typeCast = (expression as Record<string, any> | undefined)?.TypeCast;
  return {
    expression: serializeExpression(expression),
    ...(typeCast
      ? {
          castType: typeCast.type,
          uncastExpression: serializeExpression(typeCast.arg),
        }
      : {}),
  };
}

export function buildPartitionKey(
  partitionSpec: any,
  table: Table,
  operatorClasses: PartitionKeyOperatorClass[] | undefined
): PartitionKey | undefined {
  if (!partitionSpec?.strategy || !Array.isArray(partitionSpec.partParams)) {
    return undefined;
  }
  return {
    strategy: partitionSpec.strategy,
    elements: partitionSpec.partParams.map(function buildElement(
      wrapper: any,
      index: number
    ) {
      const element = wrapper?.PartitionElem;
      const collation = normalizeCollation(
        getQualifiedName(element?.collation)
      );
      const operatorClass = getQualifiedName(element?.opclass);
      return {
        ...getPartitionElementExpression(element, table),
        ...(collation ? { collation } : {}),
        ...(operatorClass ? { operatorClass } : {}),
        ...(operatorClasses?.[index]
          ? { effectiveOperatorClass: operatorClasses[index] }
          : {}),
      };
    }),
  };
}

function partitionExpressionsAreEquivalent(
  desired: PartitionKeyElement,
  current: PartitionKeyElement
): boolean {
  if (desired.expression === current.expression) {
    return true;
  }
  const currentInputType = current.effectiveOperatorClass?.inputType;
  const currentQualifiedType = currentInputType
    ? normalizeType(
        currentInputType.schema && currentInputType.schema !== "pg_catalog"
          ? `${currentInputType.schema}.${currentInputType.name}`
          : currentInputType.name
      )
    : undefined;
  const currentBareType = currentInputType
    ? normalizeType(currentInputType.name)
    : undefined;
  const desiredCastType = desired.castType
    ? normalizeType(desired.castType)
    : undefined;
  return Boolean(
    desiredCastType &&
      desired.uncastExpression === current.expression &&
      (desiredCastType === currentQualifiedType ||
        (!desired.castType?.includes(".") && desiredCastType === currentBareType))
  );
}

function qualifiedNamesAreEquivalent(
  desired: QualifiedName,
  current: QualifiedName
): boolean {
  const desiredSchema = desired.schema === "pg_catalog" ? undefined : desired.schema;
  const currentSchema = current.schema === "pg_catalog" ? undefined : current.schema;
  return (
    desired.name === current.name &&
    (desiredSchema === undefined || desiredSchema === currentSchema)
  );
}

function operatorClassesAreEquivalent(
  desired: PartitionKeyElement,
  current: PartitionKeyElement
): boolean {
  if (current.effectiveOperatorClass) {
    return desired.operatorClass
      ? qualifiedNamesAreEquivalent(
          desired.operatorClass,
          current.effectiveOperatorClass
        )
      : current.effectiveOperatorClass.isDefault;
  }
  if (!desired.operatorClass || !current.operatorClass) {
    return desired.operatorClass === current.operatorClass;
  }
  return qualifiedNamesAreEquivalent(
    desired.operatorClass,
    current.operatorClass
  );
}

export function partitionKeysAreEquivalent(
  desired: PartitionKey,
  current: PartitionKey
): boolean {
  if (
    desired.strategy !== current.strategy ||
    desired.elements.length !== current.elements.length
  ) {
    return false;
  }
  return desired.elements.every(function elementMatches(desiredElement, index) {
    const currentElement = current.elements[index]!;
    return (
      partitionExpressionsAreEquivalent(desiredElement, currentElement) &&
      !collationsAreDifferent(
        desiredElement.collation,
        currentElement.collation
      ) &&
      operatorClassesAreEquivalent(desiredElement, currentElement)
    );
  });
}
