import { Client } from "pg";
import type {
  Table,
  Column,
  PrimaryKeyConstraint,
  ForeignKeyConstraint,
  CheckConstraint,
  UniqueConstraint,
  Index,
  EnumType,
  View,
  Schema,
  Function,
  Procedure,
  Trigger,
  Sequence,
  Extension,
  SchemaDefinition,
  Comment,
} from "../../types/schema";

export class DatabaseInspector {
  async getCurrentSchema(client: Client, schemas: string[] = ['public']): Promise<Table[]> {
    const tables: Table[] = [];

    // Get all tables from specified schemas
    const tablesResult = await client.query(`
      SELECT table_name, table_schema
      FROM information_schema.tables
      WHERE table_schema = ANY($1::text[]) AND table_type = 'BASE TABLE'
    `, [schemas]);

    for (const row of tablesResult.rows) {
      const tableName = row.table_name;
      const tableSchema = row.table_schema;

      // Get columns for each table
      const columnsResult = await client.query(
        `
        SELECT
          c.column_name,
          c.data_type,
          c.udt_name,
          c.character_maximum_length,
          c.is_nullable,
          c.column_default,
          format_type(a.atttypid, a.atttypmod) as pg_type
        FROM information_schema.columns c
        JOIN pg_attribute a ON a.attname = c.column_name
        JOIN pg_class cls ON cls.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = cls.relnamespace
        WHERE cls.relname = $1 AND n.nspname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `,
        [tableName, tableSchema]
      );

      const columns: Column[] = columnsResult.rows.map((col: any) => {
        let type = col.data_type;

        // Handle character varying with length
        if (
          col.data_type === "character varying" &&
          col.character_maximum_length
        ) {
          type = `character varying(${col.character_maximum_length})`;
        }
        // Handle USER-DEFINED types (including PostGIS types)
        else if (col.data_type === "USER-DEFINED") {
          // Use PostgreSQL's format_type which gives us the full type definition
          type = col.pg_type;
        }

        return {
          name: col.column_name,
          type: type,
          nullable: col.is_nullable === "YES",
          default: col.column_default,
        };
      });

      // Get primary key constraint for this table
      const primaryKey = await this.getPrimaryKeyConstraint(client, tableName, tableSchema);

      // Get foreign key constraints for this table
      const foreignKeys = await this.getForeignKeyConstraints(client, tableName, tableSchema);

      // Get check constraints for this table
      const checkConstraints = await this.getCheckConstraints(client, tableName, tableSchema);

      // Get unique constraints for this table
      const uniqueConstraints = await this.getUniqueConstraints(client, tableName, tableSchema);

      // Get indexes for this table
      const indexes = await this.getTableIndexes(client, tableName, tableSchema);

      tables.push({
        name: tableName,
        schema: tableSchema,
        columns,
        primaryKey,
        foreignKeys: foreignKeys.length > 0 ? foreignKeys : undefined,
        checkConstraints: checkConstraints.length > 0 ? checkConstraints : undefined,
        uniqueConstraints: uniqueConstraints.length > 0 ? uniqueConstraints : undefined,
        indexes,
      });
    }

    return tables;
  }

  private async getPrimaryKeyConstraint(
    client: Client,
    tableName: string,
    tableSchema: string
  ): Promise<PrimaryKeyConstraint | undefined> {
    const result = await client.query(
      `
      SELECT
        tc.constraint_name,
        kcu.column_name,
        kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = $1
        AND tc.table_schema = $2
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
      `,
      [tableName, tableSchema]
    );

    if (result.rows.length === 0) {
      return undefined;
    }

    // Extract constraint name and columns
    const constraintName = result.rows[0].constraint_name;
    const columns = result.rows.map((row: any) => row.column_name);

    return {
      name: constraintName,
      columns,
    };
  }

