import type { Table, ForeignKeyConstraint } from "../../types/schema";

export interface DependencyNode {
  tableName: string;
  dependencies: Set<string>; // Tables this table depends on
  dependents: Set<string>;   // Tables that depend on this table
}

export class DependencyResolver {
  private nodes: Map<string, DependencyNode> = new Map();

  constructor(tables: Table[]) {
    this.buildDependencyGraph(tables);
  }

  private buildDependencyGraph(tables: Table[]): void {
    // Initialize nodes for all tables
    for (const table of tables) {
      this.nodes.set(table.name, {
        tableName: table.name,
        dependencies: new Set(),
        dependents: new Set(),
      });
    }

    // Build dependency relationships from foreign keys
    for (const table of tables) {
      if (table.foreignKeys) {
        for (const fk of table.foreignKeys) {
          const referencedTable = fk.referencedTable;
          
          // Skip self-references for now (handled separately)
          if (referencedTable !== table.name) {
            const currentNode = this.nodes.get(table.name);
            const referencedNode = this.nodes.get(referencedTable);
            
            if (currentNode && referencedNode) {
              currentNode.dependencies.add(referencedTable);
              referencedNode.dependents.add(table.name);
            }
          }
        }
      }
    }
  }

  /**
   * Get tables ordered for creation (dependencies first)
   */
  getCreationOrder(): string[] {
    return this.topologicalSort(false);
  }

  /**
   * Get tables ordered for deletion (dependents first, then dependencies)
   */
  getDeletionOrder(): string[] {
    return this.topologicalSort(true);
  }

  /**
   * Topological sort using Kahn's algorithm for creation order
   */
  private topologicalSortCreation(): string[] {
    const inDegree = new Map<string, number>();
    
    // Initialize in-degree count for each table
    for (const tableName of this.nodes.keys()) {
      inDegree.set(tableName, 0);
    }
    
    // Count dependencies (incoming edges)
    for (const [tableName, node] of this.nodes) {
      for (const dependency of node.dependencies) {
        inDegree.set(tableName, (inDegree.get(tableName) || 0) + 1);
      }
    }

    const result: string[] = [];
    const queue: string[] = [];

    // Find tables with no dependencies
    for (const [tableName, degree] of inDegree) {
      if (degree === 0) {
        queue.push(tableName);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      // Remove this table's impact on its dependents
      const currentNode = this.nodes.get(current);
      if (currentNode) {
        for (const dependent of currentNode.dependents) {
          const newDegree = (inDegree.get(dependent) || 0) - 1;
          inDegree.set(dependent, newDegree);
          
          if (newDegree === 0) {
            queue.push(dependent);
          }
        }
      }
    }

    // Check for cycles
    if (result.length !== this.nodes.size) {
      throw new Error(
        `Circular dependency detected. Cannot resolve table creation order. ` +
        `Processed ${result.length} out of ${this.nodes.size} tables.`
      );
    }

    return result;
  }

  /**
   * Topological sort for deletion order (reverse of creation order)
   */
  private topologicalSortDeletion(): string[] {
    const inDegree = new Map<string, number>();
    
    // Initialize in-degree count - for deletion, we count dependents
    for (const tableName of this.nodes.keys()) {
      inDegree.set(tableName, 0);
    }
    
    // Count dependents (outgoing edges become incoming for deletion)
    for (const [tableName, node] of this.nodes) {
      for (const dependent of node.dependents) {
        inDegree.set(tableName, (inDegree.get(tableName) || 0) + 1);
      }
    }

    const result: string[] = [];
    const queue: string[] = [];

    // Find tables with no dependents (can be deleted first)
    for (const [tableName, degree] of inDegree) {
      if (degree === 0) {
        queue.push(tableName);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      // Remove this table's impact on its dependencies
      const currentNode = this.nodes.get(current);
      if (currentNode) {
        for (const dependency of currentNode.dependencies) {
          const newDegree = (inDegree.get(dependency) || 0) - 1;
          inDegree.set(dependency, newDegree);
          
          if (newDegree === 0) {
            queue.push(dependency);
          }
        }
      }
    }

    // Check for cycles
    if (result.length !== this.nodes.size) {
      throw new Error(
        `Circular dependency detected. Cannot resolve table deletion order. ` +
        `Processed ${result.length} out of ${this.nodes.size} tables.`
      );
    }

    return result;
  }

  /**
   * Unified topological sort method
   */
  private topologicalSort(reverse: boolean): string[] {
    return reverse ? this.topologicalSortDeletion() : this.topologicalSortCreation();
  }

  /**
   * Detect circular dependencies
   */
  hasCircularDependencies(): boolean {
    try {
      this.getCreationOrder();
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Get circular dependency chains for debugging
   */
  getCircularDependencies(): string[][] {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycles: string[][] = [];

    const dfs = (tableName: string, path: string[]): void => {
      if (recursionStack.has(tableName)) {
        // Found a cycle
        const cycleStart = path.indexOf(tableName);
        if (cycleStart !== -1) {
          cycles.push([...path.slice(cycleStart), tableName]);
        }
        return;
      }

      if (visited.has(tableName)) {
        return;
      }

      visited.add(tableName);
      recursionStack.add(tableName);
      path.push(tableName);

      const node = this.nodes.get(tableName);
      if (node) {
        for (const dependency of node.dependencies) {
          dfs(dependency, [...path]);
        }
      }

      path.pop();
      recursionStack.delete(tableName);
    };

    for (const tableName of this.nodes.keys()) {
      if (!visited.has(tableName)) {
        dfs(tableName, []);
      }
    }

    return cycles;
  }
}