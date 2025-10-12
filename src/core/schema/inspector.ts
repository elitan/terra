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
} from "../../types/schema";

export class DatabaseInspector {
  async getCurrentSchema(client: Client): Promise<Table[]> {
    const tables: Table[] = [];

    // Get all tables
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);

    for (const row of tablesResult.rows) {
      const tableName = row.table_name;

      // Get columns for each table
      const columnsResult = await client.query(
        `
        SELECT 
          column_name,
          data_type,
          character_maximum_length,
          is_nullable,
          column_default
        FROM information_schema.columns 
        WHERE table_name = $1 AND table_schema = 'public'
        ORDER BY ordinal_position
      `,
        [tableName]
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

        return {
          name: col.column_name,
          type: type,
          nullable: col.is_nullable === "YES",
          default: col.column_default,
        };
      });

      // Get primary key constraint for this table
      const primaryKey = await this.getPrimaryKeyConstraint(client, tableName);

      // Get foreign key constraints for this table
      const foreignKeys = await this.getForeignKeyConstraints(client, tableName);

      // Get check constraints for this table
      const checkConstraints = await this.getCheckConstraints(client, tableName);

      // Get unique constraints for this table
      const uniqueConstraints = await this.getUniqueConstraints(client, tableName);

      // Get indexes for this table
      const indexes = await this.getTableIndexes(client, tableName);

