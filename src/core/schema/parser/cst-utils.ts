/**
 * CST (Concrete Syntax Tree) Navigation Utilities
 *
 * Helper functions for traversing and searching CST nodes from sql-parser-cst.
 */

/**
 * Find the first node of a specific type in the CST tree
 */
export function findNodeByType(node: any, type: string): any {
  if (node?.type === type) {
    return node;
  }

  if (node?.children) {
    for (const child of node.children) {
      const found = findNodeByType(child, type);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Find all nodes of a specific type in the CST tree
 */
export function findNodesByType(node: any, type: string): any[] {
  const results: any[] = [];

  if (node?.type === type) {
    results.push(node);
  }

  if (node?.children) {
    for (const child of node.children) {
      results.push(...findNodesByType(child, type));
    }
  }

  return results;
}

/**
 * Extract table name from CST node
 */
export function extractTableNameFromCST(node: any): string | null {
  try {
    return node.name?.text || node.name?.name || null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract string value from CST node (handles quoted strings)
 */
export function extractStringValueFromCST(node: any): string | null {
  try {
    // Handle string literals
    if (node.type === "string_literal" || node.type === "literal") {
      return node.text?.replace(/^'|'$/g, '') || node.value || null;
    }

    // Handle direct text
    if (typeof node.text === 'string') {
      return node.text.replace(/^'|'$/g, '');
    }

    // Handle value property
    if (typeof node.value === 'string') {
      return node.value.replace(/^'|'$/g, '');
    }

    return null;
  } catch (error) {
    return null;
  }
}
