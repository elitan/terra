import type { Trigger } from "../../../types/schema";
import {
  generateCreateTriggerSQL,
  generateDropTriggerSQL,
  normalizeExpression,
} from "../../../utils/sql";
import { normalizeSQLiteIdentifier } from "../../../utils/sqlite-identifier";
import { normalizeSQLiteSchemaDefinition } from "../../../providers/sqlite/sql-parser-utils";
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

      const desiredWhen = desired.when
        ? normalizeExpression(desired.when)
        : undefined;
      const currentWhen = current.when
        ? normalizeExpression(current.when)
        : undefined;
      const desiredEvents = normalizeTriggerEvents(desired.events);
      const currentEvents = normalizeTriggerEvents(current.events);
      const desiredArgs = normalizeTriggerArgs(desired.functionArgs);
      const currentArgs = normalizeTriggerArgs(current.functionArgs);

      return (
        desired.timing !== current.timing ||
        desired.forEach !== current.forEach ||
        desired.functionName !== current.functionName ||
        (desired.functionSchema || "public") !==
          (current.functionSchema || "public") ||
        JSON.stringify(desiredEvents) !== JSON.stringify(currentEvents) ||
        desiredWhen !== currentWhen ||
        JSON.stringify(desiredArgs) !== JSON.stringify(currentArgs)
      );
    },
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

function generateCreateTriggerStatement(trigger: Trigger): string {
  if (hasSqliteDefinition(trigger)) {
    return `${cleanTriggerDefinition(trigger.definition || "")};`;
  }

  return generateCreateTriggerSQL(trigger);
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
