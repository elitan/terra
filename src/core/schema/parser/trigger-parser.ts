/**
 * Trigger Parser
 *
 * Handles parsing of PostgreSQL CREATE TRIGGER statements from CST.
 */

import { Logger } from "../../../utils/logger";
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

    const functionName = extractFunctionName(node);
    if (!functionName) {
      Logger.warning(`Trigger '${name}' missing function name`);
      return null;
    }

    const forEach = extractForEach(node);
    const when = extractWhen(node);
    const functionArgs = extractFunctionArgs(node);

    return {
      name,
      tableName,
      schema: undefined, // TODO: Extract schema if specified
      timing,
      events,
      forEach,
      when,
      functionName,
      functionArgs,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE TRIGGER: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
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
    // whenClause would contain the condition expression
    // For now, return undefined as complex expression parsing is needed
    // TODO: Implement expression parsing if needed
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract function name from pgsql-parser AST
 * funcname is an array of String nodes
 */
function extractFunctionName(node: any): string | null {
  try {
    if (!node.funcname || !Array.isArray(node.funcname)) return null;

    // Extract the last element which is the function name
    const names = node.funcname.map((n: any) => n.String?.sval).filter(Boolean);
    return names.length > 0 ? names[names.length - 1] : null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract function arguments from pgsql-parser AST
 */
function extractFunctionArgs(node: any): string[] | undefined {
  try {
    if (node.args && Array.isArray(node.args) && node.args.length > 0) {
      // TODO: Parse argument expressions
      // For now return undefined as expression parsing is complex
      return undefined;
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}
