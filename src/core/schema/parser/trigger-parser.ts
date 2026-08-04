/**
 * Trigger Parser
 *
 * Handles parsing of PostgreSQL CREATE TRIGGER statements from CST.
 */

import { Logger } from "../../../utils/logger";
import { deparseSync } from "pgsql-parser";
import type { Trigger } from "../../../types/schema";

/**
 * Parse CREATE TRIGGER statement from pgsql-parser AST
 */
export function parseCreateTrigger(node: any): Trigger | null {
  try {
    const name = node.trigname;
    if (!name) {
      Logger.warning("Trigger missing name");
      return null;
    }

    const tableName = node.relation?.relname;
    if (!tableName) {
      Logger.warning(`Trigger '${name}' missing table name`);
      return null;
    }

    const timing = extractTiming(node);
    if (!timing) {
      Logger.warning(`Trigger '${name}' missing timing (BEFORE/AFTER/INSTEAD OF)`);
      return null;
    }

    const events = extractEvents(node);
    if (events.length === 0) {
      Logger.warning(`Trigger '${name}' missing events`);
      return null;
    }

    const functionRef = extractFunctionRef(node);
    if (!functionRef) {
      Logger.warning(`Trigger '${name}' missing function name`);
      return null;
    }

    const forEach = extractForEach(node);
    const updateColumns = extractUpdateColumns(node);
    const transitionTables = extractTransitionTables(node);
    const when = extractWhen(node);
    const functionArgs = extractFunctionArgs(node);

    return {
      name,
      tableName,
      schema: extractTriggerSchema(node),
      timing,
      events,
      ...(updateColumns ? { updateColumns } : {}),
      forEach,
      ...transitionTables,
      when,
      functionName: functionRef.name,
      functionSchema: functionRef.schema,
      functionArgs,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE TRIGGER: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function extractUpdateColumns(node: any): string[] | undefined {
  if (!Array.isArray(node.columns) || node.columns.length === 0) {
    return undefined;
  }

  const columns = node.columns
    .map(function mapColumn(column: any) {
      return column?.String?.sval;
    })
    .filter(function isColumnName(column: unknown): column is string {
      return typeof column === "string";
    });
  return columns.length > 0 ? columns : undefined;
}

function extractTransitionTables(node: any): Pick<
  Trigger,
  "oldTransitionTable" | "newTransitionTable"
> {
  const result: Pick<
    Trigger,
    "oldTransitionTable" | "newTransitionTable"
  > = {};
  if (!Array.isArray(node.transitionRels)) {
    return result;
  }

  for (const item of node.transitionRels) {
    const transition = item?.TriggerTransition;
    if (!transition?.isTable || typeof transition.name !== "string") {
      continue;
    }
    if (transition.isNew) {
      result.newTransitionTable = transition.name;
    } else {
      result.oldTransitionTable = transition.name;
    }
  }
  return result;
}

function extractTriggerSchema(node: any): string | undefined {
  try {
    return node.relation?.schemaname;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract timing from pgsql-parser AST
 * timing field may be missing for AFTER (the default)
 * timing is a bitmask: 2=BEFORE, 64=INSTEAD OF, otherwise AFTER
 */
function extractTiming(node: any): Trigger['timing'] | null {
  try {
    const timing = node.timing;

    // If timing is undefined or 0, it's AFTER (the default)
    if (timing === undefined || timing === null || timing === 0) {
      return "AFTER";
    }

    // Check bitmask values
    if (timing & 64) {
      return "INSTEAD OF";
    } else if (timing & 2) {
      return "BEFORE";
    } else {
      return "AFTER";
    }
  } catch (error) {
    return null;
  }
}

/**
 * Extract trigger events from pgsql-parser AST
 * events is a bitmask: 4=INSERT, 8=DELETE, 16=UPDATE, 32=TRUNCATE
 */
function extractEvents(node: any): Trigger['events'] {
  const events: Trigger['events'] = [];

  try {
    const eventsBitmask = node.events;
    if (eventsBitmask === undefined || eventsBitmask === null) return events;

    // Check each bit in the bitmask
    if (eventsBitmask & 4) events.push("INSERT");
    if (eventsBitmask & 8) events.push("DELETE");
    if (eventsBitmask & 16) events.push("UPDATE");
    if (eventsBitmask & 32) events.push("TRUNCATE");
  } catch (error) {
    Logger.warning(
      `Failed to extract trigger events: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return events;
}

/**
 * Extract FOR EACH from pgsql-parser AST
 * row is a boolean: true=FOR EACH ROW, false=FOR EACH STATEMENT
 */
function extractForEach(node: any): Trigger['forEach'] | undefined {
  try {
    if (node.row === true) {
      return "ROW";
    } else if (node.row === false) {
      return "STATEMENT";
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract WHEN clause condition from pgsql-parser AST
 */
function extractWhen(node: any): string | undefined {
  try {
    if (!node.whenClause) {
      return undefined;
    }
    const whenExpression = deparseSync([node.whenClause]).trim();
    return whenExpression.replace(/\s+/g, " ").trim();
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract function name from pgsql-parser AST
 * funcname is an array of String nodes
 */
function extractFunctionRef(node: any): { name: string; schema?: string } | null {
  try {
    if (!node.funcname || !Array.isArray(node.funcname)) return null;

    const names = node.funcname.map((n: any) => n.String?.sval).filter(Boolean);
    if (names.length === 0) {
      return null;
    }
    const name = names[names.length - 1];
    const schema = names.length > 1 ? names[names.length - 2] : undefined;
    return {
      name,
      schema,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Extract function arguments from pgsql-parser AST
 */
function extractFunctionArgs(node: any): string[] | undefined {
  try {
    if (!node.args || !Array.isArray(node.args) || node.args.length === 0) {
      return undefined;
    }

    const functionArgs: string[] = [];

    for (const arg of node.args) {
      const stringValue = arg?.String?.sval;
      if (stringValue !== undefined && stringValue !== null) {
        functionArgs.push(`'${String(stringValue).replace(/'/g, "''")}'`);
        continue;
      }

      const parsedArg = deparseSync([arg]).trim();
      if (parsedArg) {
        functionArgs.push(parsedArg);
      }
    }

    return functionArgs.length > 0 ? functionArgs : undefined;
  } catch (error) {
    return undefined;
  }
}
