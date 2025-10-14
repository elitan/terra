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
  Logger.warning("Trigger parsing not yet fully implemented for pgsql-parser");
  return null;
  try {
    const fullName = node.name?.text || node.name?.name || null;
    const name = fullName;
    const schema: string | undefined = undefined;
    if (!name) return null;

    const tableFullName = node.table?.text || node.table?.name || null;
    const { name: tableName, schema: tableSchema } = extractNameAndSchema(tableFullName);
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
      schema: schema || tableSchema, // Use trigger's schema or fall back to table's schema
      timing,
      events,
      forEach,
      when,
      functionName,
      functionArgs,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE TRIGGER from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Extract trigger name from CST node
 */
function extractTriggerName(node: any): string | null {
  try {
    return node.name?.name || node.name?.text || null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract table name from trigger target
 */
function extractTableName(node: any): string | null {
  try {
    return node.target?.table?.name || node.target?.table?.text || null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract timing (BEFORE, AFTER, INSTEAD OF)
 */
function extractTiming(node: any): Trigger['timing'] | null {
  try {
    const timeKw = node.timeKw?.name || node.timeKw?.text;
    if (timeKw === "BEFORE" || timeKw === "AFTER") {
      return timeKw;
    }

    if (timeKw === "INSTEAD" && node.ofKw) {
      return "INSTEAD OF";
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract trigger events (INSERT, UPDATE, DELETE, TRUNCATE)
 */
function extractEvents(node: any): Trigger['events'] {
  const events: Trigger['events'] = [];

  try {
    if (node.event) {
      const eventKw = node.event.eventKw?.name || node.event.eventKw?.text;
      if (eventKw === "INSERT" || eventKw === "UPDATE" || eventKw === "DELETE" || eventKw === "TRUNCATE") {
        events.push(eventKw);
      }
    }

    if (node.events && Array.isArray(node.events)) {
      for (const event of node.events) {
        const eventKw = event.eventKw?.name || event.eventKw?.text;
        if (eventKw === "INSERT" || eventKw === "UPDATE" || eventKw === "DELETE" || eventKw === "TRUNCATE") {
          events.push(eventKw);
        }
      }
    }
  } catch (error) {
    Logger.warning(
      `Failed to extract trigger events: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return events;
}

/**
 * Extract FOR EACH clause (ROW or STATEMENT)
 */
function extractForEach(node: any): Trigger['forEach'] | undefined {
  try {
    const clauses = node.clauses || [];
    for (const clause of clauses) {
      if (clause.type === "for_each_clause") {
        const itemKw = clause.itemKw?.name || clause.itemKw?.text;
        if (itemKw === "ROW" || itemKw === "STATEMENT") {
          return itemKw;
        }
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract WHEN clause condition
 */
function extractWhen(node: any): string | undefined {
  try {
    const clauses = node.clauses || [];
    for (const clause of clauses) {
      if (clause.type === "when_clause") {
        return clause.condition?.text || undefined;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract function name from EXECUTE clause
 */
function extractFunctionName(node: any): string | null {
  try {
    if (node.body) {
      return node.body.name?.name || node.body.name?.text || null;
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract function arguments from EXECUTE clause
 */
function extractFunctionArgs(node: any): string[] | undefined {
  try {
    if (node.body && node.body.args) {
      const items = node.body.args.expr?.items || [];
      if (items.length > 0) {
        return items.map((item: any) => item.text || item.value || "");
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}