  async getTableIndexes(client: Client, tableName: string, tableSchema: string): Promise<Index[]> {
    const result = await client.query(
      `
      SELECT
        i.indexname as index_name,
        i.tablename as table_name,
        i.schemaname as table_schema,
        i.indexdef as index_definition,
        ix.indisunique as is_unique,
        am.amname as access_method,
        ix.indexprs IS NOT NULL as has_expressions,
        -- Extract tablespace information
        ts.spcname as tablespace_name,
        -- Extract storage parameters (reloptions)
        ic.reloptions as storage_options,
        CASE
          WHEN ix.indexprs IS NOT NULL THEN
            -- Extract expression from the full index definition
            -- Use a more specific regex to extract content between USING btree ( and )
            regexp_replace(
              regexp_replace(i.indexdef, ' WHERE .*$', ''),  -- Remove WHERE clause first
              '^.*USING btree \\((.+)\\)$', '\\1'  -- Extract content between USING btree ( and )
            )
          ELSE NULL
        END as expression_def,
        CASE
          WHEN ix.indexprs IS NULL THEN
            -- Regular column-based index
            ARRAY(
              SELECT a.attname
              FROM pg_attribute a
              WHERE a.attrelid = ix.indrelid
                AND a.attnum = ANY(ix.indkey)
              ORDER BY array_position(ix.indkey, a.attnum)
            )
          ELSE
            -- Expression index - no simple column names
            ARRAY[]::text[]
        END as column_names,
        CASE
          WHEN ix.indpred IS NOT NULL THEN
            regexp_replace(
              pg_get_expr(ix.indpred, ix.indrelid),
              '^\\((.*)\\)$', '\\1'  -- Remove outer parentheses
            )
          ELSE NULL
        END as where_clause
      FROM pg_indexes i
      JOIN pg_class c ON c.relname = i.tablename
      JOIN pg_index ix ON ix.indexrelid = (
        SELECT oid FROM pg_class WHERE relname = i.indexname
      )
      JOIN pg_am am ON am.oid = (
        SELECT pg_class.relam FROM pg_class WHERE relname = i.indexname
      )
      -- Join with pg_class again to get the index relation for storage options
      JOIN pg_class ic ON ic.oid = ix.indexrelid
      -- Left join with pg_tablespace to get tablespace name
      LEFT JOIN pg_tablespace ts ON ts.oid = ic.reltablespace
      WHERE i.tablename = $1
        AND i.schemaname = $2
        AND NOT ix.indisprimary  -- Exclude primary key indexes
        AND NOT EXISTS (  -- Exclude unique constraint indexes
          SELECT 1 FROM pg_constraint con
          WHERE con.conindid = ix.indexrelid
          AND con.contype = 'u'
        )
      ORDER BY i.indexname
      `,
      [tableName, tableSchema]
    );

    return result.rows.map((row: any) => ({
      name: row.index_name,
      tableName: row.table_name,
      schema: row.table_schema,
      columns: row.column_names || [],
      type: this.mapPostgreSQLIndexType(row.access_method),
      unique: row.is_unique,
      concurrent: false, // Cannot detect from system catalogs
      where: row.where_clause || undefined,
      expression: row.has_expressions ? row.expression_def : undefined,
      storageParameters: this.parseStorageOptions(row.storage_options),
      tablespace: row.tablespace_name || undefined,
    }));
  }

  private parseStorageOptions(
    reloptions: string[] | null
  ): Record<string, string> | undefined {
    if (!reloptions || !Array.isArray(reloptions) || reloptions.length === 0) {
      return undefined;
    }

    const parameters: Record<string, string> = {};

    for (const option of reloptions) {
      // PostgreSQL storage options are stored as "key=value" strings
      const match = option.match(/^([^=]+)=(.*)$/);
      if (match && match.length >= 3 && match[1] && match[2] !== undefined) {
        const key = match[1];
        const value = match[2];
        parameters[key] = value;
      }
    }

    return Object.keys(parameters).length > 0 ? parameters : undefined;
  }

