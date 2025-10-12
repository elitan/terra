/**
 * VIEW Parser
 *
 * Handles parsing of PostgreSQL VIEWs (including materialized views) from CST.
 */

import { Logger } from "../../../utils/logger";
import type { View } from "../../../types/schema";

/**
 * Parse CREATE VIEW statement from CST
 */
export function parseCreateView(node: any, originalSql: string): View | null {
  try {
    // Extract view name
    const viewName = extractViewName(node);
    if (!viewName) return null;

    // Extract view definition (SELECT statement)
    const definition = extractViewDefinition(node, originalSql);
    if (!definition) return null;

    // Check if it's materialized
    const materialized = isViewMaterialized(node);

    // Extract view options
    const checkOption = extractViewCheckOption(node);
    const securityBarrier = extractViewSecurityBarrier(node);

    return {
      name: viewName,
      definition,
      materialized,
      checkOption,
      securityBarrier,
    };
  } catch (error) {
    Logger.warning(
      `⚠️ Failed to parse CREATE VIEW from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Extract view name from CST node
 */
function extractViewName(node: any): string | null {
  try {
    // Handle different name structures in the CST
    if (node.name?.text) {
      // Remove quotes from quoted identifiers
      const name = node.name.text;
      if (name.startsWith('"') && name.endsWith('"')) {
        return name.slice(1, -1);
      }
      return name;
    }
    if (node.name?.name) {
      const name = node.name.name;
      if (name.startsWith('"') && name.endsWith('"')) {
        return name.slice(1, -1);
      }
      return name;
    }
    if (node.table?.name?.text) {
      const name = node.table.name.text;
      if (name.startsWith('"') && name.endsWith('"')) {
        return name.slice(1, -1);
      }
      return name;
    }
    if (node.table?.name?.name) {
      const name = node.table.name.name;
      if (name.startsWith('"') && name.endsWith('"')) {
        return name.slice(1, -1);
      }
      return name;
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract view definition (SELECT statement) from CST
 */
function extractViewDefinition(node: any, originalSql: string): string | null {
  try {
    // Look for the AS clause containing the SELECT statement
    if (node.clauses && Array.isArray(node.clauses)) {
      for (const clause of node.clauses) {
        if (clause.type === "as_clause" && clause.expr) {
          // The expr should contain the SELECT statement
          if (clause.expr.type === "select_stmt" && clause.expr.range) {
            // Use range information to extract original text
            const [start, end] = clause.expr.range;
            return originalSql.substring(start, end).trim();
          }
        }
      }
    }

    // Fallback: try to get raw text if available
    if (node.as?.text) {
      return node.as.text.trim();
    }

    return null;
  } catch (error) {
    Logger.warning(`⚠️ Failed to extract view definition: ${error}`);
    return null;
  }
}

/**
 * Check if view is materialized
 */
function isViewMaterialized(node: any): boolean {
  try {
    // Check for MATERIALIZED keyword in kinds array
    if (node.kinds && Array.isArray(node.kinds)) {
      return node.kinds.some(
        (kind: any) =>
          kind.type === "relation_kind" && kind.kindKw?.name === "MATERIALIZED"
      );
    }

    // Fallback checks
    if (node.materializedKw?.name === "MATERIALIZED") return true;
    if (node.materialized === true) return true;
    if (node.keywords && node.keywords.some((kw: any) => kw.name === "MATERIALIZED")) return true;

    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Extract WITH CHECK OPTION setting
 */
function extractViewCheckOption(node: any): "CASCADED" | "LOCAL" | undefined {
  try {
    // Look for WITH CHECK OPTION clause
    if (node.clauses && Array.isArray(node.clauses)) {
      for (const clause of node.clauses) {
        if (clause.type === "with_check_option_clause") {
          // Check if it's LOCAL or default CASCADED
          if (clause.levelKw?.name === "LOCAL") {
            return "LOCAL";
          }
          // Default is CASCADED if just WITH CHECK OPTION
          return "CASCADED";
        }
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract security_barrier option
 */
function extractViewSecurityBarrier(node: any): boolean | undefined {
  try {
    // Look for security_barrier option in postgresql_with_options clause
    if (node.clauses && Array.isArray(node.clauses)) {
      for (const clause of node.clauses) {
        if (
          clause.type === "postgresql_with_options" &&
          clause.options?.expr?.items
        ) {
          for (const option of clause.options.expr.items) {
            if (
              option.type === "table_option" &&
              option.name?.name === "security_barrier"
            ) {
              // Check the value - should be true/false
              if (
                option.value?.value === true ||
                option.value?.text === "true"
              ) {
                return true;
              }
              if (
                option.value?.value === false ||
                option.value?.text === "false"
              ) {
                return false;
              }
              // If no value specified, default is true
              return true;
            }
          }
        }
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}
