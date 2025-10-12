/**
 * Extension Parser
 *
 * Handles parsing of PostgreSQL CREATE EXTENSION statements from CST.
 */

import { Logger } from "../../../utils/logger";
import { extractNameAndSchema } from "./cst-utils";
import type { Extension } from "../../../types/schema";

/**
 * Parse CREATE EXTENSION statement from CST
 */
export function parseCreateExtension(node: any): Extension | null {
  try {
    // Extract extension name
    const extensionName = extractExtensionName(node);
    if (!extensionName) return null;

    // Extract schema (if specified with SCHEMA clause)
    const schema = extractExtensionSchema(node);

    // Extract version (if specified with VERSION clause)
    const version = extractExtensionVersion(node);

    // Check for CASCADE option
    const cascade = extractCascadeOption(node);

    return {
      name: extensionName,
      schema,
      version,
      cascade,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE EXTENSION from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Extract extension name from CST node
 */
function extractExtensionName(node: any): string | null {
  try {
    // Extension name can be in node.name or node.extension
    return node.name?.text || node.name?.name || node.extension?.text || node.extension?.name || null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract schema from CREATE EXTENSION ... SCHEMA clause
 */
function extractExtensionSchema(node: any): string | undefined {
  try {
    // Look for SCHEMA clause in options
    if (node.options?.items) {
      for (const option of node.options.items) {
        if (option.name?.text?.toUpperCase() === "SCHEMA" || option.schema) {
          return option.value?.text || option.value?.name || option.schema?.text || option.schema?.name;
        }
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract version from CREATE EXTENSION ... VERSION clause
 */
function extractExtensionVersion(node: any): string | undefined {
  try {
    // Look for VERSION clause in options
    if (node.options?.items) {
      for (const option of node.options.items) {
        if (option.name?.text?.toUpperCase() === "VERSION") {
          return option.value?.text || option.value?.value;
        }
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract CASCADE option from CREATE EXTENSION
 */
function extractCascadeOption(node: any): boolean {
  try {
    // Look for CASCADE keyword in options
    if (node.options?.items) {
      for (const option of node.options.items) {
        if (option.text?.toUpperCase() === "CASCADE" || option.cascade) {
          return true;
        }
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}
