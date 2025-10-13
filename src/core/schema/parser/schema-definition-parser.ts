/**
 * Schema Definition Parser
 *
 * Handles parsing of PostgreSQL CREATE SCHEMA statements from CST.
 */

import { Logger } from "../../../utils/logger";
import type { SchemaDefinition } from "../../../types/schema";

/**
 * Parse CREATE SCHEMA statement from CST
 */
export function parseCreateSchema(node: any): SchemaDefinition | null {
  try {
    const name = extractSchemaName(node);
    if (!name) {
      Logger.warning('CREATE SCHEMA statement missing name');
      return null;
    }

    const owner = extractOwner(node);
    const ifNotExists = !!node.ifNotExistsKw;

    return {
      name,
      owner,
      ifNotExists,
    };
  } catch (error) {
    Logger.warning(
      `Failed to parse CREATE SCHEMA from CST: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Extract schema name from CST node
 */
function extractSchemaName(node: any): string | null {
  try {
    if (node.name?.name) {
      return node.name.name;
    }
    if (node.name?.text) {
      return node.name.text;
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract owner from AUTHORIZATION clause
 */
function extractOwner(node: any): string | undefined {
  try {
    const clauses = node.clauses || [];
    for (const clause of clauses) {
      if (clause.type === 'create_schema_authorization_clause') {
        return clause.role?.name || clause.role?.text;
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}
