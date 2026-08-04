import type { View } from "../../../types/schema";
import type { MigrationContext } from "../../../types/migration";
import { ValidationError } from "../../../types/errors";
import { deparseSync, parseSync } from "pgsql-parser";
import {
  generateCreateViewSQL,
  generateDropViewSQL,
  generateCreateOrReplaceViewSQL,
  generateRefreshMaterializedViewSQL,
  generateRenameViewColumnSQL,
  generateResetMaterializedViewStorageParametersSQL,
  generateSetMaterializedViewAccessMethodSQL,
  generateSetMaterializedViewStorageParametersSQL,
  generateSetMaterializedViewTablespaceSQL,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";
import { SchemaDiffer } from "../differ";

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

function clearOutputAliases(selectStatement: any): void {
  if (Array.isArray(selectStatement?.targetList)) {
    for (const target of selectStatement.targetList) {
      if (target.ResTarget) {
        delete target.ResTarget.name;
      }
    }
  }
  if (selectStatement?.larg?.SelectStmt) {
    clearOutputAliases(selectStatement.larg.SelectStmt);
  }
  if (selectStatement?.rarg?.SelectStmt) {
    clearOutputAliases(selectStatement.rarg.SelectStmt);
  }
}

function definitionWithoutOutputAliases(definition: string): string {
  try {
    const parsed = parseSync(definition);
    const selectStatement = parsed.stmts?.[0]?.stmt?.SelectStmt;
    if (!selectStatement) {
      return definition;
    }
    clearOutputAliases(selectStatement);
    const statements = parsed.stmts.map(function getStatement(item: any) {
      return item.stmt;
    });
    return deparseSync(statements).trim();
  } catch {
    return definition;
  }
}

function haveSameColumnNames(desired: View, current: View): boolean {
  if (!desired.columnNames || !current.columnNames) {
    return true;
  }
  return desired.columnNames.length === current.columnNames.length &&
    desired.columnNames.every(function hasSameName(name, index) {
      return name === current.columnNames?.[index];
    });
}

function postgresViewDefinitionNeedsUpdate(
  desired: View,
  current: View
): boolean {
  const compareAliasesSeparately = Boolean(
    desired.columnNames && current.columnNames
  );
  const desiredDefinition = compareAliasesSeparately
    ? definitionWithoutOutputAliases(desired.definition)
    : desired.definition;
  const currentDefinition = compareAliasesSeparately
    ? definitionWithoutOutputAliases(current.definition)
    : current.definition;

  return desired.materialized !== current.materialized ||
    normalizeDefinition(desiredDefinition, desired.schema) !==
      normalizeDefinition(currentDefinition, current.schema) ||
    desired.checkOption !== current.checkOption ||
    desired.securityBarrier !== current.securityBarrier;
}

function postgresViewWillBeRecreated(desired: View, current: View): boolean {
  if (desired.materialized !== current.materialized) {
    return true;
  }
  if (
    desired.columnNames &&
    current.columnNames &&
    desired.columnNames.length < current.columnNames.length
  ) {
    return true;
  }
  return Boolean(
    desired.materialized && postgresViewDefinitionNeedsUpdate(desired, current)
  );
}

function stringRecordsEqual(
  desired: Record<string, string> | undefined,
  current: Record<string, string> | undefined
): boolean {
  const desiredEntries = Object.entries(desired || {}).sort();
  const currentEntries = Object.entries(current || {}).sort();
  return desiredEntries.length === currentEntries.length &&
    desiredEntries.every(function hasSameEntry(entry, index) {
      return currentEntries[index]?.[0] === entry[0] &&
        currentEntries[index]?.[1] === entry[1];
    });
}

function materializedViewPhysicalPropertiesNeedUpdate(
  desired: View,
  current: View,
  context: MigrationContext
): boolean {
  if (!desired.materialized || !current.materialized) {
    return false;
  }

  const defaultAccessMethod = context.defaultTableAccessMethod || "heap";
  const storageParametersChanged = !stringRecordsEqual(
    desired.storageParameters,
    current.storageParameters
  );
  const tablespaceChanged = (desired.tablespace || "pg_default") !==
    (current.tablespace || "pg_default");
  const accessMethodChanged =
    (desired.accessMethod || defaultAccessMethod) !==
    (current.accessMethod || defaultAccessMethod);
  return storageParametersChanged || tablespaceChanged || accessMethodChanged;
}

function generateMaterializedViewAccessMethodAlteration(
  desired: View,
  current: View,
  context: MigrationContext
): string | undefined {
  const defaultAccessMethod = context.defaultTableAccessMethod || "heap";
  const desiredAccessMethod = desired.accessMethod || defaultAccessMethod;
  const currentAccessMethod = current.accessMethod || defaultAccessMethod;
  if (desiredAccessMethod === currentAccessMethod) {
    return undefined;
  }

  const qualifiedName = `${desired.schema || "public"}.${desired.name}`;
  if (context.postgresVersionNum === undefined) {
    throw new ValidationError(
      `Cannot safely change the access method of existing materialized view ${qualifiedName} without the PostgreSQL server version`,
      qualifiedName,
      "accessMethod",
      desiredAccessMethod
    );
  }
  if (context.postgresVersionNum < 150000) {
    const serverMajor = Math.floor(context.postgresVersionNum / 10000);
    throw new ValidationError(
      `PostgreSQL ${serverMajor} cannot change the access method of existing materialized view ${qualifiedName}; PostgreSQL 15 or newer is required for an in-place change`,
      qualifiedName,
      "accessMethod",
      desiredAccessMethod
    );
  }
  return generateSetMaterializedViewAccessMethodSQL(
    desired,
    desiredAccessMethod
  );
}

function generateMaterializedViewPhysicalAlterations(
  desired: View,
  current: View,
  context: MigrationContext
): string[] {
  if (!desired.materialized || !current.materialized) {
    return [];
  }

  const statements: string[] = [];
  const desiredParameters = desired.storageParameters || {};
  const currentParameters = current.storageParameters || {};
  const parametersToSet = Object.fromEntries(
    Object.entries(desiredParameters).filter(function filterChanged([name, value]) {
      return currentParameters[name] !== value;
    })
  );
  const parametersToReset = Object.keys(currentParameters).filter(
    function filterRemoved(name) {
      return desiredParameters[name] === undefined;
    }
  );

  if (Object.keys(parametersToSet).length > 0) {
    statements.push(
      generateSetMaterializedViewStorageParametersSQL(
        desired,
        parametersToSet
      )
    );
  }
  if (parametersToReset.length > 0) {
    statements.push(
      generateResetMaterializedViewStorageParametersSQL(
        desired,
        parametersToReset
      )
    );
  }

  const desiredTablespace = desired.tablespace || "pg_default";
  const currentTablespace = current.tablespace || "pg_default";
  if (desiredTablespace !== currentTablespace) {
    statements.push(
      generateSetMaterializedViewTablespaceSQL(desired, desiredTablespace)
    );
  }

  const accessMethodAlteration = generateMaterializedViewAccessMethodAlteration(
    desired,
    current,
    context
  );
  if (accessMethodAlteration) {
    statements.push(accessMethodAlteration);
  }
  return statements;
}

function generateViewColumnRenameStatements(
  desired: View,
  current: View
): string[] {
  if (!desired.columnNames || !current.columnNames) {
    return [];
  }

  const changes: Array<{
    currentName: string;
    desiredName: string;
    temporaryName: string;
  }> = [];
  const reservedNames = new Set([
    ...desired.columnNames,
    ...current.columnNames,
  ]);
  const commonLength = Math.min(
    desired.columnNames.length,
    current.columnNames.length
  );

  for (let index = 0; index < commonLength; index++) {
    const currentName = current.columnNames[index];
    const desiredName = desired.columnNames[index];
    if (!currentName || !desiredName || currentName === desiredName) {
      continue;
    }

    let temporaryName = `__terradb_view_column_${index + 1}`;
    let suffix = 1;
    while (reservedNames.has(temporaryName)) {
      temporaryName = `__terradb_view_column_${index + 1}_${suffix}`;
      suffix++;
    }
    reservedNames.add(temporaryName);
    changes.push({ currentName, desiredName, temporaryName });
  }

  const statements = changes.map(function renameToTemporary(change) {
    return generateRenameViewColumnSQL(
      current,
      change.currentName,
      change.temporaryName
    );
  });
  statements.push(
    ...changes.map(function renameToDesired(change) {
      return generateRenameViewColumnSQL(
        desired,
        change.temporaryName,
        change.desiredName
      );
    })
  );
  return statements;
}

function recreateView(desired: View, current: View): string {
  return `${generateDropViewSQL(
    current.name,
    current.materialized,
    current.schema
  )}\n${generateCreateViewSQL(desired)}`;
}

function generatePostgresViewUpdateStatements(
  desired: View,
  current: View,
  context: MigrationContext
): string | string[] {
  if (postgresViewWillBeRecreated(desired, current)) {
    return recreateView(desired, current);
  }

  const statements = generateViewColumnRenameStatements(desired, current);
  if (postgresViewDefinitionNeedsUpdate(desired, current)) {
    statements.push(generateCreateOrReplaceViewSQL(desired));
  }
  statements.push(
    ...generateMaterializedViewPhysicalAlterations(desired, current, context)
  );
  return statements;
}

function getViewKey(view: View): string {
  return `${view.schema || "public"}.${view.name}`;
}

function mapViewsByKey(views: View[]): Map<string, View> {
  return new Map(
    views.map(function mapView(view) {
      return [getViewKey(view), view] as const;
    })
  );
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

function createPostgresConfig(
  context: MigrationContext
): HandlerConfig<View> {
  return {
    name: "view",
    getKey: getViewKey,
    generateDrop: function generatePostgresViewDrop(view) {
      return generateDropViewSQL(view.name, view.materialized, view.schema);
    },
    generateCreate: generateCreateViewSQL,
    generateUpdate: function generatePostgresViewUpdate(desired, current) {
      return generatePostgresViewUpdateStatements(desired, current, context);
    },
    needsUpdate: function postgresViewNeedsUpdate(desired, current) {
      return postgresViewDefinitionNeedsUpdate(desired, current) ||
        !haveSameColumnNames(desired, current) ||
        materializedViewPhysicalPropertiesNeedUpdate(
          desired,
          current,
          context
        );
    },
  };
}

const sqliteConfig: HandlerConfig<View> = {
  name: "view",
  getKey: getViewKey,
  generateDrop: generateSQLiteDropView,
  generateCreate: generateSQLiteCreateView,
  needsUpdate: sqliteViewNeedsUpdate,
};

const materializedViewIndexDiffer = new SchemaDiffer({
  useConcurrentIndexes: false,
  useConcurrentDrops: false,
});

function generateMaterializedViewIndexStatements(
  desiredViews: View[],
  currentViews: View[]
): string[] {
  const statements: string[] = [];
  const currentMap = mapViewsByKey(currentViews);

  for (const desired of desiredViews) {
    if (!desired.materialized) {
      continue;
    }

    const current = currentMap.get(getViewKey(desired));
    const currentIndexes =
      current && !postgresViewWillBeRecreated(desired, current)
        ? current.indexes || []
        : [];
    statements.push(
      ...materializedViewIndexDiffer.generateStandaloneIndexStatements(
        desired.indexes || [],
        currentIndexes
      )
    );
  }
  return statements;
}

function generateMaterializedViewPopulationStatements(
  desiredViews: View[],
  currentViews: View[]
): string[] {
  const statements: string[] = [];
  const currentMap = mapViewsByKey(currentViews);

  for (const desired of desiredViews) {
    if (!desired.materialized || desired.populated === undefined) {
      continue;
    }

    const current = currentMap.get(getViewKey(desired));
    if (
      !current ||
      current.populated === undefined ||
      current.populated === desired.populated ||
      postgresViewWillBeRecreated(desired, current)
    ) {
      continue;
    }

    statements.push(
      generateRefreshMaterializedViewSQL(
        desired.name,
        false,
        desired.schema,
        desired.populated
      )
    );
  }

  return statements;
}

export class ViewHandler {
  generateStatements(
    desiredViews: View[],
    currentViews: View[],
    context: MigrationContext = {}
  ): string[] {
    const usesCreateStatements = desiredViews.some(hasCreateStatement) ||
      currentViews.some(hasCreateStatement);
    const statements = generateStatements(
      desiredViews,
      currentViews,
      usesCreateStatements ? sqliteConfig : createPostgresConfig(context)
    );
    if (usesCreateStatements) {
      return statements;
    }
    statements.push(
      ...generateMaterializedViewIndexStatements(desiredViews, currentViews)
    );
    statements.push(
      ...generateMaterializedViewPopulationStatements(
        desiredViews,
        currentViews
      )
    );
    return statements;
  }
}