  private mapPostgreSQLIndexType(accessMethod: string): Index["type"] {
    switch (accessMethod.toLowerCase()) {
      case "btree":
        return "btree";
      case "hash":
        return "hash";
      case "gin":
        return "gin";
      case "gist":
        return "gist";
      case "spgist":
        return "spgist";
      case "brin":
        return "brin";
      default:
        return "btree"; // Default fallback
    }
  }

  async getForeignKeyConstraints(client: Client, tableName: string, tableSchema: string): Promise<ForeignKeyConstraint[]> {
    const result = await client.query(
      `
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS referenced_table,
        ccu.column_name AS referenced_column,
        rc.delete_rule,
        rc.update_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
      WHERE tc.table_name = $1
        AND tc.table_schema = $2
        AND tc.constraint_type = 'FOREIGN KEY'
      ORDER BY tc.constraint_name, kcu.ordinal_position
      `,
      [tableName, tableSchema]
    );

    if (result.rows.length === 0) {
      return [];
    }

    // Group foreign key constraints by constraint name
    const constraintGroups = new Map<string, any[]>();
    
    for (const row of result.rows) {
      const constraintName = row.constraint_name;
      if (!constraintGroups.has(constraintName)) {
        constraintGroups.set(constraintName, []);
      }
      constraintGroups.get(constraintName)!.push(row);
    }

    const foreignKeys: ForeignKeyConstraint[] = [];

    for (const [constraintName, rows] of constraintGroups) {
      const firstRow = rows[0];
      
      // Extract columns and referenced columns (maintaining order)
      const columns = rows.map(row => row.column_name);
      const referencedColumns = rows.map(row => row.referenced_column);
      
      // Map PostgreSQL action rules to our types
      const onDelete = this.mapReferentialAction(firstRow.delete_rule);
      const onUpdate = this.mapReferentialAction(firstRow.update_rule);

      foreignKeys.push({
        name: constraintName,
        columns,
        referencedTable: firstRow.referenced_table,
        referencedColumns,
        onDelete,
        onUpdate,
      });
    }

    return foreignKeys;
  }

  private mapReferentialAction(rule: string | null): 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | undefined {
    if (!rule) return undefined;
    
    switch (rule.toUpperCase()) {
      case 'CASCADE':
        return 'CASCADE';
      case 'RESTRICT':
        return 'RESTRICT';
      case 'SET NULL':
        return 'SET NULL';
      case 'SET DEFAULT':
        return 'SET DEFAULT';
      default:
        return undefined;
    }
  }

  async getCheckConstraints(client: Client, tableName: string, tableSchema: string): Promise<CheckConstraint[]> {
    const result = await client.query(
      `
      SELECT
        conname as constraint_name,
        pg_get_constraintdef(c.oid) as constraint_def
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE t.relname = $1
        AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)
        AND c.contype = 'c'
      ORDER BY c.conname
      `,
      [tableName, tableSchema]
    );

    if (result.rows.length === 0) {
      return [];
    }

    const checkConstraints: CheckConstraint[] = [];

    for (const row of result.rows) {
      const constraintName = row.constraint_name;
      const constraintDef = row.constraint_def;
      
      // Extract the expression from the constraint definition
      // PostgreSQL returns format like "CHECK (expression)"
      const match = constraintDef.match(/^CHECK \((.+)\)$/);
      if (match) {
        const expression = match[1];
        
        checkConstraints.push({
          name: constraintName,
          expression,
        });
      }
    }

    return checkConstraints;
  }

