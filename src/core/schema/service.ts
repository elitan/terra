import type { MigrationPlan } from "../../types/migration";
import type {
  DatabaseProvider,
  DatabaseClient,
  ConnectionConfig,
  AdvisoryLockOptions,
  ParsedSchema,
} from "../../providers/types";
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
  private provider: DatabaseProvider;
  private config: ConnectionConfig;

  private schemaHandler: SchemaHandler;
  private commentHandler: CommentHandler;
  private extensionHandler: ExtensionHandler;
  private enumHandler: EnumHandler;
  private sequenceHandler: SequenceHandler;
  private functionHandler: FunctionHandler;
  private procedureHandler: ProcedureHandler;
  private viewHandler: ViewHandler;
  private triggerHandler: TriggerHandler;

  constructor(provider: DatabaseProvider, config: ConnectionConfig) {
    this.provider = provider;
    this.config = config;

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
    const client = await this.provider.createClient(this.config);

    try {
      const parsedSchema = await this.parseSchemaInput(schemaFile);
      const validation = this.provider.validateSchema(parsedSchema);
      if (!validation.valid) {
        for (const error of validation.errors) {
          Logger.error(`${error.code}: ${error.message}`);
          if (error.suggestion) {
            Logger.info(`  Suggestion: ${error.suggestion}`);
          }
        }
        throw new Error("Schema validation failed for target database");
      }

      const desiredSchema = parsedSchema.tables;
      const currentSchema = await this.provider.getCurrentSchema(client);
      const plan = this.provider.generateMigrationPlan(desiredSchema, currentSchema);

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
    const client = await this.provider.createClient(this.config);

    try {
      if (lockOptions && !dryRun && this.provider.acquireAdvisoryLock) {
        await this.provider.acquireAdvisoryLock(client, lockOptions);
      }

      const parsedSchema = await this.parseSchemaInput(schemaFile);
      const validation = this.provider.validateSchema(parsedSchema);
      if (!validation.valid) {
        for (const error of validation.errors) {
          Logger.error(`${error.code}: ${error.message}`);
          if (error.suggestion) {
            Logger.info(`  Suggestion: ${error.suggestion}`);
          }
        }
        throw new Error("Schema validation failed for target database");
      }

      let filtered = parsedSchema;
      if (this.provider.supportsFeature("schemas")) {
        const originalCount = this.countObjects(parsedSchema);
        filtered = this.filterUnmanagedSchemas(schemas, parsedSchema);
        const filteredCount = this.countObjects(filtered);
        const ignoredCount = originalCount - filteredCount;
        if (ignoredCount > 0) {
          Logger.warning(`Ignored ${ignoredCount} object(s) from unmanaged schemas`);
        }
      }

      const desiredSchema = filtered.tables;
      const desiredEnums = filtered.enums;
      const desiredViews = filtered.views;
      const desiredFunctions = filtered.functions;
      const desiredProcedures = filtered.procedures;
      const desiredTriggers = filtered.triggers;
      const desiredSequences = filtered.sequences;
      const desiredExtensions = filtered.extensions;
      const desiredSchemas = filtered.schemas || [];
      const desiredComments = filtered.comments || [];

      const currentSchema = await this.provider.getCurrentSchema(client, schemas);
      const currentEnums = await this.provider.getCurrentEnums(client, schemas);
      const currentViews = await this.provider.getCurrentViews(client, schemas);
      const currentFunctions = await this.provider.getCurrentFunctions(client, schemas);
      const currentProcedures = await this.provider.getCurrentProcedures(client, schemas);
      const currentTriggers = await this.provider.getCurrentTriggers(client, schemas);
      const currentSequences = await this.provider.getCurrentSequences(client, schemas);
      const currentExtensions = await this.provider.getCurrentExtensions(client, schemas);
      const currentSchemas = await this.provider.getCurrentSchemas(client, schemas);
      const currentComments = await this.provider.getCurrentComments(client, schemas);

      let schemaStatements: string[] = [];
      let extensionCreateStatements: string[] = [];
      let extensionDropStatements: string[] = [];
      let enumCreateStatements: string[] = [];
      let enumAddValueStatements: string[] = [];
      let sequenceStatements: string[] = [];
      let functionStatements: string[] = [];
      let procedureStatements: string[] = [];
      let triggerStatements: string[] = [];
      let commentStatements: string[] = [];

      if (this.provider.supportsFeature("schemas")) {
        schemaStatements = this.schemaHandler.generateStatements(desiredSchemas, currentSchemas);
      }

      if (this.provider.supportsFeature("extensions")) {
        const extResult = this.extensionHandler.generateStatements(desiredExtensions, currentExtensions);
        extensionCreateStatements = extResult.create;
        extensionDropStatements = extResult.drop;
      }

      if (this.provider.supportsFeature("enums")) {
        const enumResult = this.enumHandler.generateStatements(desiredEnums, currentEnums);
        enumCreateStatements = enumResult.transactional;
        enumAddValueStatements = enumResult.concurrent;
      }

      const plan = this.provider.generateMigrationPlan(desiredSchema, currentSchema);

      plan.transactional = [...schemaStatements, ...extensionCreateStatements, ...enumCreateStatements, ...plan.transactional];
      plan.concurrent = [...enumAddValueStatements, ...plan.concurrent];
      plan.hasChanges = plan.transactional.length > 0 || plan.concurrent.length > 0;

      if (this.provider.supportsFeature("sequences")) {
        sequenceStatements = this.sequenceHandler.generateStatements(desiredSequences, currentSequences);
      }

      if (this.provider.supportsFeature("stored_functions")) {
        functionStatements = this.functionHandler.generateStatements(desiredFunctions, currentFunctions);
      }

      if (this.provider.supportsFeature("stored_procedures")) {
        procedureStatements = this.procedureHandler.generateStatements(desiredProcedures, currentProcedures);
      }

      const viewStatements = this.viewHandler.generateStatements(desiredViews, currentViews);

      if (this.provider.supportsFeature("triggers")) {
        triggerStatements = this.triggerHandler.generateStatements(desiredTriggers, currentTriggers);
      }

      commentStatements = this.commentHandler.generateStatements(desiredComments, currentComments);

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

      let enumRemovalStatements: string[] = [];
      if (this.provider.supportsFeature("enums")) {
        enumRemovalStatements = this.enumHandler.generateRemovalStatements(
          desiredEnums, currentEnums
        );
      }

      const combinedPlan: MigrationPlan = {
        transactional: [
          ...sequenceStatements,
          ...plan.transactional,
          ...plan.deferred,
          ...enumRemovalStatements,
          ...functionStatements,
          ...procedureStatements,
          ...viewStatements,
          ...triggerStatements,
          ...commentStatements,
          ...extensionDropStatements
        ],
        concurrent: plan.concurrent,
        deferred: [],
        hasChanges: true
      };

      await this.executePlan(client, combinedPlan, autoApprove);
    } finally {
      if (lockOptions && !dryRun && this.provider.releaseAdvisoryLock) {
        await this.provider.releaseAdvisoryLock(client, lockOptions.lockName);
      }
      await client.end();
    }
  }

  private async executePlan(
    client: DatabaseClient,
    plan: MigrationPlan,
    autoApprove: boolean
  ): Promise<void> {
    if (plan.transactional.length > 0) {
      await this.provider.executeInTransaction(client, plan.transactional);
    }

    if (plan.concurrent.length > 0) {
      for (const statement of plan.concurrent) {
        try {
          await client.query(statement);
          Logger.success(`Executed: ${statement.substring(0, 60)}...`);
        } catch (error) {
          Logger.error(`Failed: ${statement}`);
          throw error;
        }
      }
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

  private async parseSchemaInput(input: string): Promise<ParsedSchema> {
    if (input === "") {
      return await this.provider.parseSchema(input);
    }

    if (
      input.includes('CREATE') ||
      input.includes(';') ||
      input.includes('\n') ||
      input.length > 500
    ) {
      return await this.provider.parseSchema(input);
    } else {
      const fs = await import('fs/promises');
      const content = await fs.readFile(input, 'utf-8');
      return await this.provider.parseSchema(content, input);
    }
  }

  private filterUnmanagedSchemas(
    managedSchemas: string[],
    parsed: ParsedSchema
  ): ParsedSchema {
    const isManaged = (schema: string | undefined) =>
      managedSchemas.includes(schema || 'public');

    return {
      tables: parsed.tables.filter(t => isManaged(t.schema)),
      enums: parsed.enums.filter(e => isManaged(e.schema)),
      views: parsed.views.filter(v => isManaged(v.schema)),
      functions: parsed.functions.filter(f => isManaged(f.schema)),
      procedures: parsed.procedures.filter(p => isManaged(p.schema)),
      triggers: parsed.triggers.filter(t => isManaged(t.schema)),
      sequences: parsed.sequences.filter(s => isManaged(s.schema)),
      extensions: parsed.extensions,
      schemas: parsed.schemas.filter(s => managedSchemas.includes(s.name)),
      comments: parsed.comments.filter(c => isManaged(c.schemaName)),
    };
  }

  private countObjects(parsed: ParsedSchema): number {
    return parsed.tables.length + parsed.enums.length + parsed.views.length +
      parsed.functions.length + parsed.procedures.length + parsed.triggers.length +
      parsed.sequences.length;
  }
}
