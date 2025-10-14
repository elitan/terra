import { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import type { EnumType, View, Function, Procedure, Trigger, Sequence, Extension, SchemaDefinition, Comment } from "../../types/schema";
import { SchemaParser } from "./parser";
import { DatabaseInspector } from "./inspector";
import { SchemaDiffer } from "./differ";
import { MigrationExecutor } from "../migration/executor";
import { DatabaseService, type AdvisoryLockOptions } from "../database/client";
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

  async plan(schemaFile: string): Promise<MigrationPlan> {
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

  async apply(
    schemaFile: string,
    schemas: string[] = ['public'],
    autoApprove: boolean = false,
    lockOptions?: AdvisoryLockOptions,
    dryRun: boolean = false
  ): Promise<void> {
    const client = await this.databaseService.createClient();

    try {
      // Acquire advisory lock if options provided (skip in dry-run mode)
      if (lockOptions && !dryRun) {
        await this.databaseService.acquireAdvisoryLock(client, lockOptions);
      }
      const parsedSchema = this.parseSchemaInput(schemaFile);
      const desiredSchema = Array.isArray(parsedSchema) ? parsedSchema : parsedSchema.tables;
      const desiredEnums = Array.isArray(parsedSchema) ? [] : parsedSchema.enums;
      const desiredViews = Array.isArray(parsedSchema) ? [] : parsedSchema.views;
      const desiredFunctions = Array.isArray(parsedSchema) ? [] : parsedSchema.functions;
      const desiredProcedures = Array.isArray(parsedSchema) ? [] : parsedSchema.procedures;
      const desiredTriggers = Array.isArray(parsedSchema) ? [] : parsedSchema.triggers;
      const desiredSequences = Array.isArray(parsedSchema) ? [] : parsedSchema.sequences;
      const desiredExtensions = Array.isArray(parsedSchema) ? [] : parsedSchema.extensions;
      const desiredSchemas = Array.isArray(parsedSchema) ? [] : parsedSchema.schemas || [];
      const desiredComments = Array.isArray(parsedSchema) ? [] : parsedSchema.comments || [];

      // Validate that all schema references are in the managed schemas list
      this.validateSchemaReferences(schemas, desiredSchema, desiredEnums, desiredViews,
        desiredFunctions, desiredProcedures, desiredTriggers, desiredSequences);

      const currentSchema = await this.inspector.getCurrentSchema(client, schemas);
      const currentEnums = await this.inspector.getCurrentEnums(client, schemas);
      const currentViews = await this.inspector.getCurrentViews(client, schemas);
      const currentFunctions = await this.inspector.getCurrentFunctions(client, schemas);
      const currentProcedures = await this.inspector.getCurrentProcedures(client, schemas);
      const currentTriggers = await this.inspector.getCurrentTriggers(client, schemas);
      const currentSequences = await this.inspector.getCurrentSequences(client, schemas);
      const currentExtensions = await this.inspector.getCurrentExtensions(client, schemas);
      const currentSchemas = await this.inspector.getCurrentSchemas(client, schemas);
      const currentComments = await this.inspector.getCurrentComments(client, schemas);

      // Generate schema statements (CREATE first)
      const schemaStatements = this.generateSchemaStatements(desiredSchemas, currentSchemas);

      // Generate extension statements (CREATE first, DROP last)
      const { create: extensionCreateStatements, drop: extensionDropStatements } =
        this.generateExtensionStatements(desiredExtensions, currentExtensions);

      // Generate ENUM statements with collision detection
      const enumStatements = this.generateEnumStatements(desiredEnums, currentEnums);

      const plan = this.differ.generateMigrationPlan(desiredSchema, currentSchema);

      // Prepend schema CREATE, extension CREATE, and ENUM creation statements
      plan.transactional = [...schemaStatements, ...extensionCreateStatements, ...enumStatements, ...plan.transactional];

      // Generate statements for new features
      const sequenceStatements = this.generateSequenceStatements(desiredSequences, currentSequences);
      const functionStatements = this.generateFunctionStatements(desiredFunctions, currentFunctions);
      const procedureStatements = this.generateProcedureStatements(desiredProcedures, currentProcedures);
      const viewStatements = this.generateViewStatements(desiredViews, currentViews);
      const triggerStatements = this.generateTriggerStatements(desiredTriggers, currentTriggers);
      const commentStatements = this.generateCommentStatements(desiredComments, currentComments);

      // Calculate total changes
      const totalChanges = plan.transactional.length + plan.concurrent.length +
                          sequenceStatements.length + functionStatements.length +
                          procedureStatements.length + viewStatements.length +
                          triggerStatements.length + commentStatements.length + extensionDropStatements.length;

      // Show plan
      if (totalChanges === 0) {
        Logger.success("No changes needed - database is up to date");
        return;
      }

      const { OutputFormatter } = await import("../../utils/output-formatter");

      Logger.print(OutputFormatter.summary(`${totalChanges} changes`));

      // Combine all transactional statements (comments executed separately after all objects created)
      const allTransactional = [
        ...plan.transactional,
        ...sequenceStatements,
        ...functionStatements,
        ...procedureStatements,
        ...viewStatements,
        ...triggerStatements
      ];

      if (allTransactional.length > 0) {
        Logger.print(OutputFormatter.section("Transactional"));
        Logger.print(OutputFormatter.box(allTransactional));
      }

      if (plan.concurrent.length > 0) {
        Logger.print(OutputFormatter.warningSection("Concurrent (non-transactional)"));
        Logger.print(OutputFormatter.box(plan.concurrent));
      }

      console.log();

      // Exit early if dry-run mode
      if (dryRun) {
        Logger.info("Dry run complete - no changes were made");
        return;
      }

      // Prompt for confirmation unless auto-approve is enabled
      if (!autoApprove) {
        const confirmed = await this.promptForConfirmation();
        if (!confirmed) {
          Logger.info("Apply cancelled");
          return;
        }
      }

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
      const enumRemovalStatements = await this.generateEnumRemovalStatements(desiredEnums, currentEnums, client, schemas);
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

      // 6. Comments (must come after all objects are created)
      if (commentStatements.length > 0) {
        const commentPlan = {
          transactional: commentStatements,
          concurrent: [],
          hasChanges: true
        };
        await this.executor.executePlan(client, commentPlan, autoApprove);
      }

      // 7. Drop extensions (must come LAST, after all dependent objects are dropped)
      if (extensionDropStatements.length > 0) {
        const extensionDropPlan = {
          transactional: extensionDropStatements,
          concurrent: [],
          hasChanges: true
        };
        await this.executor.executePlan(client, extensionDropPlan, autoApprove);
      }
    } finally {
      // Release advisory lock if it was acquired (skip in dry-run mode)
      if (lockOptions && !dryRun) {
        await this.databaseService.releaseAdvisoryLock(client, lockOptions.lockName);
      }
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

  private async generateEnumRemovalStatements(desiredEnums: EnumType[], currentEnums: EnumType[], client: Client, schemas: string[]): Promise<string[]> {
    const statements: string[] = [];
    const desiredEnumNames = new Set(desiredEnums.map(e => e.name));

    for (const currentEnum of currentEnums) {
      if (!desiredEnumNames.has(currentEnum.name)) {
        // ENUM is not in desired schema, check if it's safe to drop
        const isUsed = await this.isEnumTypeUsed(currentEnum.name, client, schemas);
        
        if (!isUsed) {
          const fullName = currentEnum.schema ? `${currentEnum.schema}.${currentEnum.name}` : currentEnum.name;
          statements.push(`DROP TYPE ${fullName};`);
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

  private async isEnumTypeUsed(enumName: string, client: Client, schemas: string[]): Promise<boolean> {
    const result = await client.query(`
      SELECT COUNT(*) as usage_count
      FROM information_schema.columns
      WHERE udt_name = $1 AND table_schema = ANY($2::text[])
    `, [enumName, schemas]);

    return parseInt(result.rows[0].usage_count) > 0;
  }

  private validateSchemaReferences(
    managedSchemas: string[],
    tables: any[],
    enums: any[],
    views: any[],
    functions: any[],
    procedures: any[],
    triggers: any[],
    sequences: any[]
  ): void {
    const errors: string[] = [];

    // Helper to check schema reference
    const checkSchema = (objType: string, objName: string, objSchema: string | undefined) => {
      const schema = objSchema || 'public'; // Default to 'public' if not specified
      if (!managedSchemas.includes(schema)) {
        errors.push(`${objType} '${objSchema ? objSchema + '.' : ''}${objName}' references schema '${schema}' which is not in the managed schema list: [${managedSchemas.join(', ')}]`);
      }
    };

    // Check all object types
    tables.forEach(t => checkSchema('Table', t.name, t.schema));
    enums.forEach(e => checkSchema('ENUM type', e.name, e.schema));
    views.forEach(v => checkSchema('View', v.name, v.schema));
    functions.forEach(f => checkSchema('Function', f.name, f.schema));
    procedures.forEach(p => checkSchema('Procedure', p.name, p.schema));
    triggers.forEach(t => checkSchema('Trigger', t.name, t.schema));
    sequences.forEach(s => checkSchema('Sequence', s.name, s.schema));

    if (errors.length > 0) {
      throw new Error(
        `Schema validation failed:\n${errors.join('\n')}\n\n` +
        `To fix this, either:\n` +
        `1. Add the missing schema(s) using -s flag: terra apply -s ${managedSchemas.join(' -s ')} -s <missing_schema>\n` +
        `2. Remove or modify the objects to use only managed schemas`
      );
    }
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
      const fullName = desiredEnum.schema ? `${desiredEnum.schema}.${desiredEnum.name}` : desiredEnum.name;
      for (const value of valuesToAdd) {
        statements.push(`ALTER TYPE ${fullName} ADD VALUE '${value}';`);
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
    const fullName = enumType.schema ? `${enumType.schema}.${enumType.name}` : enumType.name;
    return `CREATE TYPE ${fullName} AS ENUM (${values});`;
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

  private generateExtensionStatements(desiredExtensions: Extension[], currentExtensions: Extension[]): {
    create: string[];
    drop: string[];
  } {
    const createStatements: string[] = [];
    const dropStatements: string[] = [];
    const currentExtensionMap = new Map(currentExtensions.map(e => [e.name, e]));
    const desiredExtensionNames = new Set(desiredExtensions.map(e => e.name));

    // Determine which extensions to drop (executed LAST, after all dependent objects are removed)
    for (const currentExt of currentExtensions) {
      if (!desiredExtensionNames.has(currentExt.name)) {
        // Use CASCADE to drop all dependent objects (types, functions, etc.)
        dropStatements.push(`DROP EXTENSION IF EXISTS ${currentExt.name} CASCADE;`);
        Logger.info(`Dropping extension '${currentExt.name}' (CASCADE will drop dependent objects)`);
      }
    }

    // Create extensions (these will be executed FIRST, before all dependent objects)
    for (const desiredExt of desiredExtensions) {
      const currentExt = currentExtensionMap.get(desiredExt.name);

      if (!currentExt) {
        createStatements.push(this.generateCreateExtensionSQL(desiredExt));
        Logger.info(`Creating extension '${desiredExt.name}'`);
      } else {
        // Check if version differs
        if (desiredExt.version && currentExt.version !== desiredExt.version) {
          Logger.warning(`Extension '${desiredExt.name}' version differs (current: ${currentExt.version}, desired: ${desiredExt.version}). Manual update may be required.`);
        } else {
          Logger.info(`Extension '${desiredExt.name}' already exists, skipping`);
        }
      }
    }

    return { create: createStatements, drop: dropStatements };
  }

  private generateCreateExtensionSQL(extension: Extension): string {
    let sql = `CREATE EXTENSION IF NOT EXISTS ${extension.name}`;

    if (extension.schema) {
      sql += ` SCHEMA ${extension.schema}`;
    }

    if (extension.version) {
      sql += ` VERSION '${extension.version}'`;
    }

    if (extension.cascade) {
      sql += ` CASCADE`;
    }

    sql += ';';
    return sql;
  }

  private generateSequenceStatements(desiredSequences: Sequence[], currentSequences: Sequence[]): string[] {
    const statements: string[] = [];
    const currentSequenceMap = new Map(currentSequences.map(s => [s.name, s]));
    const desiredSequenceNames = new Set(desiredSequences.map(s => s.name));

    // Drop sequences that are no longer needed
    // Skip sequences owned by table columns (created by SERIAL) as they're managed automatically
    for (const currentSeq of currentSequences) {
      if (!desiredSequenceNames.has(currentSeq.name) && !currentSeq.ownedBy) {
        statements.push(generateDropSequenceSQL(currentSeq.name));
        Logger.info(`Dropping sequence '${currentSeq.name}'`);
      }
    }

    // Create or update sequences
    // Skip sequences owned by table columns (created by SERIAL) as they're managed automatically
    for (const desiredSeq of desiredSequences) {
      const currentSeq = currentSequenceMap.get(desiredSeq.name);

      if (!currentSeq) {
        statements.push(generateCreateSequenceSQL(desiredSeq));
        Logger.info(`Creating sequence '${desiredSeq.name}'`);
      } else if (!currentSeq.ownedBy) {
        // Only update sequences that are not owned by table columns
        if (this.sequenceNeedsUpdate(desiredSeq, currentSeq)) {
          statements.push(generateDropSequenceSQL(currentSeq.name));
          statements.push(generateCreateSequenceSQL(desiredSeq));
          Logger.info(`Updating sequence '${desiredSeq.name}'`);
        } else {
          Logger.info(`Sequence '${desiredSeq.name}' is up to date, skipping`);
        }
      } else {
        Logger.info(`Sequence '${desiredSeq.name}' is owned by a table column, skipping`);
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

  private generateSchemaStatements(desiredSchemas: SchemaDefinition[], currentSchemas: SchemaDefinition[]): string[] {
    const statements: string[] = [];
    const currentSchemaNames = new Set(currentSchemas.map(s => s.name));

    for (const desiredSchema of desiredSchemas) {
      if (!currentSchemaNames.has(desiredSchema.name)) {
        const ifNotExists = desiredSchema.ifNotExists ? 'IF NOT EXISTS ' : '';
        let sql = `CREATE SCHEMA ${ifNotExists}${desiredSchema.name}`;

        if (desiredSchema.owner) {
          sql += ` AUTHORIZATION ${desiredSchema.owner}`;
        }

        sql += ';';
        statements.push(sql);
        Logger.info(`Creating schema '${desiredSchema.name}'`);
      } else {
        Logger.info(`Schema '${desiredSchema.name}' already exists, skipping`);
      }
    }

    return statements;
  }

  private generateCommentStatements(desiredComments: Comment[], currentComments: Comment[]): string[] {
    const statements: string[] = [];
    const currentCommentMap = new Map(
      currentComments.map(c => [this.getCommentKey(c), c])
    );

    for (const desiredComment of desiredComments) {
      const key = this.getCommentKey(desiredComment);
      const currentComment = currentCommentMap.get(key);

      if (!currentComment || currentComment.comment !== desiredComment.comment) {
        const sql = this.generateCommentSQL(desiredComment);
        statements.push(sql);
        Logger.info(`${currentComment ? 'Updating' : 'Creating'} comment on ${desiredComment.objectType} '${desiredComment.objectName}'`);
      } else {
        Logger.info(`Comment on ${desiredComment.objectType} '${desiredComment.objectName}' is up to date, skipping`);
      }
    }

    return statements;
  }

  private getCommentKey(comment: Comment): string {
    if (comment.objectType === 'COLUMN') {
      return `${comment.objectType}:${comment.objectName}`;
    }
    return `${comment.objectType}:${comment.schemaName || 'public'}.${comment.objectName}`;
  }

  private generateCommentSQL(comment: Comment): string {
    const escapedComment = comment.comment.replace(/'/g, "''");

    if (comment.objectType === 'SCHEMA') {
      return `COMMENT ON SCHEMA ${comment.objectName} IS '${escapedComment}';`;
    }

    const objectName = comment.schemaName
      ? `${comment.schemaName}.${comment.objectName}`
      : comment.objectName;

    return `COMMENT ON ${comment.objectType} ${objectName} IS '${escapedComment}';`;
  }
}