  async getUniqueConstraints(client: Client, tableName: string, tableSchema: string): Promise<UniqueConstraint[]> {
    const result = await client.query(
      `
      SELECT
        tc.constraint_name,
        kcu.column_name,
        kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = $1
        AND tc.table_schema = $2
        AND tc.constraint_type = 'UNIQUE'
      ORDER BY tc.constraint_name, kcu.ordinal_position
      `,
      [tableName, tableSchema]
    );

    if (result.rows.length === 0) {
      return [];
    }

    // Group unique constraints by constraint name
    const constraintGroups = new Map<string, any[]>();
    
    for (const row of result.rows) {
      const constraintName = row.constraint_name;
      if (!constraintGroups.has(constraintName)) {
        constraintGroups.set(constraintName, []);
      }
      constraintGroups.get(constraintName)!.push(row);
    }

    const uniqueConstraints: UniqueConstraint[] = [];

    for (const [constraintName, rows] of constraintGroups) {
      // Extract columns (maintaining order)
      const columns = rows.map(row => row.column_name);

      uniqueConstraints.push({
        name: constraintName,
        columns,
      });
    }

    return uniqueConstraints;
  }

  async getCurrentEnums(client: Client, schemas: string[] = ['public']): Promise<EnumType[]> {
    const enumsResult = await client.query(`
      SELECT
        t.typname as enum_name,
        n.nspname as schema_name,
        e.enumlabel as enum_value,
        e.enumsortorder
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON t.typnamespace = n.oid
      LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND d.objid IS NULL  -- Exclude extension-owned types
      ORDER BY t.typname, e.enumsortorder
    `, [schemas]);

    const enumGroups = new Map<string, { schema: string; values: string[] }>();

    for (const row of enumsResult.rows) {
      const enumName = row.enum_name;
      const schemaName = row.schema_name;
      const enumValue = row.enum_value;

      if (!enumGroups.has(enumName)) {
        enumGroups.set(enumName, { schema: schemaName, values: [] });
      }
      enumGroups.get(enumName)!.values.push(enumValue);
    }

    const enums: EnumType[] = [];
    for (const [name, data] of enumGroups) {
      enums.push({ name, schema: data.schema, values: data.values });
    }

    return enums;
  }

  // Get all views from the database
  async getCurrentViews(client: Client, schemas: string[] = ['public']): Promise<View[]> {
    const views: View[] = [];

    // Get regular views (excluding extension-owned views)
    const viewsResult = await client.query(`
      SELECT
        v.table_name as view_name,
        v.table_schema as schema_name,
        v.view_definition,
        v.check_option,
        v.is_updatable,
        v.is_insertable_into
      FROM information_schema.views v
      JOIN pg_class c ON c.relname = v.table_name
      JOIN pg_namespace n ON c.relnamespace = n.oid AND n.nspname = v.table_schema
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
      WHERE v.table_schema = ANY($1::text[])
        AND d.objid IS NULL  -- Exclude extension-owned views
      ORDER BY v.table_name
    `, [schemas]);

    for (const row of viewsResult.rows) {
      const view: View = {
        name: row.view_name,
        schema: row.schema_name,
        definition: row.view_definition.trim(),
        materialized: false,
      };

      // Set check option if present
      if (row.check_option && row.check_option !== 'NONE') {
        view.checkOption = row.check_option as 'CASCADED' | 'LOCAL';
      }

      views.push(view);
    }

    // Get materialized views (excluding extension-owned)
    const matViewsResult = await client.query(`
      SELECT
        m.matviewname as view_name,
        m.schemaname as schema_name,
        m.definition,
        m.ispopulated
      FROM pg_matviews m
      JOIN pg_class c ON c.relname = m.matviewname
      JOIN pg_namespace n ON c.relnamespace = n.oid AND n.nspname = m.schemaname
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
      WHERE m.schemaname = ANY($1::text[])
        AND d.objid IS NULL  -- Exclude extension-owned materialized views
      ORDER BY m.matviewname
    `, [schemas]);

    for (const row of matViewsResult.rows) {
      const view: View = {
        name: row.view_name,
        schema: row.schema_name,
        definition: row.definition.trim(),
        materialized: true,
      };

      // Get indexes for materialized views
      const indexesResult = await client.query(`
        SELECT
          indexname,
          indexdef
        FROM pg_indexes
        WHERE schemaname = $1 AND tablename = $2
      `, [row.schema_name, row.view_name]);

      if (indexesResult.rows.length > 0) {
        view.indexes = indexesResult.rows.map(idx => ({
          name: idx.indexname,
          tableName: row.view_name,
          columns: [], // We'll parse this from indexdef if needed
          type: 'btree' as const, // Default type
        }));
      }

      views.push(view);
    }

    return views;
  }

