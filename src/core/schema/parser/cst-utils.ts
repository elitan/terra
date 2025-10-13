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
 * Extract table name from CST node (without schema qualifier)
 */
export function extractTableNameFromCST(node: any): string | null {
  try {
    // Handle member_expr type (schema.table notation)
    if (node.name?.type === 'member_expr') {
      return node.name.property?.name || node.name.property?.text || null;
    }

    // Handle direct identifier
    const fullName = node.name?.text || node.name?.name || null;
    if (!fullName) return null;

    // If qualified (schema.table), extract only the table name
    if (fullName.includes('.')) {
      const parts = fullName.split('.');
      return parts[parts.length - 1];
    }

    return fullName;
  } catch (error) {
    return null;
  }
}

/**
 * Extract schema name from CST node (for qualified names like schema.table)
 */
export function extractSchemaFromCST(node: any): string | undefined {
  try {
    // Handle member_expr type (schema.table notation)
    if (node.name?.type === 'member_expr') {
      return node.name.object?.name || node.name.object?.text || undefined;
    }

    // Handle direct identifier
    const fullName = node.name?.text || node.name?.name || null;
    if (!fullName) return undefined;

    // If qualified (schema.table), extract the schema
    if (fullName.includes('.')) {
      const parts = fullName.split('.');
      if (parts.length === 2) {
        return parts[0];
      }
    }

    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Extract both name and schema from a qualified identifier (e.g., schema.name)
 */
export function extractNameAndSchema(fullName: string | null): { name: string | null; schema: string | undefined } {
  if (!fullName) return { name: null, schema: undefined };

  // If qualified (schema.name), split them
  if (fullName.includes('.')) {
    const parts = fullName.split('.');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { name: parts[1], schema: parts[0] };
    }
  }

  return { name: fullName, schema: undefined };
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
