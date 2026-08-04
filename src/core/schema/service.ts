import type { MigrationPlan } from "../../types/migration";
import { StrictModeError, ValidationError } from "../../types/errors";
import type {
  DatabaseProvider,
  DatabaseClient,
  ConnectionConfig,
  AdvisoryLockOptions,
  ParsedSchema,
} from "../../providers/types";
import type { Trigger, View } from "../../types/schema";
import { Logger } from "../../utils/logger";
import { isDestructiveStatement } from "../../utils/statement-classifier";
import { hasSQLiteTableRecreation } from "../../utils/sqlite-recreation";
import { collectSQLiteSchemaIdentifiers } from "../../utils/sqlite-identifier";
import {
  CommentHandler,
  CompositeTypeHandler,
  EnumHandler,
  ExtensionHandler,
  FunctionHandler,
  ProcedureHandler,
  SchemaHandler,
  SequenceHandler,
  SqlObjectHandler,
  TriggerHandler,
  ViewHandler,
} from "./handlers";
import {
  orderPostgresTypeStatements,
  type PostgresTypeStatement,
} from "./handlers/postgres-type-ordering";

export class SchemaService {
  private provider: DatabaseProvider;
  private config: ConnectionConfig;

  private schemaHandler: SchemaHandler;
  private commentHandler: CommentHandler;
  private extensionHandler: ExtensionHandler;
  private compositeTypeHandler: CompositeTypeHandler;
  private enumHandler: EnumHandler;
  private sequenceHandler: SequenceHandler;
  private functionHandler: FunctionHandler;
  private procedureHandler: ProcedureHandler;
  private viewHandler: ViewHandler;
  private triggerHandler: TriggerHandler;
  private sqlObjectHandler: SqlObjectHandler;

  constructor(provider: DatabaseProvider, config: ConnectionConfig) {
    this.provider = provider;
    this.config = config;

    this.schemaHandler = new SchemaHandler();
    this.commentHandler = new CommentHandler();
    this.extensionHandler = new ExtensionHandler();
    this.compositeTypeHandler = new CompositeTypeHandler();
    this.enumHandler = new EnumHandler();
    this.sequenceHandler = new SequenceHandler();
    this.functionHandler = new FunctionHandler();
    this.procedureHandler = new ProcedureHandler();
    this.viewHandler = new ViewHandler();
    this.triggerHandler = new TriggerHandler();
    this.sqlObjectHandler = new SqlObjectHandler();
  }

  async plan(
    schemaFile: string,
    schemas: string[] = ['public']
  ): Promise<MigrationPlan> {
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
        throw new ValidationError("Schema validation failed for target database");
      }

      let filtered = parsedSchema;
      if (this.provider.supportsFeature("schemas")) {
        filtered = this.filterUnmanagedSchemas(schemas, parsedSchema);
      }

      const result = await this.buildCombinedPlan(client, filtered, schemas);
      const plan = result.plan;

