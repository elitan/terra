import type { View } from "../../../types/schema";
import {
  generateCreateViewSQL,
  generateDropViewSQL,
  generateCreateOrReplaceViewSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSimpleIdentifierQuotes(definition: string): string {
  return definition.replace(
    /(^|[\s(.,])"([a-z_][a-z0-9_]*)"(?=[\s).,]|$)/g,
    "$1$2"
  );
}

function isClauseKeyword(value: string): boolean {
  return new Set([
    "where",
    "group",
    "having",
    "order",
    "limit",
    "offset",
    "union",
    "intersect",
    "except",
    "join",
    "left",
    "right",
    "full",
    "inner",
    "cross",
  ]).has(value.toLowerCase());
}

function normalizeSingleSourceColumnQualification(definition: string): string {
  if (!/^\s*select\b/i.test(definition)) {
    return definition;
  }

  if ((definition.match(/\bfrom\b/gi) || []).length !== 1 || /\bjoin\b/i.test(definition)) {
    return definition;
  }

  const fromMatch = definition.match(
    /\bfrom\s+(?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/i
  );
  if (!fromMatch) {
    return definition;
  }

  const fromIndex = fromMatch.index ?? 0;
  const fromSegment = definition.slice(fromIndex);
  const clauseMatch = fromSegment.match(
    /\b(where|group\s+by|having|order\s+by|limit|offset|union|intersect|except)\b/i
  );
  const sourceSegment = clauseMatch
    ? fromSegment.slice(0, clauseMatch.index)
    : fromSegment;

  if (sourceSegment.includes(",")) {
    return definition;
  }

  const aliasName = fromMatch[3];
  const sourceName = aliasName && !isClauseKeyword(aliasName) ? aliasName : fromMatch[2];
  if (!sourceName) {
    return definition;
  }

  return definition.replace(new RegExp(`\\b${escapeRegExp(sourceName)}\\.`, "gi"), "");
}

function hasBalancedOuterParentheses(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) {
    return false;
  }

  let depth = 0;
  for (let i = 0; i < value.length - 1; i++) {
    const char = value[i];
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth === 0) return false;
  }

  return depth === 1;
}

function stripOuterParentheses(value: string): string {
  let normalized = value.trim();
  while (hasBalancedOuterParentheses(normalized)) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function normalizeWhereParentheses(definition: string): string {
  return definition.replace(
    /\bWHERE\s+(.+?)(?=\bGROUP\s+BY\b|\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|\bOFFSET\b|$)/i,
    (_match, clause: string) => `WHERE ${stripOuterParentheses(clause)}`
  );
}

function normalizeDefinition(def: string, schema?: string): string {
  let normalized = def.replace(/;+\s*$/g, '').replace(/\s+/g, ' ').trim();
  const localSchema = schema || "public";
  const escapedSchema = escapeRegExp(localSchema);

  normalized = normalized.replace(new RegExp(`"${escapedSchema}"\\.`, "gi"), "");
  normalized = normalized.replace(new RegExp(`\\b${escapedSchema}\\.`, "gi"), "");
  normalized = normalizeSimpleIdentifierQuotes(normalized);
  normalized = normalizeSingleSourceColumnQualification(normalized);
  normalized = normalizeWhereParentheses(normalized);

  return normalized;
}

function getViewKey(view: View): string {
  return `${view.schema || "public"}.${view.name}`;
}

function hasCreateStatement(view: View): boolean {
  return typeof view.createStatement === "string" && view.createStatement.trim().length > 0;
}

function cleanCreateStatement(statement: string): string {
  return statement.trim().replace(/;+\s*$/g, "");
}

function quoteSQLiteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function generateSQLiteDropView(view: View): string {
  return `DROP VIEW IF EXISTS ${quoteSQLiteIdentifier(view.name)};`;
}

function generateSQLiteCreateView(view: View): string {
  return `${cleanCreateStatement(view.createStatement || "")};`;
}

function sqliteViewNeedsUpdate(desired: View, current: View): boolean {
  return cleanCreateStatement(desired.createStatement || "") !==
    cleanCreateStatement(current.createStatement || "");
}

const config: HandlerConfig<View> = {
  name: "view",
  getKey: getViewKey,
  generateDrop: (view) => generateDropViewSQL(view.name, view.materialized, view.schema),
  generateCreate: generateCreateViewSQL,
  generateUpdate: generateCreateOrReplaceViewSQL,
  needsUpdate: (desired, current) =>
    desired.materialized !== current.materialized ||
    normalizeDefinition(desired.definition, desired.schema) !==
      normalizeDefinition(current.definition, current.schema) ||
    desired.checkOption !== current.checkOption ||
    desired.securityBarrier !== current.securityBarrier,
};

const sqliteConfig: HandlerConfig<View> = {
  name: "view",
  getKey: getViewKey,
  generateDrop: generateSQLiteDropView,
  generateCreate: generateSQLiteCreateView,
  needsUpdate: sqliteViewNeedsUpdate,
};

export class ViewHandler {
  generateStatements(desiredViews: View[], currentViews: View[]): string[] {
    const usesCreateStatements = desiredViews.some(hasCreateStatement) ||
      currentViews.some(hasCreateStatement);
    return generateStatements(
      desiredViews,
      currentViews,
      usesCreateStatements ? sqliteConfig : config
    );
  }
}
