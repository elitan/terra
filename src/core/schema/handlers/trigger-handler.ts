import type { Trigger } from "../../../types/schema";
import {
  generateCreateTriggerSQL,
  generateDropTriggerSQL,
  normalizeExpression,
} from "../../../utils/sql";
import { normalizeSQLiteIdentifier } from "../../../utils/sqlite-identifier";
import { normalizeSQLiteSchemaDefinition } from "../../../providers/sqlite/sql-parser-utils";
import {
  effectivePostgresTriggerMode,
  renderPostgresTableTriggerMode,
} from "../../../utils/postgres-trigger";
import { generateStatements, type HandlerConfig } from "./base-handler";

function getTriggerKey(trigger: Trigger): string {
  const parts = [trigger.schema || "public", trigger.tableName, trigger.name];
  if (hasSqliteDefinition(trigger)) {
    return parts.map(normalizeSQLiteIdentifier).join(".");
  }
  return parts.join(".");
}

function createConfig(
  sqliteIdentifiers: readonly string[]
): HandlerConfig<Trigger> {
  return {
    name: "trigger",
    getKey: getTriggerKey,
    getLogName: function getLogName(trigger) {
      return `${trigger.name}' on '${trigger.schema || "public"}.${trigger.tableName}`;
    },
    generateDrop: generateDropTriggerStatement,
    generateCreate: generateCreateTriggerStatement,
    needsUpdate: function needsUpdate(desired, current) {
      if (hasSqliteDefinition(desired) || hasSqliteDefinition(current)) {
        const desiredDefinition = normalizeSQLiteSchemaDefinition(
          desired.definition || "",
          sqliteIdentifiers
        );
        const currentDefinition = normalizeSQLiteSchemaDefinition(
          current.definition || "",
          sqliteIdentifiers
        );
        return desiredDefinition !== currentDefinition;
      }

      return postgresTriggerDefinitionsDiffer(desired, current) ||
        effectivePostgresTriggerMode(desired.enabled) !==
          effectivePostgresTriggerMode(current.enabled);
    },
    generateUpdate: generateUpdateTriggerStatements,
  };
}

function hasSqliteDefinition(trigger: Trigger): boolean {
  return typeof trigger.definition === "string" && trigger.definition.trim().length > 0;
}

function cleanTriggerDefinition(definition: string): string {
  return definition.trim().replace(/;+\s*$/g, "");
}

function generateDropTriggerStatement(trigger: Trigger): string {
  if (hasSqliteDefinition(trigger)) {
    return `DROP TRIGGER IF EXISTS "${trigger.name.replace(/"/g, '""')}";`;
  }

  return generateDropTriggerSQL(trigger);
}

function generateCreateTriggerStatement(trigger: Trigger): string | string[] {
  if (hasSqliteDefinition(trigger)) {
    return `${cleanTriggerDefinition(trigger.definition || "")};`;
  }

  return appendNonDefaultTriggerMode(
    [generateCreateTriggerSQL(trigger)],
    trigger
  );
}

function generateUpdateTriggerStatements(
  desired: Trigger,
  current: Trigger
): string[] {
  if (hasSqliteDefinition(desired) || hasSqliteDefinition(current)) {
    return [
      generateDropTriggerStatement(current),
      ...toStatementArray(generateCreateTriggerStatement(desired)),
    ];
  }

  if (triggerDefinitionsAreEqual(desired, current)) {
    return [generateTriggerModeStatement(desired)];
  }

  return [
    generateDropTriggerStatement(current),
    ...toStatementArray(generateCreateTriggerStatement(desired)),
  ];
}

function triggerDefinitionsAreEqual(
  desired: Trigger,
  current: Trigger
): boolean {
  return !postgresTriggerDefinitionsDiffer(desired, current);
}

function postgresTriggerDefinitionsDiffer(
  desired: Trigger,
  current: Trigger
): boolean {
  const desiredWhen = desired.when
    ? normalizeExpression(desired.when)
    : undefined;
  const currentWhen = current.when
    ? normalizeExpression(current.when)
    : undefined;
  return (
    desired.timing !== current.timing ||
    (desired.forEach || "STATEMENT") !==
      (current.forEach || "STATEMENT") ||
    desired.functionName !== current.functionName ||
    (desired.functionSchema || "public") !==
      (current.functionSchema || "public") ||
    !arraysAreEqual(
      normalizeTriggerEvents(desired.events),
      normalizeTriggerEvents(current.events)
    ) ||
    !arraysAreEqual(
      normalizeUpdateColumns(desired.updateColumns),
      normalizeUpdateColumns(current.updateColumns)
    ) ||
    desired.oldTransitionTable !== current.oldTransitionTable ||
    desired.newTransitionTable !== current.newTransitionTable ||
    desiredWhen !== currentWhen ||
    !arraysAreEqual(
      normalizeTriggerArgs(desired.functionArgs),
      normalizeTriggerArgs(current.functionArgs)
    )
  );
}

function arraysAreEqual<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every(function isEqual(
    value,
    index
  ) {
    return value === right[index];
  });
}

function appendNonDefaultTriggerMode(
  statements: string[],
  trigger: Trigger
): string[] {
  if (effectivePostgresTriggerMode(trigger.enabled) !== "origin") {
    statements.push(generateTriggerModeStatement(trigger));
  }
  return statements;
}

function generateTriggerModeStatement(trigger: Trigger): string {
  return renderPostgresTableTriggerMode(
    { name: trigger.tableName, schema: trigger.schema },
    trigger.name,
    effectivePostgresTriggerMode(trigger.enabled)
  );
}

function toStatementArray(statement: string | string[]): string[] {
  return Array.isArray(statement) ? statement : [statement];
}

function normalizeTriggerArgs(args: string[] | undefined): string[] {
  if (!args || args.length === 0) {
    return [];
  }

  return args.map(normalizeTriggerArg);
}

function normalizeTriggerEvents(events: Trigger["events"]): Trigger["events"] {
  const eventOrder: Record<Trigger["events"][number], number> = {
    INSERT: 0,
    UPDATE: 1,
    DELETE: 2,
    TRUNCATE: 3,
  };

  return [...events].sort(function sortEvents(a, b) {
    return eventOrder[a] - eventOrder[b];
  });
}

function normalizeUpdateColumns(columns: string[] | undefined): string[] {
  return [...new Set(columns || [])].sort();
}

function normalizeTriggerArg(arg: string): string {
  const trimmed = arg.trim();
  const isQuoted = trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'");

  if (isQuoted) {
    const inner = trimmed.slice(1, -1).replace(/''/g, "'");
    return `'${inner.replace(/'/g, "''")}'`;
  }

  return `'${trimmed.replace(/'/g, "''")}'`;
}

export class TriggerHandler {
  generateStatements(
    desiredTriggers: Trigger[],
    currentTriggers: Trigger[],
    sqliteIdentifiers: readonly string[] = []
  ): string[] {
    return generateStatements(
      desiredTriggers,
      currentTriggers,
      createConfig(sqliteIdentifiers)
    );
  }
}
