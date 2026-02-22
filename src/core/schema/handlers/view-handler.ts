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

  const sourceName = fromMatch[3] || fromMatch[2];
  if (!sourceName) {
    return definition;
  }

  return definition.replace(new RegExp(`\\b${escapeRegExp(sourceName)}\\.`, "gi"), "");
}

function normalizeDefinition(def: string, schema?: string): string {
  let normalized = def.replace(/;+\s*$/g, '').replace(/\s+/g, ' ').trim();
  const localSchema = schema || "public";
  const escapedSchema = escapeRegExp(localSchema);

  normalized = normalized.replace(new RegExp(`"${escapedSchema}"\\.`, "gi"), "");
  normalized = normalized.replace(new RegExp(`\\b${escapedSchema}\\.`, "gi"), "");
  normalized = normalizeSimpleIdentifierQuotes(normalized);
  normalized = normalizeSingleSourceColumnQualification(normalized);

  return normalized;
}

function getViewKey(view: View): string {
  return `${view.schema || "public"}.${view.name}`;
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

export class ViewHandler {
  generateStatements(desiredViews: View[], currentViews: View[]): string[] {
    return generateStatements(desiredViews, currentViews, config);
  }
}
