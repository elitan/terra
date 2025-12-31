import type { Table, ForeignKeyConstraint } from "../../types/schema";

export interface DependencyNode {
  tableName: string;
  dependencies: Set<string>; // Tables this table depends on
  dependents: Set<string>;   // Tables that depend on this table
}

export interface DetachmentResult {
  order: string[]; // Table creation/deletion order
  foreignKeysToDefer: Array<{ tableName: string; foreignKey: ForeignKeyConstraint }>; // FKs to add after all tables exist
}

export class DependencyResolver {
  private nodes: Map<string, DependencyNode> = new Map();
  private tables: Map<string, Table> = new Map();

  constructor(tables: Table[]) {
    // Store tables for FK access
    for (const table of tables) {
      this.tables.set(table.name, table);
    }
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

  private topologicalSortCreation(): string[] {
    return this.topologicalSortCore(this.nodes, false, 'creation');
  }

  private topologicalSortDeletion(): string[] {
    return this.topologicalSortCore(this.nodes, true, 'deletion');
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

  /**
   * Get creation order with FK detachment for circular dependencies.
   * Instead of throwing on cycles, identifies FKs to defer and returns valid creation order.
   */
  getCreationOrderWithDetachment(): DetachmentResult {
    // Check if there are cycles
    if (!this.hasCircularDependencies()) {
      // No cycles, return normal creation order with no deferred FKs
      return {
        order: this.getCreationOrder(),
        foreignKeysToDefer: [],
      };
    }

    // There are cycles - identify FKs involved in cycles
    const cycles = this.getCircularDependencies();
    const tablesInCycles = new Set<string>();

    for (const cycle of cycles) {
      for (const tableName of cycle) {
        tablesInCycles.add(tableName);
      }
    }

    // Identify FKs to defer (those pointing from one cycle table to another)
    const foreignKeysToDefer: Array<{ tableName: string; foreignKey: ForeignKeyConstraint }> = [];

    for (const tableName of tablesInCycles) {
      const table = this.tables.get(tableName);
      if (!table || !table.foreignKeys) continue;

      for (const fk of table.foreignKeys) {
        // Defer FK if it points to another table in a cycle (but not self-references)
        if (tablesInCycles.has(fk.referencedTable) && fk.referencedTable !== tableName) {
          foreignKeysToDefer.push({ tableName, foreignKey: fk });
        }
      }
    }

    // Build a new dependency graph without the deferred FKs
    const modifiedNodes = new Map<string, DependencyNode>();

    // Initialize nodes
    for (const tableName of this.nodes.keys()) {
      modifiedNodes.set(tableName, {
        tableName,
        dependencies: new Set(),
        dependents: new Set(),
      });
    }

    // Build dependencies, skipping deferred FKs
    const deferredSet = new Set(
      foreignKeysToDefer.map(item => `${item.tableName}->${item.foreignKey.referencedTable}`)
    );

    for (const [tableName, node] of this.nodes) {
      for (const dep of node.dependencies) {
        const key = `${tableName}->${dep}`;
        if (!deferredSet.has(key)) {
          modifiedNodes.get(tableName)!.dependencies.add(dep);
          modifiedNodes.get(dep)!.dependents.add(tableName);
        }
      }
    }

    const order = this.topologicalSortCore(modifiedNodes, false);

    return {
      order,
      foreignKeysToDefer,
    };
  }

  /**
   * Get deletion order with FK detachment for circular dependencies.
   * Identifies FKs that must be dropped before dropping tables in cycles.
   */
  getDeletionOrderWithDetachment(): DetachmentResult {
    // Check if there are cycles
    if (!this.hasCircularDependencies()) {
      // No cycles, return normal deletion order with no FKs to drop
      return {
        order: this.getDeletionOrder(),
        foreignKeysToDefer: [], // For deletion, this represents FKs to drop first
      };
    }

    // There are cycles - identify FKs involved in cycles
    const cycles = this.getCircularDependencies();
    const tablesInCycles = new Set<string>();

    for (const cycle of cycles) {
      for (const tableName of cycle) {
        tablesInCycles.add(tableName);
      }
    }

    // Identify FKs to drop first (those pointing from one cycle table to another)
    const foreignKeysToDrop: Array<{ tableName: string; foreignKey: ForeignKeyConstraint }> = [];

    for (const tableName of tablesInCycles) {
      const table = this.tables.get(tableName);
      if (!table || !table.foreignKeys) continue;

      for (const fk of table.foreignKeys) {
        // Drop FK if it points to another table in a cycle (but not self-references)
        if (tablesInCycles.has(fk.referencedTable) && fk.referencedTable !== tableName) {
          foreignKeysToDrop.push({ tableName, foreignKey: fk });
        }
      }
    }

    // Build a new dependency graph without the cycle-forming FKs
    const modifiedNodes = new Map<string, DependencyNode>();

    // Initialize nodes
    for (const tableName of this.nodes.keys()) {
      modifiedNodes.set(tableName, {
        tableName,
        dependencies: new Set(),
        dependents: new Set(),
      });
    }

    // Build dependencies, skipping cycle-forming FKs
    const dropSet = new Set(
      foreignKeysToDrop.map(item => `${item.tableName}->${item.foreignKey.referencedTable}`)
    );

    for (const [tableName, node] of this.nodes) {
      for (const dep of node.dependencies) {
        const key = `${tableName}->${dep}`;
        if (!dropSet.has(key)) {
          modifiedNodes.get(tableName)!.dependencies.add(dep);
          modifiedNodes.get(dep)!.dependents.add(tableName);
        }
      }
    }

    const order = this.topologicalSortCore(modifiedNodes, true);

    return {
      order,
      foreignKeysToDefer: foreignKeysToDrop, // These are FKs to drop first
    };
  }

  /**
   * Core topological sort implementation using Kahn's algorithm.
   * @param nodes - Dependency graph nodes
   * @param reverse - false for creation order, true for deletion order
   * @param mode - 'creation'/'deletion' for detailed cycle errors, 'internal' for simple errors
   */
  private topologicalSortCore(
    nodes: Map<string, DependencyNode>,
    reverse: boolean,
    mode: 'creation' | 'deletion' | 'internal' = 'internal'
  ): string[] {
    const inDegree = new Map<string, number>();

    for (const tableName of nodes.keys()) {
      inDegree.set(tableName, 0);
    }

    if (!reverse) {
      for (const [tableName, node] of nodes) {
        for (const dependency of node.dependencies) {
          inDegree.set(tableName, (inDegree.get(tableName) || 0) + 1);
        }
      }
    } else {
      for (const [tableName, node] of nodes) {
        for (const dependent of node.dependents) {
          inDegree.set(tableName, (inDegree.get(tableName) || 0) + 1);
        }
      }
    }

    const result: string[] = [];
    const queue: string[] = [];

    for (const [tableName, degree] of inDegree) {
      if (degree === 0) {
        queue.push(tableName);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      const currentNode = nodes.get(current);
      if (currentNode) {
        const neighbors = reverse ? currentNode.dependencies : currentNode.dependents;
        for (const neighbor of neighbors) {
          const newDegree = (inDegree.get(neighbor) || 0) - 1;
          inDegree.set(neighbor, newDegree);

          if (newDegree === 0) {
            queue.push(neighbor);
          }
        }
      }
    }

    if (result.length !== nodes.size) {
      if (mode === 'internal') {
        throw new Error(
          `Internal error: topological sort failed even after removing cycle-forming edges. ` +
          `Processed ${result.length} out of ${nodes.size} tables.`
        );
      }

      const cycles = this.getCircularDependencies();
      if (cycles.length > 0) {
        const cycleDescriptions = cycles.map(cycle => cycle.join(' → ')).join('\n  ');
        const orderType = mode === 'creation' ? 'creation' : 'deletion';
        throw new Error(
          `Circular dependency detected. Cannot resolve table ${orderType} order.\n` +
          `Detected cycles:\n  ${cycleDescriptions}\n` +
          `Tables involved in cycles cannot be ${mode === 'creation' ? 'created because they reference each other' : 'deleted in a valid order'}.`
        );
      }
      const orderType = mode === 'creation' ? 'creation' : 'deletion';
      throw new Error(
        `Cannot resolve table ${orderType} order. ` +
        `Processed ${result.length} out of ${nodes.size} tables.`
      );
    }

    return result;
  }
}