      tables.push({
        name: tableName,
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
    tableName: string
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
        AND tc.table_schema = 'public'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
      `,
      [tableName]
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

  async getTableIndexes(client: Client, tableName: string): Promise<Index[]> {
    const result = await client.query(
      `
      SELECT 
        i.indexname as index_name,
        i.tablename as table_name,
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
        AND i.schemaname = 'public'
        AND NOT ix.indisprimary  -- Exclude primary key indexes
        AND NOT EXISTS (  -- Exclude unique constraint indexes
          SELECT 1 FROM pg_constraint con 
          WHERE con.conindid = ix.indexrelid 
          AND con.contype = 'u'
        )
      ORDER BY i.indexname
      `,
      [tableName]
    );

    return result.rows.map((row: any) => ({
      name: row.index_name,
      tableName: row.table_name,
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

  async getForeignKeyConstraints(client: Client, tableName: string): Promise<ForeignKeyConstraint[]> {
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
        AND tc.table_schema = 'public'
        AND tc.constraint_type = 'FOREIGN KEY'
      ORDER BY tc.constraint_name, kcu.ordinal_position
      `,
      [tableName]
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

  async getCheckConstraints(client: Client, tableName: string): Promise<CheckConstraint[]> {
    const result = await client.query(
      `
      SELECT 
        conname as constraint_name,
        pg_get_constraintdef(c.oid) as constraint_def
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE t.relname = $1 
        AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        AND c.contype = 'c'
      ORDER BY c.conname
      `,
      [tableName]
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

  async getUniqueConstraints(client: Client, tableName: string): Promise<UniqueConstraint[]> {
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
        AND tc.table_schema = 'public'
        AND tc.constraint_type = 'UNIQUE'
      ORDER BY tc.constraint_name, kcu.ordinal_position
      `,
      [tableName]
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

  async getCurrentEnums(client: Client): Promise<EnumType[]> {
    const enumsResult = await client.query(`
      SELECT 
        t.typname as enum_name,
        e.enumlabel as enum_value,
        e.enumsortorder
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      ORDER BY t.typname, e.enumsortorder
    `);

    const enumGroups = new Map<string, string[]>();
    
    for (const row of enumsResult.rows) {
      const enumName = row.enum_name;
      const enumValue = row.enum_value;
      
      if (!enumGroups.has(enumName)) {
        enumGroups.set(enumName, []);
      }
      enumGroups.get(enumName)!.push(enumValue);
    }

    const enums: EnumType[] = [];
    for (const [name, values] of enumGroups) {
      enums.push({ name, values });
    }

    return enums;
  }

  // Get all views from the database
  async getCurrentViews(client: Client): Promise<View[]> {
    const views: View[] = [];

    // Get regular views
    const viewsResult = await client.query(`
      SELECT 
        table_name as view_name,
        view_definition,
        check_option,
        is_updatable,
        is_insertable_into
      FROM information_schema.views 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    for (const row of viewsResult.rows) {
      const view: View = {
        name: row.view_name,
        definition: row.view_definition.trim(),
        materialized: false,
      };

      // Set check option if present
      if (row.check_option && row.check_option !== 'NONE') {
        view.checkOption = row.check_option as 'CASCADED' | 'LOCAL';
      }

      views.push(view);
    }

    // Get materialized views
    const matViewsResult = await client.query(`
      SELECT 
        matviewname as view_name,
        definition,
        ispopulated
      FROM pg_matviews 
      WHERE schemaname = 'public'
      ORDER BY matviewname
    `);

    for (const row of matViewsResult.rows) {
      const view: View = {
        name: row.view_name,
        definition: row.definition.trim(),
        materialized: true,
      };

      // Get indexes for materialized views
      const indexesResult = await client.query(`
        SELECT 
          indexname,
          indexdef
        FROM pg_indexes 
        WHERE schemaname = 'public' AND tablename = $1
      `, [row.view_name]);

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
  async getCompleteSchema(client: Client): Promise<Schema> {
    const [tables, views, enumTypes, functions, procedures, triggers, sequences] = await Promise.all([
      this.getCurrentSchema(client),
      this.getCurrentViews(client),
      this.getCurrentEnums(client),
      this.getCurrentFunctions(client),
      this.getCurrentProcedures(client),
      this.getCurrentTriggers(client),
      this.getCurrentSequences(client),
    ]);

    return {
      tables,
      views,
      enumTypes,
      functions,
      procedures,
      triggers,
      sequences,
    };
  }

  // Get all functions from the database
  async getCurrentFunctions(client: Client): Promise<Function[]> {
    const result = await client.query(`
      SELECT
        p.proname as function_name,
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
      WHERE n.nspname = 'public'
        AND p.prokind = 'f'
        AND d.objid IS NULL
      ORDER BY p.proname
    `);

    return result.rows.map((row: any) => ({
      name: row.function_name,
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
  async getCurrentProcedures(client: Client): Promise<Procedure[]> {
    const result = await client.query(`
      SELECT
        p.proname as procedure_name,
        pg_get_function_arguments(p.oid) as arguments,
        l.lanname as language,
        p.prosrc as source_code,
        p.prosecdef as security_definer
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      JOIN pg_language l ON p.prolang = l.oid
      LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
      WHERE n.nspname = 'public'
        AND p.prokind = 'p'
        AND d.objid IS NULL
      ORDER BY p.proname
    `);

    return result.rows.map((row: any) => ({
      name: row.procedure_name,
      parameters: this.parseFunctionArguments(row.arguments),
      language: row.language,
      body: row.source_code,
      securityDefiner: row.security_definer || undefined,
    }));
  }

  // Get all triggers from the database
  async getCurrentTriggers(client: Client): Promise<Trigger[]> {
    const result = await client.query(`
      SELECT
        t.tgname as trigger_name,
        c.relname as table_name,
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
      WHERE n.nspname = 'public'
        AND NOT t.tgisinternal
      ORDER BY c.relname, t.tgname
    `);

    return result.rows.map((row: any) => {
      const events: Trigger['events'] = [];
      if (row.on_insert) events.push('INSERT');
      if (row.on_update) events.push('UPDATE');
      if (row.on_delete) events.push('DELETE');
      if (row.on_truncate) events.push('TRUNCATE');

      return {
        name: row.trigger_name,
        tableName: row.table_name,
        timing: row.timing,
        events,
        forEach: row.for_each,
        functionName: row.function_name,
      };
    });
  }

  // Get all sequences from the database
  async getCurrentSequences(client: Client): Promise<Sequence[]> {
    const result = await client.query(`
      SELECT
        c.relname as sequence_name,
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
      LEFT JOIN pg_class c2 ON c2.oid = d.refobjid
      LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      LEFT JOIN pg_namespace n2 ON c2.relnamespace = n2.oid
      WHERE c.relkind = 'S'
        AND n.nspname = 'public'
      ORDER BY c.relname
    `);

    return result.rows.map((row: any) => {
      const dataType = row.data_type === 'bigint' ? 'BIGINT'
                     : row.data_type === 'smallint' ? 'SMALLINT'
                     : 'INTEGER';

      return {
        name: row.sequence_name,
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
