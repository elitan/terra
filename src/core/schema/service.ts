import { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import type { EnumType, View, Function, Procedure, Trigger, Sequence } from "../../types/schema";
import { SchemaParser } from "./parser";
import { DatabaseInspector } from "./inspector";
import { SchemaDiffer } from "./differ";
import { MigrationExecutor } from "../migration/executor";
import { DatabaseService } from "../database/client";
import { Logger } from "../../utils/logger";
import {
  generateCreateViewSQL,
  generateDropViewSQL,
  generateCreateOrReplaceViewSQL,
  generateCreateFunctionSQL,
  generateDropFunctionSQL,
  generateCreateProcedureSQL,
  generateDropProcedureSQL,
  generateCreateTriggerSQL,
  generateDropTriggerSQL,
  generateCreateSequenceSQL,
  generateDropSequenceSQL,
} from "../../utils/sql";

export class SchemaService {
  private parser: SchemaParser;
  private inspector: DatabaseInspector;
  private differ: SchemaDiffer;
  private executor: MigrationExecutor;
  private databaseService: DatabaseService;

  constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService;
    this.parser = new SchemaParser();
    this.inspector = new DatabaseInspector();
    this.differ = new SchemaDiffer();
    this.executor = new MigrationExecutor(databaseService);
  }

  async plan(schemaFile: string = "schema.sql"): Promise<MigrationPlan> {
    Logger.info("Analyzing schema changes...");

    const client = await this.databaseService.createClient();

    try {
      const parsedSchema = this.parseSchemaInput(schemaFile);
      const desiredSchema = Array.isArray(parsedSchema) ? parsedSchema : parsedSchema.tables;
      const currentSchema = await this.inspector.getCurrentSchema(client);
      const plan = this.differ.generateMigrationPlan(desiredSchema, currentSchema);

      if (!plan.hasChanges) {
        Logger.success("No changes needed - database is up to date");
      } else {
        const totalChanges = plan.transactional.length + plan.concurrent.length;
        Logger.warning(`Found ${totalChanges} change(s) to apply:`);
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

  async apply(schemaFile: string = "schema.sql", autoApprove: boolean = false): Promise<void> {
    Logger.info("Analyzing schema changes...");

    const client = await this.databaseService.createClient();

    try {
      const parsedSchema = this.parseSchemaInput(schemaFile);
      const desiredSchema = Array.isArray(parsedSchema) ? parsedSchema : parsedSchema.tables;
      const desiredEnums = Array.isArray(parsedSchema) ? [] : parsedSchema.enums;
      const desiredViews = Array.isArray(parsedSchema) ? [] : parsedSchema.views;
      const desiredFunctions = Array.isArray(parsedSchema) ? [] : parsedSchema.functions;
      const desiredProcedures = Array.isArray(parsedSchema) ? [] : parsedSchema.procedures;
      const desiredTriggers = Array.isArray(parsedSchema) ? [] : parsedSchema.triggers;
      const desiredSequences = Array.isArray(parsedSchema) ? [] : parsedSchema.sequences;

      const currentSchema = await this.inspector.getCurrentSchema(client);
      const currentEnums = await this.inspector.getCurrentEnums(client);
      const currentViews = await this.inspector.getCurrentViews(client);
      const currentFunctions = await this.inspector.getCurrentFunctions(client);
      const currentProcedures = await this.inspector.getCurrentProcedures(client);
      const currentTriggers = await this.inspector.getCurrentTriggers(client);
      const currentSequences = await this.inspector.getCurrentSequences(client);

      // Generate ENUM statements with collision detection
      const enumStatements = this.generateEnumStatements(desiredEnums, currentEnums);

      const plan = this.differ.generateMigrationPlan(desiredSchema, currentSchema);

      // Prepend ENUM creation statements
      plan.transactional = [...enumStatements, ...plan.transactional];

      // Generate statements for new features
      const sequenceStatements = this.generateSequenceStatements(desiredSequences, currentSequences);
      const functionStatements = this.generateFunctionStatements(desiredFunctions, currentFunctions);
      const procedureStatements = this.generateProcedureStatements(desiredProcedures, currentProcedures);
      const viewStatements = this.generateViewStatements(desiredViews, currentViews);
      const triggerStatements = this.generateTriggerStatements(desiredTriggers, currentTriggers);

      // Calculate total changes
      const totalChanges = plan.transactional.length + plan.concurrent.length +
                          sequenceStatements.length + functionStatements.length +
                          procedureStatements.length + viewStatements.length +
                          triggerStatements.length;

      // Show plan
      if (totalChanges === 0) {
        Logger.success("No changes needed - database is up to date");
        return;
      }

      Logger.warning(`Found ${totalChanges} change(s) to apply:`);
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

      if (sequenceStatements.length > 0) {
        Logger.info("Sequence changes:");
        sequenceStatements.forEach((stmt, i) => {
          Logger.cyan(`  ${i + 1}. ${stmt}`);
        });
      }

      if (functionStatements.length > 0) {
        Logger.info("Function changes:");
        functionStatements.forEach((stmt, i) => {
          Logger.cyan(`  ${i + 1}. ${stmt}`);
        });
      }

      if (procedureStatements.length > 0) {
        Logger.info("Procedure changes:");
        procedureStatements.forEach((stmt, i) => {
          Logger.cyan(`  ${i + 1}. ${stmt}`);
        });
      }

      if (viewStatements.length > 0) {
        Logger.info("View changes:");
        viewStatements.forEach((stmt, i) => {
          Logger.cyan(`  ${i + 1}. ${stmt}`);
        });
      }

      if (triggerStatements.length > 0) {
        Logger.info("Trigger changes:");
        triggerStatements.forEach((stmt, i) => {
          Logger.cyan(`  ${i + 1}. ${stmt}`);
        });
      }

      console.log();

      // Prompt for confirmation unless auto-approve is enabled
      if (!autoApprove) {
        const confirmed = await this.promptForConfirmation();
        if (!confirmed) {
          Logger.info("Apply cancelled");
          return;
        }
      }

      Logger.info("Applying schema changes...");

      // Execute in dependency order:
      // 1. Sequences (may be referenced by table defaults)
      if (sequenceStatements.length > 0) {
        const sequencePlan = {
          transactional: sequenceStatements,
          concurrent: [],
          hasChanges: true
        };
        await this.executor.executePlan(client, sequencePlan, autoApprove);
      }

      // 2. Tables and enums
      await this.executor.executePlan(client, plan, autoApprove);

      // After table changes, safely remove unused ENUMs
      const enumRemovalStatements = await this.generateEnumRemovalStatements(desiredEnums, currentEnums, client);
      if (enumRemovalStatements.length > 0) {
        const removalPlan = {
          transactional: enumRemovalStatements,
          concurrent: [],
          hasChanges: true
        };
        await this.executor.executePlan(client, removalPlan, autoApprove);
      }

      // 3. Functions and procedures (triggers depend on functions)
      if (functionStatements.length > 0) {
        const functionPlan = {
          transactional: functionStatements,
          concurrent: [],
          hasChanges: true
        };
        await this.executor.executePlan(client, functionPlan, autoApprove);
      }

      if (procedureStatements.length > 0) {
        const procedurePlan = {
          transactional: procedureStatements,
          concurrent: [],
          hasChanges: true
        };
        await this.executor.executePlan(client, procedurePlan, autoApprove);
      }

      // 4. Views
      if (viewStatements.length > 0) {
        const viewPlan = {
          transactional: viewStatements,
          concurrent: [],
          hasChanges: true
        };
        await this.executor.executePlan(client, viewPlan, autoApprove);
      }

      // 5. Triggers (must come after tables, functions, and views)
      if (triggerStatements.length > 0) {
        const triggerPlan = {
          transactional: triggerStatements,
          concurrent: [],
          hasChanges: true
        };
        await this.executor.executePlan(client, triggerPlan, autoApprove);
      }
    } finally {
      await client.end();
    }
  }

  private async promptForConfirmation(): Promise<boolean> {
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question('Do you want to apply these changes? (yes/no): ', (answer) => {
        rl.close();
        const normalized = answer.trim().toLowerCase();
        resolve(normalized === 'yes' || normalized === 'y');
      });
    });
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
      // Treat as file path
      return this.parser.parseSchemaFile(input);
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
          Logger.info(`ENUM type '${desiredEnum.name}' already exists with matching values, skipping creation`);
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
          Logger.info(`Dropping unused ENUM type '${currentEnum.name}'`);
        } else {
          Logger.warning(
            `ENUM type '${currentEnum.name}' is not in schema but is still referenced by table columns. ` +
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
      Logger.info(`ENUM type '${desiredEnum.name}' values already match, no changes needed`);
    } else if (isOnlyAppending) {
      // Only adding values at the end - safe operation using ALTER TYPE ADD VALUE
      for (const value of valuesToAdd) {
        statements.push(`ALTER TYPE ${desiredEnum.name} ADD VALUE '${value}';`);
        Logger.info(`Adding value '${value}' to ENUM type '${desiredEnum.name}'`);
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
        `Removing ENUM values or changing their order can cause data loss and is not supported by Terra. ` +
        `Please handle this migration manually or create a new ENUM type with a different name.`
      );
    }
    
    return statements;
  }

  private generateCreateTypeStatement(enumType: EnumType): string {
    const values = enumType.values.map(value => `'${value}'`).join(', ');
    return `CREATE TYPE ${enumType.name} AS ENUM (${values});`;
  }

  private generateViewStatements(desiredViews: View[], currentViews: View[]): string[] {
    const statements: string[] = [];
    const currentViewMap = new Map(currentViews.map(v => [v.name, v]));
    const desiredViewNames = new Set(desiredViews.map(v => v.name));
    
    // Drop views that are no longer needed
    for (const currentView of currentViews) {
      if (!desiredViewNames.has(currentView.name)) {
        statements.push(generateDropViewSQL(currentView.name, currentView.materialized));
        Logger.info(`Dropping view '${currentView.name}'`);
      }
    }
    
    // Create or update views
    for (const desiredView of desiredViews) {
      const currentView = currentViewMap.get(desiredView.name);
      
      if (!currentView) {
        // View doesn't exist, create it
        statements.push(generateCreateViewSQL(desiredView));
        Logger.info(`Creating view '${desiredView.name}'`);
      } else {
        // View exists, check if it needs to be updated
        if (this.viewNeedsUpdate(desiredView, currentView)) {
          statements.push(generateCreateOrReplaceViewSQL(desiredView));
          Logger.info(`Updating view '${desiredView.name}'`);
        } else {
          Logger.info(`View '${desiredView.name}' is up to date, skipping`);
        }
      }
    }
    
    return statements;
  }

  private viewNeedsUpdate(desired: View, current: View): boolean {
    // Check if materialized flag differs
    if (desired.materialized !== current.materialized) {
      return true;
    }

    // Check if definition differs (normalize whitespace for comparison)
    const normalizeDefinition = (def: string) => def.replace(/\s+/g, ' ').trim();
    const normalizedDesired = normalizeDefinition(desired.definition);
    const normalizedCurrent = normalizeDefinition(current.definition);

    if (normalizedDesired !== normalizedCurrent) {
      // Add some debugging for the test
      Logger.info(`View '${desired.name}' needs update:`);
      Logger.info(`  Desired: ${normalizedDesired.substring(0, 100)}...`);
      Logger.info(`  Current: ${normalizedCurrent.substring(0, 100)}...`);
      return true;
    }

    // Check if check options differ
    if (desired.checkOption !== current.checkOption) {
      return true;
    }

    // Check if security barrier differs
    if (desired.securityBarrier !== current.securityBarrier) {
      return true;
    }

    return false;
  }

  private generateSequenceStatements(desiredSequences: Sequence[], currentSequences: Sequence[]): string[] {
    const statements: string[] = [];
    const currentSequenceMap = new Map(currentSequences.map(s => [s.name, s]));
    const desiredSequenceNames = new Set(desiredSequences.map(s => s.name));

    // Drop sequences that are no longer needed
    for (const currentSeq of currentSequences) {
      if (!desiredSequenceNames.has(currentSeq.name)) {
        statements.push(generateDropSequenceSQL(currentSeq.name));
        Logger.info(`Dropping sequence '${currentSeq.name}'`);
      }
    }

    // Create or update sequences
    for (const desiredSeq of desiredSequences) {
      const currentSeq = currentSequenceMap.get(desiredSeq.name);

      if (!currentSeq) {
        statements.push(generateCreateSequenceSQL(desiredSeq));
        Logger.info(`Creating sequence '${desiredSeq.name}'`);
      } else {
        if (this.sequenceNeedsUpdate(desiredSeq, currentSeq)) {
          statements.push(generateDropSequenceSQL(currentSeq.name));
          statements.push(generateCreateSequenceSQL(desiredSeq));
          Logger.info(`Updating sequence '${desiredSeq.name}'`);
        } else {
          Logger.info(`Sequence '${desiredSeq.name}' is up to date, skipping`);
        }
      }
    }

    return statements;
  }

  private sequenceNeedsUpdate(desired: Sequence, current: Sequence): boolean {
    return desired.increment !== current.increment ||
           desired.minValue !== current.minValue ||
           desired.maxValue !== current.maxValue ||
           desired.start !== current.start ||
           desired.cache !== current.cache ||
           desired.cycle !== current.cycle;
  }

  private generateFunctionStatements(desiredFunctions: Function[], currentFunctions: Function[]): string[] {
    const statements: string[] = [];
    const currentFunctionMap = new Map(currentFunctions.map(f => [f.name, f]));
    const desiredFunctionNames = new Set(desiredFunctions.map(f => f.name));

    // Drop functions that are no longer needed
    for (const currentFunc of currentFunctions) {
      if (!desiredFunctionNames.has(currentFunc.name)) {
        statements.push(generateDropFunctionSQL(currentFunc));
        Logger.info(`Dropping function '${currentFunc.name}'`);
      }
    }

    // Create or update functions
    for (const desiredFunc of desiredFunctions) {
      const currentFunc = currentFunctionMap.get(desiredFunc.name);

      if (!currentFunc) {
        statements.push(generateCreateFunctionSQL(desiredFunc));
        Logger.info(`Creating function '${desiredFunc.name}'`);
      } else {
        if (this.functionNeedsUpdate(desiredFunc, currentFunc)) {
          statements.push(generateDropFunctionSQL(currentFunc));
          statements.push(generateCreateFunctionSQL(desiredFunc));
          Logger.info(`Updating function '${desiredFunc.name}'`);
        } else {
          Logger.info(`Function '${desiredFunc.name}' is up to date, skipping`);
        }
      }
    }

    return statements;
  }

  private functionNeedsUpdate(desired: Function, current: Function): boolean {
    const normalizeBody = (body: string) => body.replace(/\s+/g, ' ').trim();
    return normalizeBody(desired.body) !== normalizeBody(current.body) ||
           desired.returnType !== current.returnType ||
           desired.language !== current.language ||
           desired.volatility !== current.volatility;
  }

  private generateProcedureStatements(desiredProcedures: Procedure[], currentProcedures: Procedure[]): string[] {
    const statements: string[] = [];
    const currentProcedureMap = new Map(currentProcedures.map(p => [p.name, p]));
    const desiredProcedureNames = new Set(desiredProcedures.map(p => p.name));

    // Drop procedures that are no longer needed
    for (const currentProc of currentProcedures) {
      if (!desiredProcedureNames.has(currentProc.name)) {
        statements.push(generateDropProcedureSQL(currentProc));
        Logger.info(`Dropping procedure '${currentProc.name}'`);
      }
    }

    // Create or update procedures
    for (const desiredProc of desiredProcedures) {
      const currentProc = currentProcedureMap.get(desiredProc.name);

      if (!currentProc) {
        statements.push(generateCreateProcedureSQL(desiredProc));
        Logger.info(`Creating procedure '${desiredProc.name}'`);
      } else {
        if (this.procedureNeedsUpdate(desiredProc, currentProc)) {
          statements.push(generateDropProcedureSQL(currentProc));
          statements.push(generateCreateProcedureSQL(desiredProc));
          Logger.info(`Updating procedure '${desiredProc.name}'`);
        } else {
          Logger.info(`Procedure '${desiredProc.name}' is up to date, skipping`);
        }
      }
    }

    return statements;
  }

  private procedureNeedsUpdate(desired: Procedure, current: Procedure): boolean {
    const normalizeBody = (body: string) => body.replace(/\s+/g, ' ').trim();
    return normalizeBody(desired.body) !== normalizeBody(current.body) ||
           desired.language !== current.language;
  }

  private generateTriggerStatements(desiredTriggers: Trigger[], currentTriggers: Trigger[]): string[] {
    const statements: string[] = [];
    const currentTriggerMap = new Map(currentTriggers.map(t => [`${t.tableName}.${t.name}`, t]));
    const desiredTriggerKeys = new Set(desiredTriggers.map(t => `${t.tableName}.${t.name}`));

    // Drop triggers that are no longer needed
    for (const currentTrig of currentTriggers) {
      const key = `${currentTrig.tableName}.${currentTrig.name}`;
      if (!desiredTriggerKeys.has(key)) {
        statements.push(generateDropTriggerSQL(currentTrig));
        Logger.info(`Dropping trigger '${currentTrig.name}' on '${currentTrig.tableName}'`);
      }
    }

    // Create or update triggers
    for (const desiredTrig of desiredTriggers) {
      const key = `${desiredTrig.tableName}.${desiredTrig.name}`;
      const currentTrig = currentTriggerMap.get(key);

      if (!currentTrig) {
        statements.push(generateCreateTriggerSQL(desiredTrig));
        Logger.info(`Creating trigger '${desiredTrig.name}' on '${desiredTrig.tableName}'`);
      } else {
        if (this.triggerNeedsUpdate(desiredTrig, currentTrig)) {
          statements.push(generateDropTriggerSQL(currentTrig));
          statements.push(generateCreateTriggerSQL(desiredTrig));
          Logger.info(`Updating trigger '${desiredTrig.name}' on '${desiredTrig.tableName}'`);
        } else {
          Logger.info(`Trigger '${desiredTrig.name}' is up to date, skipping`);
        }
      }
    }

    return statements;
  }

  private triggerNeedsUpdate(desired: Trigger, current: Trigger): boolean {
    return desired.timing !== current.timing ||
           desired.forEach !== current.forEach ||
           desired.functionName !== current.functionName ||
           JSON.stringify(desired.events) !== JSON.stringify(current.events);
  }
}
