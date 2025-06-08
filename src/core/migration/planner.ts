import type { Table } from "../../types/schema";
import type { MigrationPlan } from "../../types/migration";
import { SchemaDiffer } from "../schema/differ";

export class MigrationPlanner {
  private differ: SchemaDiffer;

  constructor() {
    this.differ = new SchemaDiffer();
  }

  generatePlan(desiredSchema: Table[], currentSchema: Table[]): MigrationPlan {
    return this.differ.generateMigrationPlan(desiredSchema, currentSchema);
  }
}