  // Get complete schema including all database objects
  async getCompleteSchema(client: Client, schemas: string[] = ['public']): Promise<Schema> {
    const [tables, views, enumTypes, functions, procedures, triggers, sequences, extensions, schemaDefinitions, comments] = await Promise.all([
      this.getCurrentSchema(client, schemas),
      this.getCurrentViews(client, schemas),
      this.getCurrentEnums(client, schemas),
      this.getCurrentFunctions(client, schemas),
      this.getCurrentProcedures(client, schemas),
      this.getCurrentTriggers(client, schemas),
      this.getCurrentSequences(client, schemas),
      this.getCurrentExtensions(client, schemas),
      this.getCurrentSchemas(client, schemas),
      this.getCurrentComments(client, schemas),
    ]);

    return {
      tables,
      views,
      enumTypes,
      functions,
      procedures,
      triggers,
      sequences,
      extensions,
      schemas: schemaDefinitions,
      comments,
    };
  }

  // Get all functions from the database
  async getCurrentFunctions(client: Client, schemas: string[] = ['public']): Promise<Function[]> {
    const result = await client.query(`
      SELECT
        p.proname as function_name,
        n.nspname as schema_name,
        pg_get_function_arguments(p.oid) as arguments,
        pg_get_function_result(p.oid) as return_type,
        l.lanname as language,
        p.prosrc as source_code,
        CASE p.provolatile
          WHEN 'i' THEN 'IMMUTABLE'
          WHEN 's' THEN 'STABLE'
          WHEN 'v' THEN 'VOLATILE'
        END as volatility,
        CASE p.proparallel
          WHEN 's' THEN 'SAFE'
          WHEN 'u' THEN 'UNSAFE'
          WHEN 'r' THEN 'RESTRICTED'
        END as parallel,
        p.prosecdef as security_definer,
        p.proisstrict as is_strict,
        p.procost as cost,
        p.prorows as rows
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      JOIN pg_language l ON p.prolang = l.oid
      LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND p.prokind = 'f'
        AND d.objid IS NULL
      ORDER BY p.proname
    `, [schemas]);

    return result.rows.map((row: any) => ({
      name: row.function_name,
      schema: row.schema_name,
      parameters: this.parseFunctionArguments(row.arguments),
      returnType: row.return_type,
      language: row.language,
      body: row.source_code,
      volatility: row.volatility,
      parallel: row.parallel,
      securityDefiner: row.security_definer || undefined,
      strict: row.is_strict || undefined,
      cost: row.cost !== 100 ? row.cost : undefined,
      rows: row.rows !== 1000 ? row.rows : undefined,
    }));
  }

  // Get all procedures from the database
  async getCurrentProcedures(client: Client, schemas: string[] = ['public']): Promise<Procedure[]> {
    const result = await client.query(`
      SELECT
        p.proname as procedure_name,
        n.nspname as schema_name,
        pg_get_function_arguments(p.oid) as arguments,
        l.lanname as language,
        p.prosrc as source_code,
        p.prosecdef as security_definer
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      JOIN pg_language l ON p.prolang = l.oid
      LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND p.prokind = 'p'
        AND d.objid IS NULL
      ORDER BY p.proname
    `, [schemas]);

    return result.rows.map((row: any) => ({
      name: row.procedure_name,
      schema: row.schema_name,
      parameters: this.parseFunctionArguments(row.arguments),
      language: row.language,
      body: row.source_code,
      securityDefiner: row.security_definer || undefined,
    }));
  }

