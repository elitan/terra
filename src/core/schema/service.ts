import { Client } from "pg";
import type { MigrationPlan } from "../../types/migration";
import { SchemaParser } from "./parser";
import { DatabaseInspector } from "./inspector";
import { SchemaDiffer } from "./differ";
import { MigrationExecutor } from "../migration/executor";
import { DatabaseService, type AdvisoryLockOptions } from "../database/client";
import { Logger } from "../../utils/logger";
import {
  CommentHandler,
  EnumHandler,
  ExtensionHandler,
  FunctionHandler,
  ProcedureHandler,
  SchemaHandler,
  SequenceHandler,
  TriggerHandler,
  ViewHandler,
} from "./handlers";

export class SchemaService {
  private parser: SchemaParser;
  private inspector: DatabaseInspector;
  private differ: SchemaDiffer;
  private executor: MigrationExecutor;
  private databaseService: DatabaseService;

  private schemaHandler: SchemaHandler;
  private commentHandler: CommentHandler;
  private extensionHandler: ExtensionHandler;
  private enumHandler: EnumHandler;
  private sequenceHandler: SequenceHandler;
  private functionHandler: FunctionHandler;
  private procedureHandler: ProcedureHandler;
  private viewHandler: ViewHandler;
  private triggerHandler: TriggerHandler;

  constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService;
    this.parser = new SchemaParser();
    this.inspector = new DatabaseInspector();
    this.differ = new SchemaDiffer();
    this.executor = new MigrationExecutor(databaseService);

