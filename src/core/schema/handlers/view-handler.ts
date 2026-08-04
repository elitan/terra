import type { View } from "../../../types/schema";
import type { MigrationContext } from "../../../types/migration";
import { ValidationError } from "../../../types/errors";
import { deparseSync, parseSync } from "pgsql-parser";
import { toPgAstNode } from "../parser/pgsql-ast";
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
import { normalizeSQLiteIdentifier } from "../../../utils/sqlite-identifier";
import { normalizeSQLiteSchemaDefinition } from "../../../providers/sqlite/sql-parser-utils";
import {
  postgresIndexMethodSupportsClustering,
  renderPostgresClustering,
} from "../../../utils/postgres-clustering";
import {
  remapPostgresColumnStatisticsByOrdinal,
  renderPostgresColumnStatisticsChanges,
  validatePostgresColumnStatistics,
  validatePostgresStatisticsTarget,
} from "../../../utils/postgres-statistics";
import { getPostgresIndexTerms } from "../../../utils/postgres-index";

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
    const statements = parsed.stmts;
    const firstStatement = toPgAstNode(statements?.[0]?.stmt);
    const selectStatement = firstStatement?.SelectStmt;
    if (!selectStatement || !statements) {
      return definition;
    }
    clearOutputAliases(selectStatement);
    const statementNodes = statements.flatMap(function getStatement(item) {
      return item.stmt ? [item.stmt] : [];
    });
    if (statementNodes.length !== statements.length) {
      return definition;
    }
    return deparseSync(statementNodes).trim();
  } catch {
    return definition;
  }
}

function haveSameColumnNames(desired: View, current: View): boolean {
  return !desired.columnNames ||
    !current.columnNames ||
    (desired.columnNames.length === current.columnNames.length &&
      desired.columnNames.every(function hasSameName(name, index) {
        return name === current.columnNames?.[index];
      }));
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
    (desired.securityBarrier ?? false) !==
      (current.securityBarrier ?? false) ||
    (desired.securityInvoker ?? false) !==
      (current.securityInvoker ?? false);
}