  // Get all triggers from the database
  async getCurrentTriggers(client: Client, schemas: string[] = ['public']): Promise<Trigger[]> {
    const result = await client.query(`
      SELECT
        t.tgname as trigger_name,
        c.relname as table_name,
        n.nspname as schema_name,
        CASE
          WHEN t.tgtype & 1 = 1 THEN 'ROW'
          ELSE 'STATEMENT'
        END as for_each,
        CASE
          WHEN t.tgtype & 2 = 2 THEN 'BEFORE'
          WHEN t.tgtype & 64 = 64 THEN 'INSTEAD OF'
          ELSE 'AFTER'
        END as timing,
        CASE WHEN t.tgtype & 4 = 4 THEN true ELSE false END as on_insert,
        CASE WHEN t.tgtype & 8 = 8 THEN true ELSE false END as on_delete,
        CASE WHEN t.tgtype & 16 = 16 THEN true ELSE false END as on_update,
        CASE WHEN t.tgtype & 32 = 32 THEN true ELSE false END as on_truncate,
        p.proname as function_name,
        pg_get_triggerdef(t.oid) as trigger_def
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_proc p ON t.tgfoid = p.oid
      WHERE n.nspname = ANY($1::text[])
        AND NOT t.tgisinternal
      ORDER BY c.relname, t.tgname
    `, [schemas]);

    return result.rows.map((row: any) => {
      const events: Trigger['events'] = [];
      if (row.on_insert) events.push('INSERT');
      if (row.on_update) events.push('UPDATE');
      if (row.on_delete) events.push('DELETE');
      if (row.on_truncate) events.push('TRUNCATE');

      return {
        name: row.trigger_name,
        tableName: row.table_name,
        schema: row.schema_name,
        timing: row.timing,
        events,
        forEach: row.for_each,
        functionName: row.function_name,
      };
    });
  }

  // Get all sequences from the database
  async getCurrentSequences(client: Client, schemas: string[] = ['public']): Promise<Sequence[]> {
    const result = await client.query(`
      SELECT
        c.relname as sequence_name,
        n.nspname as schema_name,
        s.seqtypid::regtype::text as data_type,
        s.seqincrement as increment,
        s.seqmin as min_value,
        s.seqmax as max_value,
        s.seqstart as start,
        s.seqcache as cache,
        s.seqcycle as cycle,
        CASE
          WHEN d.deptype = 'a' THEN
            quote_ident(n2.nspname) || '.' || quote_ident(c2.relname) || '.' || quote_ident(a.attname)
          ELSE NULL
        END as owned_by_table_column
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      LEFT JOIN pg_sequence s ON s.seqrelid = c.oid
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
      LEFT JOIN pg_depend de ON de.objid = c.oid AND de.deptype = 'e'
      LEFT JOIN pg_class c2 ON c2.oid = d.refobjid
      LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      LEFT JOIN pg_namespace n2 ON c2.relnamespace = n2.oid
      WHERE c.relkind = 'S'
        AND n.nspname = ANY($1::text[])
        AND de.objid IS NULL  -- Exclude extension-owned sequences
      ORDER BY c.relname
    `, [schemas]);

    return result.rows.map((row: any) => {
      const dataType = row.data_type === 'bigint' ? 'BIGINT'
                     : row.data_type === 'smallint' ? 'SMALLINT'
                     : 'INTEGER';

      return {
        name: row.sequence_name,
        schema: row.schema_name,
        dataType: dataType !== 'BIGINT' ? dataType : undefined,
        increment: row.increment !== 1 ? row.increment : undefined,
        minValue: row.min_value,
        maxValue: row.max_value,
        start: row.start !== 1 ? row.start : undefined,
        cache: row.cache !== 1 ? row.cache : undefined,
        cycle: row.cycle || undefined,
        ownedBy: row.owned_by_table_column || undefined,
      };
    });
  }

