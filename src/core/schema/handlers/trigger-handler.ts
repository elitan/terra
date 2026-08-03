import type { Trigger } from "../../../types/schema";
import {
  generateCreateTriggerSQL,
  generateDropTriggerSQL,
  normalizeExpression,
} from "../../../utils/sql";
import { generateStatements, type HandlerConfig } from "./base-handler";

const config: HandlerConfig<Trigger> = {
  name: "trigger",
  getKey: (t) => `${t.schema || "public"}.${t.tableName}.${t.name}`,
  getLogName: (t) => `${t.name}' on '${t.schema || "public"}.${t.tableName}`,
  generateDrop: generateDropTriggerStatement,
  generateCreate: generateCreateTriggerStatement,
  needsUpdate: (desired, current) => {
    if (hasSqliteDefinition(desired) || hasSqliteDefinition(current)) {
      const desiredDefinition = normalizeTriggerDefinition(desired.definition || "");
      const currentDefinition = normalizeTriggerDefinition(current.definition || "");
      return desiredDefinition !== currentDefinition;
    }

    const desiredWhen = desired.when ? normalizeExpression(desired.when) : undefined;
    const currentWhen = current.when ? normalizeExpression(current.when) : undefined;
    const desiredEvents = normalizeTriggerEvents(desired.events);
    const currentEvents = normalizeTriggerEvents(current.events);
    const desiredArgs = normalizeTriggerArgs(desired.functionArgs);
    const currentArgs = normalizeTriggerArgs(current.functionArgs);

    return (
      desired.timing !== current.timing ||
      desired.forEach !== current.forEach ||
      desired.functionName !== current.functionName ||
      (desired.functionSchema || "public") !== (current.functionSchema || "public") ||
      JSON.stringify(desiredEvents) !== JSON.stringify(currentEvents) ||
      desiredWhen !== currentWhen ||
      JSON.stringify(desiredArgs) !== JSON.stringify(currentArgs)
    );
  },
};

function hasSqliteDefinition(trigger: Trigger): boolean {
  return typeof trigger.definition === "string" && trigger.definition.trim().length > 0;
}

function cleanTriggerDefinition(definition: string): string {
  return definition.trim().replace(/;+\s*$/g, "");
}

function normalizeTriggerDefinition(definition: string): string {
  const cleaned = cleanTriggerDefinition(definition);
  let normalized = "";
  let quote: string | undefined;

  for (let index = 0; index < cleaned.length; index += 1) {
    const character = cleaned[index] || "";

    if (quote) {
      normalized += character;
      if (character === quote) {
        if (cleaned[index + 1] === quote) {
          normalized += quote;
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      normalized += character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      normalized += character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (normalized.length > 0 && !normalized.endsWith(" ")) {
        normalized += " ";
      }
      continue;
    }

    normalized += character;
  }

  return normalized.trim();
}

function generateDropTriggerStatement(trigger: Trigger): string {
  if (hasSqliteDefinition(trigger)) {
    return `DROP TRIGGER IF EXISTS "${trigger.name}";`;
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
  generateStatements(desiredTriggers: Trigger[], currentTriggers: Trigger[]): string[] {
    return generateStatements(desiredTriggers, currentTriggers, config);
  }
}