    this.schemaHandler = new SchemaHandler();
    this.commentHandler = new CommentHandler();
    this.extensionHandler = new ExtensionHandler();
    this.enumHandler = new EnumHandler();
    this.sequenceHandler = new SequenceHandler();
    this.functionHandler = new FunctionHandler();
    this.procedureHandler = new ProcedureHandler();
    this.viewHandler = new ViewHandler();
    this.triggerHandler = new TriggerHandler();
  }

  async plan(schemaFile: string): Promise<MigrationPlan> {
    const client = await this.databaseService.createClient();

    try {
      const parsedSchema = await this.parseSchemaInput(schemaFile);
      const desiredSchema = Array.isArray(parsedSchema) ? parsedSchema : parsedSchema.tables;
      const currentSchema = await this.inspector.getCurrentSchema(client);
      const plan = this.differ.generateMigrationPlan(desiredSchema, currentSchema);

      if (!plan.hasChanges) {
        Logger.success("No changes needed - database is up to date");
      } else {
        const totalChanges = plan.transactional.length + plan.concurrent.length + plan.deferred.length;
        Logger.warning(`Found ${totalChanges} change(s) to apply:`);
        console.log();

        if (plan.transactional.length > 0) {
          Logger.info("Transactional changes:");
          plan.transactional.forEach((stmt, i) => {
            Logger.cyan(`  ${i + 1}. ${stmt}`);
          });
        }

        if (plan.deferred.length > 0) {
          Logger.info("Deferred changes (circular FK dependencies):");
          plan.deferred.forEach((stmt, i) => {
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
      if (lockOptions && !dryRun) {
        await this.databaseService.acquireAdvisoryLock(client, lockOptions);
      }
      const parsedSchema = await this.parseSchemaInput(schemaFile);
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

      const schemaStatements = this.schemaHandler.generateStatements(desiredSchemas, currentSchemas);
      const { create: extensionCreateStatements, drop: extensionDropStatements } =
        this.extensionHandler.generateStatements(desiredExtensions, currentExtensions);
      const { transactional: enumCreateStatements, concurrent: enumAddValueStatements } =
        this.enumHandler.generateStatements(desiredEnums, currentEnums);

      const plan = this.differ.generateMigrationPlan(desiredSchema, currentSchema);

      plan.transactional = [...schemaStatements, ...extensionCreateStatements, ...enumCreateStatements, ...plan.transactional];
      plan.concurrent = [...enumAddValueStatements, ...plan.concurrent];
      plan.hasChanges = plan.transactional.length > 0 || plan.concurrent.length > 0;

      const sequenceStatements = this.sequenceHandler.generateStatements(desiredSequences, currentSequences);
      const functionStatements = this.functionHandler.generateStatements(desiredFunctions, currentFunctions);
      const procedureStatements = this.procedureHandler.generateStatements(desiredProcedures, currentProcedures);
      const viewStatements = this.viewHandler.generateStatements(desiredViews, currentViews);
      const triggerStatements = this.triggerHandler.generateStatements(desiredTriggers, currentTriggers);
      const commentStatements = this.commentHandler.generateStatements(desiredComments, currentComments);

      const totalChanges = plan.transactional.length + plan.concurrent.length + plan.deferred.length +
                          sequenceStatements.length + functionStatements.length +
                          procedureStatements.length + viewStatements.length +
                          triggerStatements.length + commentStatements.length + extensionDropStatements.length;

      if (totalChanges === 0) {
        Logger.success("No changes needed - database is up to date");
        return;
      }

      const { OutputFormatter } = await import("../../utils/output-formatter");

      Logger.print(OutputFormatter.summary(`${totalChanges} changes`));

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

      if (plan.deferred.length > 0) {
        Logger.print(OutputFormatter.section("Deferred (circular FK dependencies)"));
        Logger.print(OutputFormatter.box(plan.deferred));
      }

      if (plan.concurrent.length > 0) {
        Logger.print(OutputFormatter.warningSection("Concurrent (non-transactional)"));
        Logger.print(OutputFormatter.box(plan.concurrent));
      }

      console.log();

      if (dryRun) {
        Logger.info("Dry run complete - no changes were made");
        return;
      }

      if (!autoApprove) {
        const confirmed = await this.promptForConfirmation();
        if (!confirmed) {
          Logger.info("Apply cancelled");
          return;
        }
      }

      await this.executeStatements(client, sequenceStatements, autoApprove);
      await this.executor.executePlan(client, plan, autoApprove);
      await this.executeEnumRemovals(client, desiredEnums, currentEnums, schemas);
      await this.executeStatements(client, functionStatements, autoApprove);
      await this.executeStatements(client, procedureStatements, autoApprove);
      await this.executeStatements(client, viewStatements, autoApprove);
      await this.executeStatements(client, triggerStatements, autoApprove);
      await this.executeStatements(client, commentStatements, autoApprove);
      await this.executeStatements(client, extensionDropStatements, autoApprove)
    } finally {
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

  private async parseSchemaInput(input: string) {
    if (input === "") {
      return await this.parser.parseSchema(input);
    }

    if (
      input.includes('CREATE') ||
      input.includes(';') ||
      input.includes('\n') ||
      input.length > 500
    ) {
      return await this.parser.parseSchema(input);
    } else {
      return await this.parser.parseSchemaFile(input);
    }
  }

  private async executeStatements(client: Client, statements: string[], autoApprove: boolean): Promise<void> {
    if (statements.length === 0) return;
    await this.executor.executePlan(client, {
      transactional: statements,
      concurrent: [],
      deferred: [],
      hasChanges: true
    }, autoApprove);
  }

  private async executeEnumRemovals(client: Client, desiredEnums: any[], currentEnums: any[], schemas: string[]): Promise<void> {
    const statements = await this.enumHandler.generateRemovalStatements(desiredEnums, currentEnums, client, schemas);
    for (const statement of statements) {
      try {
        await client.query(statement);
      } catch (error: any) {
        if (error.code === '2BP01') {
          const match = statement.match(/DROP TYPE\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i);
          const typeName = match ? (match[1] ? `${match[1]}.${match[2]}` : match[2]) : 'unknown';
          Logger.warning(`Could not drop ENUM '${typeName}': now in use (concurrent change). Will retry next migration.`);
        } else {
          throw error;
        }
      }
    }
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

    const checkSchema = (objType: string, objName: string, objSchema: string | undefined) => {
      const schema = objSchema || 'public';
      if (!managedSchemas.includes(schema)) {
        errors.push(`${objType} '${objSchema ? objSchema + '.' : ''}${objName}' references schema '${schema}' which is not in the managed schema list: [${managedSchemas.join(', ')}]`);
      }
    };

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
}