  // Helper method to parse function arguments string from PostgreSQL
  private parseFunctionArguments(argsString: string): any[] {
    if (!argsString || argsString.trim() === '') {
      return [];
    }

    // This is a simplified parser - PostgreSQL's format is complex
    // Example: "a integer, b text DEFAULT 'hello'::text"
    const params: any[] = [];
    const argParts = argsString.split(',').map(s => s.trim());

    for (const arg of argParts) {
      const match = arg.match(/^(?:(IN|OUT|INOUT|VARIADIC)\s+)?(?:(\w+)\s+)?(.+?)(?:\s+DEFAULT\s+(.+))?$/i);
      if (match) {
        const [, mode, name, type, defaultVal] = match;
        if (type) {
          params.push({
            name: name || undefined,
            type: type.trim(),
            mode: mode?.toUpperCase() || undefined,
            default: defaultVal || undefined,
          });
        }
      }
    }

    return params;
  }

  // Get all extensions from the database
  // Only returns extensions that were explicitly installed by users, not system extensions
  async getCurrentExtensions(client: Client, schemas: string[] = ['public']): Promise<Extension[]> {
    const result = await client.query(`
      SELECT
        e.extname as extension_name,
        n.nspname as schema_name,
        e.extversion as version
      FROM pg_extension e
      JOIN pg_namespace n ON e.extnamespace = n.oid
      WHERE n.nspname = ANY($1::text[])
        AND e.extname != 'plpgsql'  -- Exclude built-in extensions
      ORDER BY e.extname
    `, [schemas]);

    return result.rows.map((row: any) => ({
      name: row.extension_name,
      schema: row.schema_name,
      version: row.version || undefined,
    }));
  }

  // Get all user-created schemas from the database
  async getCurrentSchemas(client: Client, schemas: string[] = ['public']): Promise<SchemaDefinition[]> {
    const result = await client.query(`
      SELECT
        n.nspname as schema_name,
        pg_get_userbyid(n.nspowner) as owner
      FROM pg_namespace n
      WHERE n.nspname = ANY($1::text[])
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_%'
      ORDER BY n.nspname
    `, [schemas]);

    return result.rows.map((row: any) => ({
      name: row.schema_name,
      owner: row.owner || undefined,
      ifNotExists: false,
    }));
  }

  // Get all comments from the database
  async getCurrentComments(client: Client, schemas: string[] = ['public']): Promise<Comment[]> {
    const comments: Comment[] = [];

    const result = await client.query(`
      SELECT
        CASE c.relkind
          WHEN 'r' THEN 'TABLE'
          WHEN 'v' THEN 'VIEW'
          WHEN 'm' THEN 'VIEW'
          WHEN 'i' THEN 'INDEX'
        END as object_type,
        c.relname as object_name,
        n.nspname as schema_name,
        d.description as comment
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r', 'v', 'm', 'i')

      UNION ALL

      SELECT
        'SCHEMA' as object_type,
        n.nspname as object_name,
        NULL as schema_name,
        d.description as comment
      FROM pg_namespace n
      JOIN pg_description d ON d.objoid = n.oid
      WHERE n.nspname = ANY($1::text[])

      ORDER BY object_type, object_name
    `, [schemas]);

    return result.rows.map((row: any) => ({
      objectType: row.object_type as Comment['objectType'],
      objectName: row.object_name,
      schemaName: row.schema_name || undefined,
      comment: row.comment,
    }));
  }

  // Helper method to analyze view dependencies
  async getViewDependencies(client: Client, viewName: string): Promise<string[]> {
    try {
      const result = await client.query(`
        SELECT DISTINCT
          CASE
            WHEN referenced_table_schema = 'public' THEN referenced_table_name
            ELSE referenced_table_schema || '.' || referenced_table_name
          END as dependency
        FROM information_schema.view_table_usage
        WHERE view_schema = 'public' AND view_name = $1
        ORDER BY dependency
      `, [viewName]);

      return result.rows.map(row => row.dependency);
    } catch (error) {
      // If the query fails (e.g., permissions), return empty array
      return [];
    }
  }
}