function validateSecurityInvokerSupport(
  desiredViews: View[],
  context: MigrationContext
): void {
  const unsupportedView = desiredViews.find(function findSecurityInvoker(view) {
    return !view.materialized && view.securityInvoker !== undefined;
  });
  if (!unsupportedView) {
    return;
  }

  const qualifiedName = `${unsupportedView.schema || "public"}.${unsupportedView.name}`;
  if (context.postgresVersionNum === undefined) {
    throw new ValidationError(
      `Cannot safely manage security_invoker view ${qualifiedName} without the PostgreSQL server version`,
      qualifiedName,
      "securityInvoker",
      unsupportedView.securityInvoker
    );
  }
  if (context.postgresVersionNum < 150000) {
    const serverMajor = Math.floor(context.postgresVersionNum / 10000);
    throw new ValidationError(
      `PostgreSQL ${serverMajor} does not support security_invoker views; PostgreSQL 15 or newer is required for ${qualifiedName}`,
      qualifiedName,
      "securityInvoker",
      unsupportedView.securityInvoker
    );
  }
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

function getSQLiteViewKey(view: View): string {
  return [view.schema || "public", view.name]
    .map(normalizeSQLiteIdentifier)
    .join(".");
}

function createSQLiteConfig(
  identifiers: readonly string[]
): HandlerConfig<View> {
  return {
    name: "view",
    getKey: getSQLiteViewKey,
    generateDrop: generateSQLiteDropView,
    generateCreate: generateSQLiteCreateView,
    needsUpdate: function sqliteViewNeedsUpdate(desired, current) {
      return normalizeSQLiteSchemaDefinition(
        desired.createStatement || "",
        identifiers
      ) !== normalizeSQLiteSchemaDefinition(
        current.createStatement || "",
        identifiers
      );
    },
  };
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

function validateMaterializedViewStatistics(views: View[]): void {
  for (const view of views) {
    const qualifiedName = `${view.schema || "public"}.${view.name}`;
    if ((view.columnStatistics || []).length > 0) {
      if (!view.materialized) {
        throw new ValidationError(
          `PostgreSQL column statistics for ${qualifiedName} require a materialized view`,
          qualifiedName,
          "columnStatistics",
          view.columnStatistics
        );
      }
      if (!view.columnNames) {
        throw new ValidationError(
          `Materialized view ${qualifiedName} must declare an explicit output-column list before TerraDB can validate column statistics`,
          qualifiedName,
          "columnStatistics",
          view.columnStatistics
        );
      }
      validatePostgresColumnStatistics(
        view.columnStatistics,
        qualifiedName,
        new Set(view.columnNames)
      );
    }

    for (const index of view.indexes || []) {
      if (index.concurrent === true) {
        throw new ValidationError(
          `PostgreSQL materialized-view index ${qualifiedName}.${index.name} cannot be created concurrently`,
          `${qualifiedName}.${index.name}`,
          "concurrent",
          true
        );
      }
      for (const [position, term] of getPostgresIndexTerms(index).entries()) {
        if (term.statisticsTarget === undefined) {
          continue;
        }
        validatePostgresStatisticsTarget(
          term.statisticsTarget,
          `${qualifiedName}.${index.name} position ${position + 1}`
        );
        if (!term.expression) {
          throw new ValidationError(
            `PostgreSQL index statistics target for ${qualifiedName}.${index.name} position ${position + 1} requires an expression key`,
            `${qualifiedName}.${index.name}`,
            "terms",
            term
          );
        }
      }
    }
  }
}

function generateMaterializedViewStatisticsStatements(
  desiredViews: View[],
  currentViews: View[]
): string[] {
  const statements: string[] = [];
  const currentMap = mapViewsByKey(currentViews);
  for (const desired of desiredViews) {
    if (!desired.materialized) continue;
    const current = currentMap.get(getViewKey(desired));
    const recreated = Boolean(
      current && postgresViewWillBeRecreated(desired, current)
    );
    const currentStatistics = recreated
      ? undefined
      : remapPostgresColumnStatisticsByOrdinal(
          current?.columnStatistics,
          current?.columnNames,
          desired.columnNames
        );
    statements.push(
      ...renderPostgresColumnStatisticsChanges(
        { name: desired.name, schema: desired.schema },
        desired.columnStatistics,
        currentStatistics,
        "materialized-view"
      )
    );
  }
  return statements;
}

function generateMaterializedViewIndexStatisticsStatements(
  desiredViews: View[],
  currentViews: View[]
): string[] {
  const statements: string[] = [];
  const currentMap = mapViewsByKey(currentViews);
  for (const desired of desiredViews) {
    if (!desired.materialized) continue;
    const current = currentMap.get(getViewKey(desired));
    const currentIndexes =
      current && !postgresViewWillBeRecreated(desired, current)
        ? current.indexes || []
        : [];
    const statistics =
      materializedViewIndexDiffer.generateStandaloneIndexStatisticsStatements(
        desired.indexes || [],
        currentIndexes,
        false
      );
    statements.push(...statistics.statements, ...statistics.deferred);
  }
  return statements;
}

function validateMaterializedViewClustering(views: View[]): void {
  for (const view of views) {
    if (!view.clusterIndex) {
      continue;
    }
    const qualifiedName = `${view.schema || "public"}.${view.name}`;
    if (!view.materialized) {
      throw new ValidationError(
        `PostgreSQL clustering choice for '${qualifiedName}' is invalid: ordinary views cannot have indexes`,
        qualifiedName,
        "clusterIndex",
        view.clusterIndex
      );
    }
    const index = (view.indexes || []).find(function findClusterIndex(
      candidate
    ) {
      return candidate.name === view.clusterIndex;
    });
    if (!index) {
      throw materializedViewClusteringError(
        view,
        `index '${view.clusterIndex}' is not declared on the materialized view`
      );
    }
    if (index.where) {
      throw materializedViewClusteringError(
        view,
        `index '${view.clusterIndex}' is partial`
      );
    }
    const method = (index.type || "btree").toLowerCase();
    if (!postgresIndexMethodSupportsClustering(method)) {
      throw materializedViewClusteringError(
        view,
        `index '${view.clusterIndex}' uses access method '${method}', which TerraDB cannot prove is clusterable`
      );
    }
  }
}

function materializedViewClusteringError(
  view: View,
  reason: string
): ValidationError {
  const qualifiedName = `${view.schema || "public"}.${view.name}`;
  return new ValidationError(
    `PostgreSQL clustering index for materialized view '${qualifiedName}' is invalid: ${reason}. Use a non-partial index whose access method supports clustering`,
    qualifiedName,
    "clusterIndex",
    view.clusterIndex
  );
}

function materializedViewClusterIndexWillChange(
  desired: View,
  current: View | undefined
): boolean {
  if (!desired.clusterIndex || !current) {
    return false;
  }
  const desiredIndex = (desired.indexes || []).find(function findDesired(
    index
  ) {
    return index.name === desired.clusterIndex;
  });
  const currentIndex = (current.indexes || []).find(function findCurrent(
    index
  ) {
    return index.name === desired.clusterIndex;
  });
  if (!desiredIndex || !currentIndex) {
    return false;
  }
  return materializedViewIndexDiffer.generateStandaloneIndexStatements(
    [desiredIndex],
    [currentIndex]
  ).length > 0;
}

function generateMaterializedViewClusteringStatements(
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
    const recreated = Boolean(
      current && postgresViewWillBeRecreated(desired, current)
    );
    const currentIndex = recreated ? undefined : current?.clusterIndex;
    const selectedIndexChanged = desired.clusterIndex !== currentIndex;
    const selectedIndexWillChange = materializedViewClusterIndexWillChange(
      desired,
      recreated ? undefined : current
    );
    if (!selectedIndexChanged && !selectedIndexWillChange) {
      continue;
    }
    statements.push(
      renderPostgresClustering(
        { name: desired.name, schema: desired.schema },
        desired.clusterIndex,
        "materialized-view"
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
    context: MigrationContext = {},
    sqliteIdentifiers: readonly string[] = []
  ): string[] {
    const usesCreateStatements = desiredViews.some(hasCreateStatement) ||
      currentViews.some(hasCreateStatement);
    if (!usesCreateStatements) {
      validateSecurityInvokerSupport(desiredViews, context);
      validateMaterializedViewClustering(desiredViews);
      validateMaterializedViewStatistics(desiredViews);
    }
    const statements = generateStatements(
      desiredViews,
      currentViews,
      usesCreateStatements
        ? createSQLiteConfig(sqliteIdentifiers)
        : createPostgresConfig(context)
    );
    if (usesCreateStatements) {
      return statements;
    }
    statements.push(
      ...generateMaterializedViewStatisticsStatements(
        desiredViews,
        currentViews
      )
    );
    statements.push(
      ...generateMaterializedViewIndexStatements(desiredViews, currentViews)
    );
    statements.push(
      ...generateMaterializedViewIndexStatisticsStatements(
        desiredViews,
        currentViews
      )
    );
    statements.push(
      ...generateMaterializedViewClusteringStatements(
        desiredViews,
        currentViews
      )
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
