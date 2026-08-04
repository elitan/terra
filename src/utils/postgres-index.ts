import type { Index, IndexTerm, QualifiedName } from "../types/schema";

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed;
}

function splitQualifiedName(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let position = 0; position < value.length; position++) {
    const character = value[position]!;
    if (character === '"') {
      current += character;
      if (quoted && value[position + 1] === '"') {
        current += value[position + 1];
        position++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === "." && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function qualifiedNameFromLegacy(
  value: string | undefined
): QualifiedName | undefined {
  if (!value) {
    return undefined;
  }
  const parts = splitQualifiedName(value).map(unquoteIdentifier);
  const name = parts.at(-1);
  if (!name) {
    return undefined;
  }
  const schema = parts.length > 1 ? parts.at(-2) : undefined;
  return schema ? { name, schema } : { name };
}

export function getPostgresIndexTerms(index: Index): IndexTerm[] {
  if (index.terms) {
    return index.terms;
  }
  if (index.expression) {
    const order = index.sortOrders?.[0] || "ASC";
    const opclass = qualifiedNameFromLegacy(index.expressionOpclass);
    return [{
      expression: index.expression,
      ...(index.collations?.[0] ? { collation: index.collations[0] } : {}),
      ...(opclass ? { opclass } : {}),
      order,
      nullsOrder: index.nullsOrders?.[0] ||
        (order === "DESC" ? "FIRST" : "LAST"),
      ...(index.expressionStatisticsTarget === undefined
        ? {}
        : { statisticsTarget: index.expressionStatisticsTarget }),
    }];
  }
  return index.columns.map(function getColumnTerm(column, position) {
    const order = index.sortOrders?.[position] || "ASC";
    const opclass = qualifiedNameFromLegacy(index.opclasses?.[column]);
    return {
      column,
      ...(index.collations?.[position]
        ? { collation: index.collations[position] }
        : {}),
      ...(opclass ? { opclass } : {}),
      order,
      nullsOrder: index.nullsOrders?.[position] ||
        (order === "DESC" ? "FIRST" : "LAST"),
    };
  });
}

export function synchronizeLegacyIndexFields(index: Index): void {
  const terms = index.terms || [];
  index.columns = terms.flatMap(function getColumn(term) {
    return term.column === undefined ? [] : [term.column];
  });

  const collations = terms.map(function getCollation(term) {
    return typeof term.collation === "object" ? term.collation : undefined;
  });
  if (collations.some(Boolean)) {
    index.collations = collations;
  } else {
    delete index.collations;
  }

  const sortOrders = terms.map(function getSortOrder(term) {
    return term.order || "ASC";
  });
  index.sortOrders = sortOrders.some(function hasDescending(order) {
    return order === "DESC";
  }) ? sortOrders : undefined;

  const nullsOrders = terms.map(function getNullsOrder(term, position) {
    const order = sortOrders[position] || "ASC";
    return term.nullsOrder || (order === "DESC" ? "FIRST" : "LAST");
  });
  index.nullsOrders = nullsOrders.some(function hasNonDefault(order, position) {
    const defaultOrder = sortOrders[position] === "DESC" ? "FIRST" : "LAST";
    return order !== defaultOrder;
  }) ? nullsOrders : undefined;

  let opclasses: Record<string, string> | undefined;
  for (const term of terms) {
    if (!term.column || !term.opclass || term.opclassDefault) {
      continue;
    }
    if (!opclasses) {
      opclasses = {};
    }
    opclasses[term.column] = term.opclass.schema
      ? `${term.opclass.schema}.${term.opclass.name}`
      : term.opclass.name;
  }
  index.opclasses = opclasses;

  const singleExpression = terms.length === 1 ? terms[0] : undefined;
  if (singleExpression?.expression) {
    index.expression = singleExpression.expression;
    if (singleExpression.opclass && !singleExpression.opclassDefault) {
      index.expressionOpclass = singleExpression.opclass.name;
    } else {
      delete index.expressionOpclass;
    }
    if (singleExpression.statisticsTarget === undefined) {
      delete index.expressionStatisticsTarget;
    } else {
      index.expressionStatisticsTarget = singleExpression.statisticsTarget;
    }
  } else {
    index.expression = undefined;
    delete index.expressionOpclass;
    delete index.expressionStatisticsTarget;
  }
}

export function getIndexTermCollation(
  term: IndexTerm
): QualifiedName | undefined {
  if (!term.collation) {
    return undefined;
  }
  return typeof term.collation === "string"
    ? { name: term.collation }
    : term.collation;
}