      if (!plan.hasChanges) {
        Logger.success("No changes needed - database is up to date");
      } else {
        const totalChanges = result.totalChanges;
        Logger.warning(`Found ${totalChanges} change(s) to apply:`);
        console.log();

        if (result.transactionalPreview.length > 0) {
          Logger.info("Transactional changes:");
          result.transactionalPreview.forEach((stmt, i) => {
            Logger.cyan(`  ${i + 1}. ${stmt}`);
          });
        }

        if (result.deferredPreview.length > 0) {
          Logger.info("Deferred changes (circular FK dependencies):");
          result.deferredPreview.forEach((stmt, i) => {
            Logger.cyan(`  ${i + 1}. ${stmt}`);
          });
        }

        if (result.concurrentPreview.length > 0) {
          Logger.info("Concurrent changes (non-transactional):");
          result.concurrentPreview.forEach((stmt, i) => {
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
    dryRun: boolean = false,
    strict: boolean = false
  ): Promise<MigrationPlan> {
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
        throw new ValidationError("Schema validation failed for target database");
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

      const result = await this.buildCombinedPlan(client, filtered, schemas);
      const combinedPlan = result.plan;
      const totalChanges = result.totalChanges;

      if (totalChanges === 0) {
        Logger.success("No changes needed - database is up to date");
        return {
          preTransactional: [],
          transactional: [],
          concurrent: [],
          deferred: [],
          hasChanges: false
        };
      }

      if (strict) {
        const destructiveStatements = this.getDestructiveStatements(combinedPlan);
        if (destructiveStatements.length > 0) {
          throw new StrictModeError(
            "Strict mode blocked destructive migration statements",
            destructiveStatements
          );
        }
      }

      const { OutputFormatter } = await import("../../utils/output-formatter");

      Logger.print(OutputFormatter.summary(`${totalChanges} changes`));

      if (result.preTransactionalPreview.length > 0) {
        Logger.print(
          OutputFormatter.warningSection(
            "Pre-transactional (committed before remaining changes)"
          )
        );
        Logger.print(OutputFormatter.box(result.preTransactionalPreview));
      }

      if (result.transactionalPreview.length > 0) {
        Logger.print(OutputFormatter.section("Transactional"));
        Logger.print(OutputFormatter.box(result.transactionalPreview));
      }

      if (result.deferredPreview.length > 0) {
        Logger.print(OutputFormatter.section("Deferred (circular FK dependencies)"));
        Logger.print(OutputFormatter.box(result.deferredPreview));
      }

      if (result.concurrentPreview.length > 0) {
        Logger.print(OutputFormatter.warningSection("Concurrent (non-transactional)"));
        Logger.print(OutputFormatter.box(result.concurrentPreview));
      }

      console.log();

      if (dryRun) {
        Logger.info("Dry run complete - no changes were made");
        return combinedPlan;
      }

      if (!autoApprove) {
        if (!this.canPromptForConfirmation()) {
          throw new ValidationError(
            "Confirmation prompt requires interactive terminal. Use --auto-approve to continue",
            "apply",
            "auto-approve",
            autoApprove
          );
        }
        const confirmed = await this.promptForConfirmation();
        if (!confirmed) {
          Logger.info("Apply cancelled");
          return combinedPlan;
        }
      }

      await this.executePlan(client, combinedPlan, autoApprove);
      return combinedPlan;
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
    const preTransactional = plan.preTransactional ?? [];
    if (preTransactional.length > 0) {
      await this.provider.executeInTransaction(client, preTransactional);
    }

    if (plan.transactional.length > 0) {
      await this.provider.executeInTransaction(client, plan.transactional);
    }

    if (plan.deferred.length > 0) {
      await this.provider.executeInTransaction(client, plan.deferred);
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

  private canPromptForConfirmation(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  private async parseSchemaInput(input: string): Promise<ParsedSchema> {
    const trimmed = input.trim();

    if (trimmed === "") {
      return await this.provider.parseSchema(trimmed);
    }

    const looksLikeSql =
      input.includes(";") ||
      input.includes("\n") ||
      input.length > 500 ||
      /^\s*(create|alter|drop|comment|grant|revoke|insert|update|delete|with|select)\s/i.test(
        input
      );

    const looksLikePath =
      input.includes("/") || input.includes("\\") || /\.sql$/i.test(input);

    const fs = await import("fs/promises");

    if (looksLikePath && !looksLikeSql) {
      const content = await fs.readFile(input, "utf-8");
      return await this.provider.parseSchema(content, input);
    }

    if (looksLikeSql) {
      return await this.provider.parseSchema(input);
    }

    try {
      const content = await fs.readFile(input, 'utf-8');
      return await this.provider.parseSchema(content, input);
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? ((error as { code: string }).code as string)
          : undefined;

      if (code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG") {
        return await this.provider.parseSchema(input);
      }

      throw error;
    }
  }

  private getDestructiveStatements(plan: MigrationPlan): string[] {
    const statements = [
      ...(plan.preTransactional ?? []),
      ...plan.transactional,
      ...plan.deferred,
      ...plan.concurrent,
    ];
    return statements.filter((statement) => isDestructiveStatement(statement));
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
      compositeTypes: (parsed.compositeTypes || []).filter(t => isManaged(t.schema)),
      views: parsed.views.filter(v => isManaged(v.schema)),
      functions: parsed.functions.filter(f => isManaged(f.schema)),
      procedures: parsed.procedures.filter(p => isManaged(p.schema)),
      triggers: parsed.triggers.filter(t => isManaged(t.schema)),
      sequences: parsed.sequences.filter(s => isManaged(s.schema)),
      extensions: parsed.extensions,
      schemas: parsed.schemas.filter(s => managedSchemas.includes(s.name)),
      comments: parsed.comments.filter(c => isManaged(c.schemaName)),
      sqlObjects: (parsed.sqlObjects || []).filter(function (object) {
        return object.schema === undefined || isManaged(object.schema);
      }),
    };
  }

  private countObjects(parsed: ParsedSchema): number {
    return parsed.tables.length + parsed.enums.length + (parsed.compositeTypes || []).length + parsed.views.length +
      parsed.functions.length + parsed.procedures.length + parsed.triggers.length +
      parsed.sequences.length + (parsed.sqlObjects || []).length;
  }

  private filterCurrentSqlObjects(
    currentObjects: NonNullable<ParsedSchema["sqlObjects"]>,
    desiredObjects: NonNullable<ParsedSchema["sqlObjects"]>
  ) {
    const desiredKeys = new Set(desiredObjects.map(function (item) {
      return item.key;
    }));

    return currentObjects.filter(function (item) {
      if (item.schema) {
        return true;
      }
      return desiredKeys.has(item.key);
    });
  }

  private async buildCombinedPlan(
    client: DatabaseClient,
    filtered: ParsedSchema,
    schemas: string[]
  ): Promise<{
    plan: MigrationPlan;
    totalChanges: number;
    preTransactionalPreview: string[];
    transactionalPreview: string[];
    deferredPreview: string[];
    concurrentPreview: string[];
  }> {
    const desiredSchema = filtered.tables;
    const desiredEnums = filtered.enums;
    const desiredCompositeTypes = filtered.compositeTypes || [];
    const desiredViews = filtered.views;
    const desiredFunctions = filtered.functions;
    const desiredProcedures = filtered.procedures;
    const desiredTriggers = filtered.triggers;
    const desiredSequences = filtered.sequences;
    const desiredExtensions = filtered.extensions;
    const desiredSchemas = filtered.schemas || [];
    const desiredComments = filtered.comments || [];
    const desiredSqlObjects = filtered.sqlObjects || [];

    const currentSchema = await this.provider.getCurrentSchema(client, schemas);
    const currentEnums = await this.provider.getCurrentEnums(client, schemas);
    const currentCompositeTypes = await this.provider.getCurrentCompositeTypes?.(client, schemas) || [];
    const currentViews = await this.provider.getCurrentViews(client, schemas);
    const currentFunctions = await this.provider.getCurrentFunctions(client, schemas);
    const currentProcedures = await this.provider.getCurrentProcedures(client, schemas);
    const currentTriggers = await this.provider.getCurrentTriggers(client, schemas);
    const currentSequences = await this.provider.getCurrentSequences(client, schemas);
    const currentExtensions = await this.provider.getCurrentExtensions(client, schemas);
    const currentSchemas = await this.provider.getCurrentSchemas(client, schemas);
    const currentComments = await this.provider.getCurrentComments(client, schemas);
    const currentSqlObjects = this.filterCurrentSqlObjects(
      await this.provider.getCurrentSqlObjects?.(client, schemas) || [],
      desiredSqlObjects
    );
    const sqliteIdentifiers = this.provider.dialect === "sqlite"
      ? collectSQLiteSchemaIdentifiers(
        [...desiredSchema, ...currentSchema],
        [...desiredViews, ...currentViews],
        [...desiredTriggers, ...currentTriggers]
      )
      : [];

    let schemaStatements: string[] = [];
    let extensionCreateStatements: string[] = [];
    let extensionDropStatements: string[] = [];
    let enumTypeCreateOperations: PostgresTypeStatement[] = [];
    let enumPreTransactionalStatements: string[] = [];
    let compositeTypeCreateOperations: PostgresTypeStatement[] = [];
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
      enumTypeCreateOperations = enumResult.typeStatements;
      enumPreTransactionalStatements = enumResult.preTransactional;
    }

    if (this.provider.supportsFeature("composite_types")) {
      const compositeTypeResult = this.compositeTypeHandler.generateStatements(
        desiredCompositeTypes,
        currentCompositeTypes
      );
      compositeTypeCreateOperations = compositeTypeResult.typeStatements;
    }

    const migrationContext = await this.provider.getMigrationContext?.(client);
    const tablePlan = this.provider.generateMigrationPlan(
      desiredSchema,
      currentSchema,
      migrationContext
    );
    const tableStatements = tablePlan.transactional;
    const deferredTableStatements = tablePlan.deferred;
    const concurrentStatements = tablePlan.concurrent;

    if (this.provider.supportsFeature("sequences")) {
      sequenceStatements = this.sequenceHandler.generateStatements(desiredSequences, currentSequences);
    }

    const preSequenceStatements = sequenceStatements.filter(
      statement => !/\bOWNED\s+BY\b/i.test(statement)
    );
    const postSequenceStatements = sequenceStatements.filter(
      statement => /\bOWNED\s+BY\b/i.test(statement)
    );
    const plannedTriggerRemovals = this.getRemovedTriggerDescriptions(
      desiredTriggers,
      currentTriggers
    );

    if (this.provider.supportsFeature("stored_functions")) {
      functionStatements = this.functionHandler.generateStatements(
        desiredFunctions,
        currentFunctions,
        plannedTriggerRemovals
      );
    }

    if (this.provider.supportsFeature("stored_procedures")) {
      procedureStatements = this.procedureHandler.generateStatements(
        desiredProcedures,
        currentProcedures,
        plannedTriggerRemovals
      );
    }

    const normalizedDesiredViews = await this.canonicalizeDesiredViews(
      client,
      desiredViews,
      currentViews
    );
    let viewStatements = this.viewHandler.generateStatements(
      normalizedDesiredViews,
      currentViews,
      migrationContext,
      sqliteIdentifiers
    );

    if (this.provider.supportsFeature("triggers")) {
      triggerStatements = this.triggerHandler.generateStatements(
        desiredTriggers,
        currentTriggers,
        sqliteIdentifiers
      );
    }

    let preTableTriggerStatements: string[] = [];
    let preTableViewStatements: string[] = [];
    if (this.provider.dialect === "sqlite") {
      const recreatesTable = hasSQLiteTableRecreation(tableStatements);
      const replacesOrDropsView = viewStatements.some(function (statement) {
        return /^DROP VIEW\s+/i.test(statement.trim());
      });

      if (recreatesTable) {
        preTableTriggerStatements = this.triggerHandler.generateStatements(
          [],
          currentTriggers,
          sqliteIdentifiers
        );
        preTableViewStatements = this.viewHandler.generateStatements(
          [],
          currentViews,
          migrationContext,
          sqliteIdentifiers
        );
        viewStatements = this.viewHandler.generateStatements(
          normalizedDesiredViews,
          [],
          migrationContext,
          sqliteIdentifiers
        );
        triggerStatements = this.triggerHandler.generateStatements(
          desiredTriggers,
          [],
          sqliteIdentifiers
        );
      } else if (replacesOrDropsView && this.provider.supportsFeature("triggers")) {
        preTableTriggerStatements = this.triggerHandler.generateStatements(
          [],
          currentTriggers,
          sqliteIdentifiers
        );
        triggerStatements = this.triggerHandler.generateStatements(
          desiredTriggers,
          [],
          sqliteIdentifiers
        );
      }
    } else if (this.provider.dialect === "postgres") {
      preTableTriggerStatements = triggerStatements.filter(function isDrop(
        statement
      ) {
        return /^DROP\s+TRIGGER\b/i.test(statement.trim());
      });
      triggerStatements = triggerStatements.filter(function isNotDrop(
        statement
      ) {
        return !/^DROP\s+TRIGGER\b/i.test(statement.trim());
      });
    }

    commentStatements = this.commentHandler.generateStatements(desiredComments, currentComments);

    let enumTypeRemovalOperations: PostgresTypeStatement[] = [];
    let compositeTypeRemovalOperations: PostgresTypeStatement[] = [];
    if (this.provider.supportsFeature("enums")) {
      enumTypeRemovalOperations = this.enumHandler.generateRemovalTypeStatements(
        desiredEnums,
        currentEnums,
        {
          desiredTables: desiredSchema,
          desiredCompositeTypes,
          desiredViews: normalizedDesiredViews,
          desiredSqlObjects,
          desiredFunctions,
          desiredProcedures,
          managedSchemas: schemas,
        }
      );
    }

    if (this.provider.supportsFeature("composite_types")) {
      compositeTypeRemovalOperations =
        this.compositeTypeHandler.generateRemovalTypeStatements(
          desiredCompositeTypes,
          currentCompositeTypes,
          desiredSchema,
          schemas,
          desiredSqlObjects,
          normalizedDesiredViews
        );
    }

    const sqlObjectPlan = await this.sqlObjectHandler.generateStatements(
      desiredSqlObjects,
      currentSqlObjects,
      {
        desiredTables: desiredSchema,
        desiredViews: normalizedDesiredViews,
        desiredCompositeTypes,
        desiredFunctions,
        currentFunctions,
        desiredProcedures,
        managedSchemas: schemas,
      }
    );

    const typeCreateStatements = orderPostgresTypeStatements(
      [
        ...enumTypeCreateOperations,
        ...compositeTypeCreateOperations,
        ...sqlObjectPlan.typeCreateOperations,
      ],
      desiredEnums,
      desiredCompositeTypes,
      desiredSqlObjects
    );
    const typeRemovalStatements = orderPostgresTypeStatements(
      [
        ...enumTypeRemovalOperations,
        ...compositeTypeRemovalOperations,
        ...sqlObjectPlan.typeDropOperations,
      ],
      currentEnums,
      currentCompositeTypes,
      currentSqlObjects,
      true
    );

    const transactionalPreview = [
      ...sqlObjectPlan.bootstrapCreate,
      ...schemaStatements,
      ...extensionCreateStatements,
      ...sqlObjectPlan.typeReplaceDrop,
      ...typeCreateStatements,
      ...sqlObjectPlan.typeAlter,
      ...preSequenceStatements,
      ...sqlObjectPlan.earlyDrop,
      ...sqlObjectPlan.preTableCreate,
      ...preTableTriggerStatements,
      ...preTableViewStatements,
      ...tableStatements,
      ...sqlObjectPlan.postTableCreate,
      ...postSequenceStatements,
      ...functionStatements,
      ...procedureStatements,
      ...viewStatements,
      ...triggerStatements,
      ...sqlObjectPlan.postRoutineCreate,
      ...commentStatements,
      ...sqlObjectPlan.finalCreate,
      ...typeRemovalStatements,
      ...sqlObjectPlan.lateDrop,
      ...extensionDropStatements,
    ];

    const totalChanges =
      enumPreTransactionalStatements.length +
      transactionalPreview.length +
      deferredTableStatements.length +
      concurrentStatements.length;

    if (totalChanges === 0) {
      return {
        plan: {
          preTransactional: [],
          transactional: [],
          concurrent: [],
          deferred: [],
          hasChanges: false,
        },
        totalChanges: 0,
        preTransactionalPreview: [],
        transactionalPreview: [],
        deferredPreview: [],
        concurrentPreview: [],
      };
    }

    return {
      plan: {
        preTransactional: enumPreTransactionalStatements,
        transactional: transactionalPreview,
        concurrent: concurrentStatements,
        deferred: deferredTableStatements,
        hasChanges: true,
      },
      totalChanges,
      preTransactionalPreview: enumPreTransactionalStatements,
      transactionalPreview,
      deferredPreview: deferredTableStatements,
      concurrentPreview: concurrentStatements,
    };
  }

  private async canonicalizeDesiredViews(
    client: DatabaseClient,
    desiredViews: View[],
    currentViews: View[]
  ): Promise<View[]> {
    if (this.provider.dialect !== "postgres") {
      return desiredViews;
    }

    const currentViewKeys = new Set(
      currentViews.map(this.getViewKey)
    );

    if (currentViewKeys.size === 0) {
      return desiredViews;
    }

    const normalizedViews: View[] = [];

    for (const view of desiredViews) {
      if (!currentViewKeys.has(this.getViewKey(view))) {
        normalizedViews.push(view);
        continue;
      }

      const canonical = await this.canonicalizeViewDefinition(client, view);
      normalizedViews.push(canonical ? { ...view, ...canonical } : view);
    }

    return normalizedViews;
  }

  private async canonicalizeViewDefinition(
    client: DatabaseClient,
    view: View
  ): Promise<{ definition: string; columnNames: string[] } | undefined> {
    const schemaName = view.schema || "public";
    const tempViewName = `terradb_view_compare_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    const columnList = view.columnNames && view.columnNames.length > 0
      ? ` (${view.columnNames.map(this.quoteIdentifier).join(", ")})`
      : "";

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${this.buildViewSearchPath(schemaName)}`);
      await client.query(
        `CREATE TEMP VIEW ${this.quoteIdentifier(tempViewName)}${columnList} AS ${view.definition}`
      );

      const result = await client.query<{
        definition: string;
        column_names: string[];
      }>(
        `
          SELECT
            pg_get_viewdef($1::regclass, false) AS definition,
            ARRAY(
              SELECT attribute.attname::text
              FROM pg_attribute attribute
              WHERE attribute.attrelid = $1::regclass
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
              ORDER BY attribute.attnum
            ) AS column_names
        `,
        [`pg_temp.${tempViewName}`]
      );

      const row = result.rows[0];
      if (!row?.definition) {
        return undefined;
      }
      return {
        definition: row.definition.trim(),
        columnNames: row.column_names,
      };
    } catch {
      return undefined;
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
    }
  }

  private buildViewSearchPath(schemaName: string): string {
    if (schemaName === "public") {
      return "pg_temp, public";
    }

    return `pg_temp, ${this.quoteIdentifier(schemaName)}, public`;
  }

  private getViewKey(view: View): string {
    return `${view.schema || "public"}.${view.name}`;
  }

  private getRemovedTriggerDescriptions(
    desiredTriggers: Trigger[],
    currentTriggers: Trigger[]
  ): Set<string> {
    const desiredKeys = new Set(desiredTriggers.map(function getKey(trigger) {
      return `${trigger.schema || "public"}.${trigger.tableName}.${trigger.name}`;
    }));
    const descriptions = new Set<string>();

    for (const trigger of currentTriggers) {
      const schema = trigger.schema || "public";
      const key = `${schema}.${trigger.tableName}.${trigger.name}`;
      if (desiredKeys.has(key)) {
        continue;
      }

      const triggerNames = this.getDescriptionIdentifiers(trigger.name);
      const tableNames = this.getDescriptionQualifiedNames(
        schema,
        trigger.tableName
      );
      for (const triggerName of triggerNames) {
        for (const tableName of tableNames) {
          descriptions.add(`trigger ${triggerName} on table ${tableName}`);
        }
      }
    }

    return descriptions;
  }

  private getDescriptionIdentifiers(value: string): string[] {
    return Array.from(new Set([value, this.quoteIdentifier(value)]));
  }

  private getDescriptionQualifiedNames(
    schema: string,
    name: string
  ): string[] {
    const schemaNames = this.getDescriptionIdentifiers(schema);
    const objectNames = this.getDescriptionIdentifiers(name);
    const values = new Set<string>();
    if (schema === "public") {
      for (const objectName of objectNames) {
        values.add(objectName);
      }
    }
    for (const schemaName of schemaNames) {
      for (const objectName of objectNames) {
        values.add(`${schemaName}.${objectName}`);
      }
    }
    return Array.from(values);
  }

  private quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }
}
