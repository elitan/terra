/**
 * Sequence Parser
 *
 * Handles parsing of PostgreSQL CREATE SEQUENCE statements from CST.
 */

import { Logger } from "../../../utils/logger";
import type { Sequence } from "../../../types/schema";

/**
 * Parse CREATE SEQUENCE statement from pgsql-parser AST
 */
export function parseCreateSequence(node: any): Sequence | null {
  Logger.warning("Sequence parsing not yet fully implemented for pgsql-parser");
  return null;
  try {
    const fullName = node.name?.text || node.name?.name || null;
    const name = fullName;
    const schema: string | undefined = undefined;
    if (!name) return null;

    const dataType = extractDataType(node);
    const increment = extractIncrement(node);
    const minValue = extractMinValue(node);
    const maxValue = extractMaxValue(node);
    const start = extractStart(node);
    const cache = extractCache(node);
    const cycle = extractCycle(node);
    const ownedBy = extractOwnedBy(node);

    return {
      name,
      schema,
      dataType,
      increment,
      minValue,
      maxValue,
      start,
      cache,
      cycle,
      ownedBy,
    };
  } catch (error) {
    Logger.warning(
      // @ts-expect-error - error is unknown but String() handles it
      `Failed to parse CREATE SEQUENCE from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Extract sequence name from CST node
 */
function extractSequenceName(node: any): string | null {
  try {
    return node.name?.name || node.name?.text || null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract data type (AS SMALLINT/INTEGER/BIGINT)
 */
function extractDataType(node: any): Sequence['dataType'] | undefined {
  try {
    const options = node.options || [];
    for (const option of options) {
      if (option.type === "sequence_option_as") {
        const typeName = option.dataType?.name?.name || option.dataType?.name?.text;
        if (typeName === "SMALLINT" || typeName === "INTEGER" || typeName === "BIGINT") {
          return typeName;
        }
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract INCREMENT value
 */
function extractIncrement(node: any): number | undefined {
  try {
    const options = node.options || [];
    for (const option of options) {
      if (option.type === "sequence_option_increment") {
        return option.value?.value || undefined;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract MINVALUE
 */
function extractMinValue(node: any): number | undefined {
  try {
    const options = node.options || [];
    for (const option of options) {
      if (option.type === "sequence_option_minvalue") {
        return option.value?.value || undefined;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract MAXVALUE
 */
function extractMaxValue(node: any): number | undefined {
  try {
    const options = node.options || [];
    for (const option of options) {
      if (option.type === "sequence_option_maxvalue") {
        return option.value?.value || undefined;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract START value
 */
function extractStart(node: any): number | undefined {
  try {
    const options = node.options || [];
    for (const option of options) {
      if (option.type === "sequence_option_start") {
        return option.value?.value || undefined;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract CACHE value
 */
function extractCache(node: any): number | undefined {
  try {
    const options = node.options || [];
    for (const option of options) {
      if (option.type === "sequence_option_cache") {
        return option.value?.value || undefined;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract CYCLE flag
 */
function extractCycle(node: any): boolean | undefined {
  try {
    const options = node.options || [];
    for (const option of options) {
      if (option.type === "sequence_option_cycle") {
        return true;
      }
      if (option.type === "sequence_option_no_cycle") {
        return false;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract OWNED BY
 */
function extractOwnedBy(node: any): string | undefined {
  try {
    const options = node.options || [];
    for (const option of options) {
      if (option.type === "sequence_option_owned_by") {
        if (option.table && option.column) {
          const table = option.table.name || option.table.text;
          const column = option.column.name || option.column.text;
          return `${table}.${column}`;
        }
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}
