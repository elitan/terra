import { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import type { EnumType } from "../../types/schema";
import { SchemaParser } from "./parser";
import { DatabaseInspector } from "./inspector";
import { MigrationPlanner } from "../migration/planner";
import { MigrationExecutor } from "../migration/executor";
import { DatabaseService } from "../database/client";
import { Logger } from "../../utils/logger";

export class SchemaService {
  private parser: SchemaParser;
  private inspector: DatabaseInspector;
  private planner: MigrationPlanner;
  private executor: MigrationExecutor;
  private databaseService: DatabaseService;

  constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService;
    this.parser = new SchemaParser();
    this.inspector = new DatabaseInspector();
    this.planner = new MigrationPlanner();
    this.executor = new MigrationExecutor(databaseService);
  }

  async plan(schemaFile: string = "schema.sql"): Promise<MigrationPlan> {
    Logger.info("📋 Analyzing schema changes...");

    const client = await this.databaseService.createClient();

    try {
      const parsedSchema = this.parseSchemaInput(schemaFile);
      const desiredSchema = Array.isArray(parsedSchema) ? parsedSchema : parsedSchema.tables;
      const currentSchema = await this.inspector.getCurrentSchema(client);
      const plan = this.planner.generatePlan(desiredSchema, currentSchema);

      if (!plan.hasChanges) {
        Logger.success("✓ No changes needed - database is up to date");
      } else {
        const totalChanges = plan.transactional.length + plan.concurrent.length;
        Logger.warning(`📝 Found ${totalChanges} change(s) to apply:`);
        console.log();

        if (plan.transactional.length > 0) {
          Logger.info("Transactional changes:");
          plan.transactional.forEach((stmt, i) => {
            Logger.cyan(`  ${i + 1}. ${stmt}`);
          });
        }

        if (plan.concurrent.length > 0) {
          Logger.info("Concurrent changes (non-transactional):");
          plan.concurrent.forEach((stmt, i) => {
            Logger.cyan(`  ${i + 1}. ${stmt}`);
          });
        }
      }

      return plan;
    } finally {
      await client.end();
    }
  }

  async apply(schemaFile: string = "schema.sql"): Promise<void> {
    Logger.info("🚀 Applying schema changes...");

    const client = await this.databaseService.createClient();

    try {
      const parsedSchema = this.parseSchemaInput(schemaFile);
      const desiredSchema = Array.isArray(parsedSchema) ? parsedSchema : parsedSchema.tables;
      const desiredEnums = Array.isArray(parsedSchema) ? [] : parsedSchema.enums;
      const currentSchema = await this.inspector.getCurrentSchema(client);
      const currentEnums = await this.inspector.getCurrentEnums(client);
      
      // Generate ENUM statements with collision detection
      const enumStatements = this.generateEnumStatements(desiredEnums, currentEnums);
      
      const plan = this.planner.generatePlan(desiredSchema, currentSchema);
      
      // Prepend ENUM creation statements 
      plan.transactional = [...enumStatements, ...plan.transactional];

      // Execute table changes first
      await this.executor.executePlan(client, plan);

      // After table changes, safely remove unused ENUMs
      const enumRemovalStatements = await this.generateEnumRemovalStatements(desiredEnums, currentEnums, client);
      if (enumRemovalStatements.length > 0) {
        const removalPlan = {
          transactional: enumRemovalStatements,
          concurrent: [],
          hasChanges: true
        };
        await this.executor.executePlan(client, removalPlan);
      }
    } finally {
      await client.end();
    }
  }

  private parseSchemaInput(input: string) {
    // Handle empty string as empty SQL content (not a filename)
    if (input === "") {
      return this.parser.parseSchema(input);
    }
    
    // Simple heuristic: if the input contains SQL keywords and is longer than a typical file path,
    // or contains newlines/semicolons, treat it as SQL content rather than a file path
    if (
      input.includes('CREATE') || 
      input.includes(';') || 
      input.includes('\n') || 
      input.length > 500
    ) {
      return this.parser.parseSchema(input);
    } else {
      // parseSchemaFile returns Table[], so wrap it in the expected format
      const tables = this.parser.parseSchemaFile(input);
      return { tables, enums: [] };
    }
  }

  private generateEnumStatements(desiredEnums: EnumType[], currentEnums: EnumType[]): string[] {
    const statements: string[] = [];
    const currentEnumMap = new Map(currentEnums.map(e => [e.name, e]));
    
    for (const desiredEnum of desiredEnums) {
      const currentEnum = currentEnumMap.get(desiredEnum.name);
      
      if (!currentEnum) {
        // ENUM doesn't exist, create it
        statements.push(this.generateCreateTypeStatement(desiredEnum));
      } else {
        // ENUM exists, check if values need to be modified
        const currentValues = currentEnum.values;
        const desiredValues = desiredEnum.values;
        
        // Check if values are identical in order and content
        if (JSON.stringify(currentValues) === JSON.stringify(desiredValues)) {
          // Values match exactly, skip modification
          Logger.info(`✓ ENUM type '${desiredEnum.name}' already exists with matching values, skipping creation`);
        } else {
          // Values differ, generate modification statements
          const modificationStatements = this.generateEnumModificationStatements(desiredEnum, currentEnum);
          statements.push(...modificationStatements);
        }
      }
    }
    
    // Note: ENUM removal is handled separately after table changes
    
    return statements;
  }

  private async generateEnumRemovalStatements(desiredEnums: EnumType[], currentEnums: EnumType[], client: Client): Promise<string[]> {
    const statements: string[] = [];
    const desiredEnumNames = new Set(desiredEnums.map(e => e.name));
    
    for (const currentEnum of currentEnums) {
      if (!desiredEnumNames.has(currentEnum.name)) {
        // ENUM is not in desired schema, check if it's safe to drop
        const isUsed = await this.isEnumTypeUsed(currentEnum.name, client);
        
        if (!isUsed) {
          statements.push(`DROP TYPE ${currentEnum.name};`);
          Logger.info(`✓ Dropping unused ENUM type '${currentEnum.name}'`);
        } else {
          Logger.warning(
            `⚠️ ENUM type '${currentEnum.name}' is not in schema but is still referenced by table columns. ` +
            `Cannot auto-drop. Remove column references first.`
          );
        }
      }
    }
    
    return statements;
  }

  private async isEnumTypeUsed(enumName: string, client: Client): Promise<boolean> {
    const result = await client.query(`
      SELECT COUNT(*) as usage_count
      FROM information_schema.columns 
      WHERE udt_name = $1 AND table_schema = 'public'
    `, [enumName]);
    
    return parseInt(result.rows[0].usage_count) > 0;
  }

  private generateEnumModificationStatements(desiredEnum: EnumType, currentEnum: EnumType): string[] {
    const statements: string[] = [];
    const currentValues = new Set(currentEnum.values);
    const desiredValues = new Set(desiredEnum.values);
    
    // Find values to add
    const valuesToAdd = desiredEnum.values.filter(value => !currentValues.has(value));
    
    // Find values to remove  
    const valuesToRemove = currentEnum.values.filter(value => !desiredValues.has(value));
    
    // Check if values are identical in order and content
    const valuesIdentical = JSON.stringify(currentEnum.values) === JSON.stringify(desiredEnum.values);
    
    // Check if only appending new values at the end (safe case)
    const isOnlyAppending = valuesToRemove.length === 0 && valuesToAdd.length > 0 &&
                           currentEnum.values.every((value, index) => desiredEnum.values[index] === value);
    
    if (valuesIdentical) {
      // No changes needed
      Logger.info(`✓ ENUM type '${desiredEnum.name}' values already match, no changes needed`);
    } else if (isOnlyAppending) {
      // Only adding values at the end - safe operation using ALTER TYPE ADD VALUE
      for (const value of valuesToAdd) {
        statements.push(`ALTER TYPE ${desiredEnum.name} ADD VALUE '${value}';`);
        Logger.info(`✓ Adding value '${value}' to ENUM type '${desiredEnum.name}'`);
      }
    } else {
      // Values are removed or reordered - this requires manual intervention
      const changeDescription = [];
      if (valuesToRemove.length > 0) {
        changeDescription.push(`removing values [${valuesToRemove.join(', ')}]`);
      }
      if (valuesToRemove.length === 0 && valuesToAdd.length === 0) {
        // Same values but different order = reordering
        changeDescription.push(`reordering values`);
      }
      
      throw new Error(
        `ENUM type '${desiredEnum.name}' modification requires manual intervention. ` +
        `Cannot safely perform: ${changeDescription.join(' and ')}. ` +
        `Current values: [${currentEnum.values.join(', ')}], ` +
        `Desired values: [${desiredEnum.values.join(', ')}]. ` +
        `Removing ENUM values or changing their order can cause data loss and is not supported by pgterra. ` +
        `Please handle this migration manually or create a new ENUM type with a different name.`
      );
    }
    
    return statements;
  }

  private generateCreateTypeStatement(enumType: EnumType): string {
    const values = enumType.values.map(value => `'${value}'`).join(', ');
    return `CREATE TYPE ${enumType.name} AS ENUM (${values});`;
  }
}
