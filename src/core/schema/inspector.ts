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
  CompositeType,
  View,
  Schema,
  Function,
  Procedure,
  Trigger,
  Sequence,
  Extension,
  SchemaDefinition,
  Comment,
  SqlObject,
} from "../../types/schema";
import { renderIdentityClause } from "../../utils/identity";
import { renderCollationName } from "../../utils/collation";
import {
  columnCompressionFromCatalog,
  columnStorageFromCatalog,
} from "../../utils/column-physical";

const IDENTITY_SEQUENCE_JOIN_SQL = `
  LEFT JOIN LATERAL (
    SELECT
      sequence_namespace.nspname as sequence_schema,
      sequence_class.relname as sequence_name,
      sequence_catalog.seqstart,
      sequence_catalog.seqincrement,
      sequence_catalog.seqmin,
      sequence_catalog.seqmax,
      sequence_catalog.seqcache,
      sequence_catalog.seqcycle
    FROM pg_depend dependency
    JOIN pg_class sequence_class
      ON sequence_class.oid = dependency.objid
      AND sequence_class.relkind = 'S'
    JOIN pg_namespace sequence_namespace
      ON sequence_namespace.oid = sequence_class.relnamespace
    JOIN pg_sequence sequence_catalog
      ON sequence_catalog.seqrelid = sequence_class.oid
    WHERE dependency.refobjid = a.attrelid
      AND dependency.refobjsubid = a.attnum
      AND dependency.classid = 'pg_class'::regclass
      AND dependency.refclassid = 'pg_class'::regclass
      AND dependency.deptype = 'i'
    LIMIT 1
  ) identity_sequence ON a.attidentity != ''
`;

const COLUMN_COLLATION_JOIN_SQL = `
  JOIN pg_type column_type ON column_type.oid = a.atttypid
  LEFT JOIN pg_collation column_collation
    ON column_collation.oid = a.attcollation
    AND a.attcollation <> column_type.typcollation
  LEFT JOIN pg_namespace column_collation_namespace
    ON column_collation_namespace.oid = column_collation.collnamespace
`;

export class DatabaseInspector {
  async getCurrentSchema(client: Client, schemas: string[] = ['public']): Promise<Table[]> {
    const tables: Table[] = [];

    // Get all tables from specified schemas (excluding extension-owned tables)
    const tablesResult = await client.query(`
      SELECT
        t.table_name,
        t.table_schema,
        c.relpersistence,
        c.reloptions as table_storage_options,
        toast_relation.reloptions as toast_storage_options,
        table_access_method.amname as table_access_method,
        table_tablespace.spcname as table_tablespace_name,
        inheritance.parents as inheritance_parents
      FROM information_schema.tables t
      JOIN pg_class c ON c.relname = t.table_name
      JOIN pg_namespace n ON c.relnamespace = n.oid AND n.nspname = t.table_schema
      LEFT JOIN pg_class toast_relation ON toast_relation.oid = c.reltoastrelid
      JOIN pg_am table_access_method ON table_access_method.oid = c.relam
      LEFT JOIN pg_tablespace table_tablespace ON table_tablespace.oid = c.reltablespace
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'name', parent.relname,
            'schema', parent_namespace.nspname
          )
          ORDER BY inherited.inhseqno
        ) as parents
        FROM pg_inherits inherited
        JOIN pg_class parent ON parent.oid = inherited.inhparent
        JOIN pg_namespace parent_namespace
          ON parent_namespace.oid = parent.relnamespace
        WHERE inherited.inhrelid = c.oid
      ) inheritance ON true
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
      WHERE t.table_schema = ANY($1::text[])
        AND t.table_type = 'BASE TABLE'
        AND c.relkind = 'r'
        AND NOT c.relispartition
        AND d.objid IS NULL
    `, [schemas]);

    for (const row of tablesResult.rows) {
      const tableName = row.table_name;
      const tableSchema = row.table_schema;
      const inherits = this.parseInheritanceParents(row.inheritance_parents);

      // Get columns for each table
      const columnsResult = await client.query(
        `
        SELECT
          a.attname as column_name,
          format_type(a.atttypid, a.atttypmod) as data_type,
          format_type(a.atttypid, a.atttypmod) as pg_type,
          CASE
            WHEN a.atttypmod > 0 AND format_type(a.atttypid, a.atttypmod) LIKE '%(%'
            THEN substring(format_type(a.atttypid, a.atttypmod) FROM '\\((\\d+)')::int
            ELSE NULL
          END as character_maximum_length,
          NOT a.attnotnull as is_nullable,
          pg_get_expr(ad.adbin, ad.adrelid) as column_default,
          a.attgenerated,
          a.attidentity,
          CASE
            WHEN a.attgenerated != '' THEN pg_get_expr(ad.adbin, ad.adrelid)
            ELSE NULL
          END as generation_expression,
          identity_sequence.sequence_schema as identity_sequence_schema,
          identity_sequence.sequence_name as identity_sequence_name,
          identity_sequence.seqstart as identity_start,
          identity_sequence.seqincrement as identity_increment,
          identity_sequence.seqmin as identity_min_value,
          identity_sequence.seqmax as identity_max_value,
          identity_sequence.seqcache as identity_cache,
          identity_sequence.seqcycle as identity_cycle,
          column_collation_namespace.nspname as column_collation_schema,
          column_collation.collname as column_collation_name,
          CASE
            WHEN a.attstorage <> column_type.typstorage THEN a.attstorage
            ELSE NULL
          END as column_storage,
          column_type.typstorage as column_default_storage,
          a.attcompression as column_compression,
          a.attinhcount as inheritance_count
        FROM pg_attribute a
        LEFT JOIN pg_attrdef ad ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        JOIN pg_class cls ON cls.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = cls.relnamespace
        ${IDENTITY_SEQUENCE_JOIN_SQL}
        ${COLUMN_COLLATION_JOIN_SQL}
        WHERE cls.relname = $1 AND n.nspname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `,
        [tableName, tableSchema]
      );

      const inspectedColumns = columnsResult.rows.map((col: any) => {
        let type = col.pg_type;

        // Parse generated column info
        let generated: Column['generated'] | undefined = undefined;
        const identity = this.buildIdentityColumn(col);
        const collation = this.buildColumnCollation(col);
        const storage = columnStorageFromCatalog(col.column_storage);
        const storageDefault = columnStorageFromCatalog(
          col.column_default_storage
        );
        const compression = columnCompressionFromCatalog(
          col.column_compression
        );
        let defaultValue = col.column_default;

        if (col.attgenerated && col.attgenerated !== '') {
          const always = col.attgenerated === 's' || col.attgenerated === 'a';
          const stored = col.attgenerated === 's';
          const expression = col.generation_expression || '';

          generated = {
            always,
            expression,
            stored,
          };

          // Generated columns don't have defaults in the traditional sense
          defaultValue = undefined;
        }

        if (identity) {
          defaultValue = undefined;
        }

        return {
          column: {
            name: col.column_name,
            type: type,
            nullable: col.is_nullable,
            default: defaultValue,
            collation,
            storage,
            storageDefault,
            compression,
            identity,
            generated,
          } satisfies Column,
          isLocal: Number(col.inheritance_count || 0) === 0,
        };
      });
      const columns = inspectedColumns
        .filter(function filterLocal(item) {
          return item.isLocal;
        })
        .map(function getColumn(item) {
          return item.column;
        });
      const inheritedColumns = inspectedColumns
        .filter(function filterInherited(item) {
          return !item.isLocal;
        })
        .map(function getColumn(item) {
          return item.column;
        });

      // Get primary key constraint for this table
      const primaryKey = await this.getPrimaryKeyConstraint(client, tableName, tableSchema);

      // Get foreign key constraints for this table
      const foreignKeys = await this.getForeignKeyConstraints(client, tableName, tableSchema);

      // Get check constraints for this table
      const checkConstraints = await this.getCheckConstraints(client, tableName, tableSchema);
      const inheritedCheckConstraints = inherits
        ? await this.getInheritedCheckConstraints(client, tableName, tableSchema)
        : [];

      // Get unique constraints for this table
      const uniqueConstraints = await this.getUniqueConstraints(client, tableName, tableSchema);

      // Get indexes for this table
      const indexes = await this.getTableIndexes(client, tableName, tableSchema);

      tables.push({
        name: tableName,
        schema: tableSchema,
        columns,
        inherits,
        inheritedColumns:
          inheritedColumns.length > 0 ? inheritedColumns : undefined,
        inheritedCheckConstraints:
          inheritedCheckConstraints.length > 0
            ? inheritedCheckConstraints
            : undefined,
        unlogged: row.relpersistence === "u" ? true : undefined,
        storageParameters: this.parseTableStorageOptions(row),
        accessMethod: row.table_access_method,
        tablespace: row.table_tablespace_name || undefined,
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
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
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
            pg_get_indexdef(ix.indexrelid, 1, false)
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
        -- Get operator class names for each column (non-default only)
        CASE
          WHEN ix.indexprs IS NULL THEN
            ARRAY(
              SELECT
                CASE
                  WHEN opc.opcdefault THEN NULL
                  ELSE opc.opcname
                END
              FROM unnest(ix.indclass) WITH ORDINALITY AS u(opcoid, ord)
              JOIN pg_opclass opc ON opc.oid = u.opcoid
              ORDER BY u.ord
            )
          ELSE
            ARRAY[]::text[]
        END as opclass_names,
        CASE
          WHEN ix.indexprs IS NOT NULL THEN
            (
              SELECT
                CASE
                  WHEN opc.opcdefault THEN NULL
                  ELSE opc.opcname
                END
              FROM unnest(ix.indclass) WITH ORDINALITY AS u(opcoid, ord)
              JOIN pg_opclass opc ON opc.oid = u.opcoid
              ORDER BY u.ord
              LIMIT 1
            )
          ELSE NULL
        END as expression_opclass_name,
        CASE
          WHEN ix.indpred IS NOT NULL THEN
            regexp_replace(
              pg_get_expr(ix.indpred, ix.indrelid),
              '^\\((.*)\\)$', '\\1'  -- Remove outer parentheses
            )
          ELSE NULL
        END as where_clause,
        -- indoption: bit 0 = DESC, bit 1 = NULLS FIRST
        ix.indoption::int2[] as sort_options
      FROM pg_indexes i
      JOIN pg_namespace n ON n.nspname = i.schemaname
      JOIN pg_class c ON c.relname = i.tablename AND c.relnamespace = n.oid
      JOIN pg_class ic ON ic.relname = i.indexname AND ic.relnamespace = n.oid
      JOIN pg_index ix ON ix.indexrelid = ic.oid
      JOIN pg_am am ON am.oid = ic.relam
      LEFT JOIN pg_tablespace ts ON ts.oid = ic.reltablespace
      WHERE i.tablename = $1
        AND i.schemaname = $2
        AND NOT ix.indisprimary  -- Exclude primary key indexes
        -- Exclude unique constraint indexes - these are handled via uniqueConstraints
        -- This ensures proper distinction: constraints use ALTER TABLE ADD CONSTRAINT,
        -- while indexes use CREATE INDEX CONCURRENTLY for production safety
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint con
          WHERE con.conindid = ix.indexrelid
          AND con.contype = 'u'
        )
      ORDER BY i.indexname
      `,
      [tableName, tableSchema]
    );

    return result.rows.map((row: any) => {
      const columns = row.column_names || [];
      const opclassNames = row.opclass_names || [];
      const sortOptions: number[] = row.sort_options || [];
      let opclasses: Record<string, string> | undefined;
      for (let i = 0; i < columns.length; i++) {
        if (opclassNames[i]) {
          if (!opclasses) opclasses = {};
          opclasses[columns[i]] = opclassNames[i];
        }
      }
      const sortOrders = sortOptions.map((opt: number) => (opt & 1) ? 'DESC' : 'ASC') as ('ASC' | 'DESC')[];
      const hasNonDefaultSort = sortOrders.some(s => s === 'DESC');
      return {
        name: row.index_name,
        tableName: row.table_name,
        schema: row.table_schema,
        columns,
        sortOrders: hasNonDefaultSort ? sortOrders : undefined,
        opclasses,
        ...(row.expression_opclass_name ? { expressionOpclass: row.expression_opclass_name } : {}),
        type: this.mapPostgreSQLIndexType(row.access_method),
        unique: row.is_unique,
        concurrent: false,
        where: row.where_clause || undefined,
        expression: row.has_expressions ? row.expression_def : undefined,
        storageParameters: this.parseStorageOptions(row.storage_options),
        tablespace: row.tablespace_name || undefined,
      };
    });
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
        parameters[key] = value.replace(/^'(.*)'$/, '$1');
      }
    }

    return Object.keys(parameters).length > 0 ? parameters : undefined;
  }

  private parseTableStorageOptions(
    row: any
  ): Record<string, string> | undefined {
    const tableOptions = this.parseStorageOptions(row.table_storage_options);
    const toastOptions = this.parseStorageOptions(row.toast_storage_options);
    const parameters: Record<string, string> = { ...(tableOptions || {}) };

    for (const [name, value] of Object.entries(toastOptions || {})) {
      parameters[`toast.${name}`] = value;
    }

    return Object.keys(parameters).length > 0 ? parameters : undefined;
  }

  private parseInheritanceParents(
    parents: Array<{ name?: string; schema?: string }> | null
  ): Table["inherits"] {
    if (!Array.isArray(parents)) {
      return undefined;
    }

    const parsed = parents
      .filter(function hasName(parent) {
        return Boolean(parent?.name);
      })
      .map(function mapParent(parent) {
        return {
          name: parent.name!,
          schema: parent.schema || undefined,
        };
      });
    return parsed.length > 0 ? parsed : undefined;
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
        return accessMethod.toLowerCase() as Index["type"];
    }
  }

  async getForeignKeyConstraints(client: Client, tableName: string, tableSchema: string): Promise<ForeignKeyConstraint[]> {
    const result = await client.query(
      `
      SELECT
        c.conname AS constraint_name,
        (SELECT array_agg(a.attname ORDER BY ord.n)
         FROM unnest(c.conkey) WITH ORDINALITY AS ord(col, n)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ord.col
        ) AS columns,
        ref_ns.nspname AS referenced_schema,
        ref_cl.relname AS referenced_table,
        (SELECT array_agg(a.attname ORDER BY ord.n)
         FROM unnest(c.confkey) WITH ORDINALITY AS ord(col, n)
         JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = ord.col
        ) AS referenced_columns,
        c.confdeltype AS delete_rule,
        c.confupdtype AS update_rule,
        c.condeferrable AS deferrable,
        c.condeferred AS initially_deferred
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      JOIN pg_class ref_cl ON ref_cl.oid = c.confrelid
      JOIN pg_namespace ref_ns ON ref_ns.oid = ref_cl.relnamespace
      WHERE c.contype = 'f'
        AND cl.relname = $1
        AND ns.nspname = $2
      ORDER BY c.conname
      `,
      [tableName, tableSchema]
    );

    if (result.rows.length === 0) {
      return [];
    }

    const actionMap: Record<string, 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION'> = {
      'a': 'NO ACTION',
      'r': 'RESTRICT',
      'c': 'CASCADE',
      'n': 'SET NULL',
      'd': 'SET DEFAULT',
    };

    const parseArrayLiteral = (val: string | string[]): string[] => {
      if (Array.isArray(val)) return val;
      if (!val || val === '{}') return [];
      return val.slice(1, -1).split(',');
    };

    return result.rows.map(row => ({
      name: row.constraint_name,
      columns: parseArrayLiteral(row.columns),
      referencedTable: row.referenced_schema === 'public'
        ? row.referenced_table
        : `${row.referenced_schema}.${row.referenced_table}`,
      referencedColumns: parseArrayLiteral(row.referenced_columns),
      onDelete: actionMap[row.delete_rule],
      onUpdate: actionMap[row.update_rule],
      ...(row.deferrable ? { deferrable: true } : {}),
      ...(row.initially_deferred ? { initiallyDeferred: true } : {}),
    }));
  }

  async getCheckConstraints(client: Client, tableName: string, tableSchema: string): Promise<CheckConstraint[]> {
    const result = await client.query(
      `
      SELECT
        conname as constraint_name,
        pg_get_constraintdef(c.oid) as constraint_def
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE t.relname = $1
        AND n.nspname = $2
        AND c.contype = 'c'
        AND c.coninhcount = 0
      ORDER BY c.conname
      `,
      [tableName, tableSchema]
    );

    if (result.rows.length === 0) {
      return [];
    }

    return this.parseCheckConstraintRows(result.rows);
  }

  private async getInheritedCheckConstraints(
    client: Client,
    tableName: string,
    tableSchema: string
  ): Promise<CheckConstraint[]> {
    const result = await client.query(
      `
      SELECT
        conname as constraint_name,
        pg_get_constraintdef(c.oid) as constraint_def
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE t.relname = $1
        AND n.nspname = $2
        AND c.contype = 'c'
        AND c.coninhcount > 0
      ORDER BY c.conname
      `,
      [tableName, tableSchema]
    );

    return this.parseCheckConstraintRows(result.rows);
  }

  private parseCheckConstraintRows(rows: any[]): CheckConstraint[] {
    const constraints: CheckConstraint[] = [];
    for (const row of rows) {
      const match = row.constraint_def?.match(/^CHECK \((.+)\)$/);
      if (match) {
        constraints.push({
          name: row.constraint_name,
          expression: match[1],
        });
      }
    }
    return constraints;
  }

  async getUniqueConstraints(client: Client, tableName: string, tableSchema: string): Promise<UniqueConstraint[]> {
    const result = await client.query(
      `
      SELECT
        c.conname AS constraint_name,
        (
          SELECT array_agg(a.attname ORDER BY ord.n)
          FROM unnest(c.conkey) WITH ORDINALITY AS ord(col, n)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ord.col
        ) AS columns,
        c.condeferrable AS deferrable,
        c.condeferred AS initially_deferred
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      WHERE c.contype = 'u'
        AND cl.relname = $1
        AND ns.nspname = $2
      ORDER BY c.conname
      `,
      [tableName, tableSchema]
    );

    if (result.rows.length === 0) {
      return [];
    }

    const parseArrayLiteral = (val: string | string[]): string[] => {
      if (Array.isArray(val)) return val;
      if (!val || val === '{}') return [];
      return val.slice(1, -1).split(',');
    };

    return result.rows.map((row) => ({
      name: row.constraint_name,
      columns: parseArrayLiteral(row.columns),
      ...(row.deferrable ? { deferrable: true } : {}),
      ...(row.initially_deferred ? { initiallyDeferred: true } : {}),
    }));
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
      ORDER BY n.nspname, t.typname, e.enumsortorder
    `, [schemas]);

    const enumGroups = new Map<string, { name: string; schema: string; values: string[] }>();

    for (const row of enumsResult.rows) {
      const enumName = row.enum_name;
      const schemaName = row.schema_name;
      const enumValue = row.enum_value;
      const enumKey = `${schemaName}.${enumName}`;

      if (!enumGroups.has(enumKey)) {
        enumGroups.set(enumKey, { name: enumName, schema: schemaName, values: [] });
      }
      enumGroups.get(enumKey)!.values.push(enumValue);
    }

    const enums: EnumType[] = [];
    for (const data of enumGroups.values()) {
      enums.push({ name: data.name, schema: data.schema, values: data.values });
    }

    return enums;
  }

  async getCurrentCompositeTypes(client: Client, schemas: string[] = ['public']): Promise<CompositeType[]> {
    const result = await client.query(`
      SELECT
        t.typname as type_name,
        n.nspname as schema_name,
        a.attname as attribute_name,
        format_type(a.atttypid, a.atttypmod) as attribute_type,
        a.attnum
      FROM pg_type t
      JOIN pg_namespace n ON t.typnamespace = n.oid
      JOIN pg_class c ON c.oid = t.typrelid
      JOIN pg_attribute a ON a.attrelid = c.oid
      LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND t.typtype = 'c'
        AND c.relkind = 'c'
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND d.objid IS NULL
      ORDER BY n.nspname, t.typname, a.attnum
    `, [schemas]);

    const groups = new Map<string, CompositeType>();

    for (const row of result.rows) {
      const key = `${row.schema_name}.${row.type_name}`;
      const current = groups.get(key);

      if (current) {
        current.attributes.push({
          name: row.attribute_name,
          type: row.attribute_type,
        });
        continue;
      }

      groups.set(key, {
        name: row.type_name,
        schema: row.schema_name,
        attributes: [
          {
            name: row.attribute_name,
            type: row.attribute_type,
          },
        ],
      });
    }

    return Array.from(groups.values());
  }

  // Get all views from the database
  async getCurrentViews(client: Client, schemas: string[] = ['public']): Promise<View[]> {
    const views: View[] = [];

    // Get regular views (excluding extension-owned views)
    const viewsResult = await client.query(`
      SELECT
        v.table_name as view_name,
        v.table_schema as schema_name,
        pg_get_viewdef(c.oid, false) as view_definition,
        v.check_option,
        c.reloptions,
        v.is_updatable,
        v.is_insertable_into
      FROM information_schema.views v
      JOIN pg_class c ON c.relname = v.table_name
      JOIN pg_namespace n ON c.relnamespace = n.oid AND n.nspname = v.table_schema
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
      WHERE v.table_schema = ANY($1::text[])
        AND d.objid IS NULL  -- Exclude extension-owned views
      ORDER BY v.table_schema, v.table_name
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

      if (Array.isArray(row.reloptions)) {
        const securityBarrierOption = row.reloptions.find((option: string) =>
          option.startsWith("security_barrier=")
        );
        if (securityBarrierOption) {
          const [, value] = securityBarrierOption.split("=");
          view.securityBarrier = value === "true";
        }
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
      ORDER BY m.schemaname, m.matviewname
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

  async getCurrentSqlObjects(client: Client, schemas: string[] = ['public']): Promise<SqlObject[]> {
    const groups = await Promise.all([
      this.getCurrentPartitionObjects(client, schemas),
      this.getCurrentRowSecurityObjects(client, schemas),
      this.getCurrentPolicyObjects(client, schemas),
      this.getCurrentDomainObjects(client, schemas),
      this.getCurrentRangeObjects(client, schemas),
      this.getCurrentForeignServerObjects(client),
      this.getCurrentConstraintTriggerObjects(client, schemas),
      this.getCurrentEventTriggerObjects(client),
      this.getCurrentRoleObjects(client),
      this.getCurrentGrantObjects(client, schemas),
    ]);

    return groups
      .flat()
      .sort(function sortSqlObjects(a, b) {
        return a.key.localeCompare(b.key);
      });
  }

  // Get complete schema including all database objects
  async getCompleteSchema(client: Client, schemas: string[] = ['public']): Promise<Schema> {
    const [tables, views, enumTypes, compositeTypes, functions, procedures, triggers, sequences, extensions, schemaDefinitions, comments, sqlObjects] = await Promise.all([
      this.getCurrentSchema(client, schemas),
      this.getCurrentViews(client, schemas),
      this.getCurrentEnums(client, schemas),
      this.getCurrentCompositeTypes(client, schemas),
      this.getCurrentFunctions(client, schemas),
      this.getCurrentProcedures(client, schemas),
      this.getCurrentTriggers(client, schemas),
      this.getCurrentSequences(client, schemas),
      this.getCurrentExtensions(client, schemas),
      this.getCurrentSchemas(client, schemas),
      this.getCurrentComments(client, schemas),
      this.getCurrentSqlObjects(client, schemas),
    ]);

    return {
      tables,
      views,
      enumTypes,
      ...(compositeTypes.length > 0 ? { compositeTypes } : {}),
      functions,
      procedures,
      triggers,
      sequences,
      extensions,
      schemas: schemaDefinitions,
      comments,
      ...(sqlObjects.length > 0 ? { sqlObjects } : {}),
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
      ORDER BY n.nspname, p.proname
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
      ORDER BY n.nspname, p.proname
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
        fn.nspname as function_schema,
        pg_get_triggerdef(t.oid) as trigger_def
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_proc p ON t.tgfoid = p.oid
      JOIN pg_namespace fn ON p.pronamespace = fn.oid
      WHERE n.nspname = ANY($1::text[])
        AND NOT t.tgisinternal
        AND t.tgconstraint = 0
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
        when: this.parseTriggerWhenClause(row.trigger_def),
        functionName: row.function_name,
        functionSchema: row.function_schema,
        functionArgs: this.parseTriggerFunctionArgs(row.trigger_def),
      };
    });
  }

  private parseTriggerWhenClause(triggerDef: string | null): string | undefined {
    if (!triggerDef) {
      return undefined;
    }

    const whenMatch = triggerDef.match(/\sWHEN\s\((.+)\)\sEXECUTE FUNCTION\s/i);
    if (!whenMatch || !whenMatch[1]) {
      return undefined;
    }

    return this.stripOuterParentheses(whenMatch[1]);
  }

  private parseTriggerFunctionArgs(triggerDef: string | null): string[] | undefined {
    if (!triggerDef) {
      return undefined;
    }

    const argsMatch = triggerDef.match(/\sEXECUTE FUNCTION\s+[^()]+\((.*)\)\s*$/i);
    if (!argsMatch || argsMatch[1] === undefined) {
      return undefined;
    }

    const argsText = argsMatch[1].trim();
    if (argsText.length === 0) {
      return undefined;
    }

    const args = this.splitTriggerArgs(argsText);
    return args.length > 0 ? args : undefined;
  }

  private splitTriggerArgs(argsText: string): string[] {
    const args: string[] = [];
    let current = "";
    let inQuote = false;

    for (let i = 0; i < argsText.length; i++) {
      const char = argsText[i];

      if (char === "'") {
        current += char;
        if (inQuote && argsText[i + 1] === "'") {
          current += "'";
          i++;
          continue;
        }
        inQuote = !inQuote;
        continue;
      }

      if (char === "," && !inQuote) {
        const value = current.trim();
        if (value) {
          args.push(value);
        }
        current = "";
        continue;
      }

      current += char;
    }

    const finalValue = current.trim();
    if (finalValue) {
      args.push(finalValue);
    }

    return args;
  }

  private stripOuterParentheses(value: string): string {
    let normalized = value.trim();

    while (this.hasBalancedOuterParentheses(normalized)) {
      normalized = normalized.slice(1, -1).trim();
    }

    return normalized;
  }

  private hasBalancedOuterParentheses(value: string): boolean {
    if (!value.startsWith("(") || !value.endsWith(")")) {
      return false;
    }

    let depth = 0;
    for (let i = 0; i < value.length - 1; i++) {
      const char = value[i];
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (depth === 0) return false;
    }

    return depth === 1;
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
      LEFT JOIN pg_depend identity_dependency
        ON identity_dependency.objid = c.oid
        AND identity_dependency.classid = 'pg_class'::regclass
        AND identity_dependency.refclassid = 'pg_class'::regclass
        AND identity_dependency.deptype = 'i'
      LEFT JOIN pg_depend de ON de.objid = c.oid AND de.deptype = 'e'
      LEFT JOIN pg_class c2 ON c2.oid = d.refobjid
      LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      LEFT JOIN pg_namespace n2 ON c2.relnamespace = n2.oid
      WHERE c.relkind = 'S'
        AND n.nspname = ANY($1::text[])
        AND de.objid IS NULL  -- Exclude extension-owned sequences
        AND identity_dependency.objid IS NULL  -- Managed through the identity column
      ORDER BY n.nspname, c.relname
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

    const params: any[] = [];
    const argParts = this.splitFunctionArguments(argsString);

    for (const arg of argParts) {
      const parsed = this.parseFunctionArgument(arg);
      if (parsed) {
        params.push(parsed);
      }
    }

    return params;
  }

  private parseFunctionArgument(arg: string): any | null {
    let content = arg.trim();
    if (!content) {
      return null;
    }

    let mode: string | undefined;
    const modeMatch = content.match(/^(INOUT|IN|OUT|VARIADIC)\s+/i);
    if (modeMatch) {
      mode = modeMatch[1]?.toUpperCase();
      content = content.slice(modeMatch[0].length).trim();
    }

    const { signaturePart, defaultValue } = this.extractArgumentDefault(content);
    const { name, type } = this.extractArgumentNameAndType(signaturePart);
    if (!type) {
      return null;
    }

    return {
      name,
      type,
      mode,
      default: defaultValue,
    };
  }

  private extractArgumentDefault(value: string): { signaturePart: string; defaultValue: string | undefined } {
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let depthParen = 0;
    let depthBracket = 0;

    for (let i = 0; i < value.length; i++) {
      const char = value[i];

      if (char === "'" && !inDoubleQuote) {
        if (inSingleQuote && value[i + 1] === "'") {
          i++;
          continue;
        }
        inSingleQuote = !inSingleQuote;
        continue;
      }

      if (char === '"' && !inSingleQuote) {
        if (inDoubleQuote && value[i + 1] === '"') {
          i++;
          continue;
        }
        inDoubleQuote = !inDoubleQuote;
        continue;
      }

      if (inSingleQuote || inDoubleQuote) {
        continue;
      }

      if (char === "(") depthParen++;
      if (char === ")") depthParen = Math.max(0, depthParen - 1);
      if (char === "[") depthBracket++;
      if (char === "]") depthBracket = Math.max(0, depthBracket - 1);

      if (depthParen !== 0 || depthBracket !== 0) {
        continue;
      }

      if (i > 0 && /\s/.test(value.charAt(i - 1)) && value.slice(i).toUpperCase().startsWith("DEFAULT ")) {
        return {
          signaturePart: value.slice(0, i).trim(),
          defaultValue: value.slice(i + 8).trim() || undefined,
        };
      }
    }

    return {
      signaturePart: value.trim(),
      defaultValue: undefined,
    };
  }

  private extractArgumentNameAndType(value: string): { name: string | undefined; type: string } {
    const trimmed = value.trim();
    if (!trimmed) {
      return { name: undefined, type: "" };
    }

    if (trimmed.startsWith('"')) {
      const quoted = this.readQuotedIdentifier(trimmed);
      if (quoted) {
        const rest = trimmed.slice(quoted.length).trim();
        if (rest) {
          return {
            name: this.unquoteIdentifier(quoted),
            type: rest,
          };
        }
      }
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_$]*)\s+(.+)$/);
    if (!match) {
      return { name: undefined, type: trimmed };
    }

    const candidateName = match[1]!;
    const normalizedCandidateType = match[2]!.trim();
    if (this.isLikelyTypeToken(candidateName)) {
      return { name: undefined, type: trimmed };
    }

    return {
      name: candidateName,
      type: normalizedCandidateType,
    };
  }

  private readQuotedIdentifier(value: string): string | null {
    if (!value.startsWith('"')) {
      return null;
    }

    let i = 1;
    while (i < value.length) {
      if (value[i] === '"') {
        if (value[i + 1] === '"') {
          i += 2;
          continue;
        }

        return value.slice(0, i + 1);
      }
      i++;
    }

    return null;
  }

  private unquoteIdentifier(value: string): string {
    if (!value.startsWith('"') || !value.endsWith('"')) {
      return value;
    }

    return value.slice(1, -1).replace(/""/g, '"');
  }

  private isLikelyTypeToken(value: string): boolean {
    return new Set([
      "array",
      "bigint",
      "bigserial",
      "bit",
      "bool",
      "boolean",
      "box",
      "bytea",
      "char",
      "character",
      "cidr",
      "circle",
      "date",
      "decimal",
      "double",
      "float",
      "inet",
      "int",
      "int2",
      "int4",
      "int8",
      "integer",
      "interval",
      "json",
      "jsonb",
      "line",
      "lseg",
      "macaddr",
      "money",
      "numeric",
      "path",
      "pg_lsn",
      "point",
      "polygon",
      "real",
      "serial",
      "smallint",
      "smallserial",
      "text",
      "time",
      "timetz",
      "timestamp",
      "timestamptz",
      "tsquery",
      "tsvector",
      "txid_snapshot",
      "uuid",
      "varbit",
      "varchar",
      "void",
      "xml",
    ]).has(value.toLowerCase());
  }

  private splitFunctionArguments(argsString: string): string[] {
    const args: string[] = [];
    let current = "";
    let depthParen = 0;
    let depthBracket = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < argsString.length; i++) {
      const char = argsString[i];

      if (char === "'" && !inDoubleQuote) {
        current += char;
        if (inSingleQuote && argsString[i + 1] === "'") {
          current += "'";
          i++;
          continue;
        }
        inSingleQuote = !inSingleQuote;
        continue;
      }

      if (char === '"' && !inSingleQuote) {
        current += char;
        if (inDoubleQuote && argsString[i + 1] === '"') {
          current += '"';
          i++;
          continue;
        }
        inDoubleQuote = !inDoubleQuote;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote) {
        if (char === "(") depthParen++;
        if (char === ")") depthParen = Math.max(0, depthParen - 1);
        if (char === "[") depthBracket++;
        if (char === "]") depthBracket = Math.max(0, depthBracket - 1);
      }

      if (char === "," && !inSingleQuote && !inDoubleQuote && depthParen === 0 && depthBracket === 0) {
        const value = current.trim();
        if (value) {
          args.push(value);
        }
        current = "";
        continue;
      }

      current += char;
    }

    const finalValue = current.trim();
    if (finalValue) {
      args.push(finalValue);
    }

    return args;
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
      ORDER BY n.nspname, e.extname
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
        NULL as column_name,
        d.description as comment
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r', 'v', 'm', 'i')

      UNION ALL

      SELECT
        'TYPE' as object_type,
        t.typname as object_name,
        n.nspname as schema_name,
        NULL as column_name,
        d.description as comment
      FROM pg_type t
      JOIN pg_namespace n ON t.typnamespace = n.oid
      JOIN pg_description d ON d.objoid = t.oid AND d.objsubid = 0
      LEFT JOIN pg_class c ON c.oid = t.typrelid
      LEFT JOIN pg_depend dep ON dep.objid = t.oid AND dep.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND dep.objid IS NULL
        AND (
          t.typtype = 'e'
          OR (t.typtype = 'c' AND c.relkind = 'c')
        )

      UNION ALL

      SELECT
        'SCHEMA' as object_type,
        n.nspname as object_name,
        NULL as schema_name,
        NULL as column_name,
        d.description as comment
      FROM pg_namespace n
      JOIN pg_description d ON d.objoid = n.oid
      WHERE n.nspname = ANY($1::text[])

      UNION ALL

      SELECT
        'COLUMN' as object_type,
        c.relname as object_name,
        n.nspname as schema_name,
        a.attname as column_name,
        d.description as comment
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_attribute a ON a.attrelid = c.oid
      JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = a.attnum
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind = 'r'
        AND a.attnum > 0
        AND NOT a.attisdropped

      ORDER BY object_type, object_name
    `, [schemas]);

    return result.rows.map((row: any) => ({
      objectType: row.object_type as Comment['objectType'],
      objectName: row.object_name,
      schemaName: row.schema_name || undefined,
      columnName: row.column_name || undefined,
      comment: row.comment,
    }));
  }

  private async getCurrentPartitionObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        c.oid,
        c.relname as table_name,
        n.nspname as schema_name,
        pg_get_partkeydef(c.oid) as partition_key
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind = 'p'
        AND d.objid IS NULL
      ORDER BY n.nspname, c.relname
    `, [schemas]);

    const objects: SqlObject[] = [];

    for (const row of result.rows) {
      const columns = await this.getTableColumnDefinitions(client, row.table_name, row.schema_name);
      const constraints = await this.getTableConstraintDefinitions(client, row.oid);
      const body = [...columns, ...constraints].join(",\n  ");
      const qualifiedTable = this.qualifyName(row.table_name, row.schema_name);
      const createStatement = `CREATE TABLE ${qualifiedTable} (\n  ${body}\n) PARTITION BY ${row.partition_key};`;

      objects.push({
        kind: "partition",
        key: `partition:${row.schema_name}.${row.table_name}`,
        name: row.table_name,
        schema: row.schema_name,
        createStatement,
        dropStatement: `DROP TABLE IF EXISTS ${qualifiedTable} CASCADE;`,
      });
    }

    const childResult = await client.query(`
      SELECT
        c.relname as table_name,
        n.nspname as schema_name,
        parent.relname as parent_name,
        parent_ns.nspname as parent_schema,
        pg_get_expr(c.relpartbound, c.oid) as partition_bound
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND c.relispartition
        AND d.objid IS NULL
      ORDER BY n.nspname, c.relname
    `, [schemas]);

    for (const row of childResult.rows) {
      const qualifiedTable = this.qualifyName(row.table_name, row.schema_name);
      const parentTable = this.qualifyName(row.parent_name, row.parent_schema);
      objects.push({
        kind: "partition",
        key: `partition:${row.schema_name}.${row.table_name}`,
        name: row.table_name,
        schema: row.schema_name,
        createStatement: `CREATE TABLE ${qualifiedTable} PARTITION OF ${parentTable} ${row.partition_bound};`,
        dropStatement: `DROP TABLE IF EXISTS ${qualifiedTable} CASCADE;`,
        dependencies: [`partition:${row.parent_schema}.${row.parent_name}`],
      });
    }

    return objects;
  }

  private async getCurrentRowSecurityObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        c.relname as table_name,
        n.nspname as schema_name,
        c.relrowsecurity as row_security_enabled,
        c.relforcerowsecurity as row_security_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r', 'p')
        AND (c.relrowsecurity OR c.relforcerowsecurity)
      ORDER BY n.nspname, c.relname
    `, [schemas]);

    const objects: SqlObject[] = [];

    for (const row of result.rows) {
      const qualifiedTable = this.qualifyName(row.table_name, row.schema_name);

      if (row.row_security_enabled) {
        objects.push({
          kind: "row-level-security",
          key: `row-level-security:${row.schema_name}.${row.table_name}:enabled`,
          name: row.table_name,
          schema: row.schema_name,
          createStatement: `ALTER TABLE ${qualifiedTable} ENABLE ROW LEVEL SECURITY;`,
          dropStatement: `ALTER TABLE ${qualifiedTable} DISABLE ROW LEVEL SECURITY;`,
        });
      }

      if (row.row_security_forced) {
        objects.push({
          kind: "row-level-security",
          key: `row-level-security:${row.schema_name}.${row.table_name}:force`,
          name: row.table_name,
          schema: row.schema_name,
          createStatement: `ALTER TABLE ${qualifiedTable} FORCE ROW LEVEL SECURITY;`,
          dropStatement: `ALTER TABLE ${qualifiedTable} NO FORCE ROW LEVEL SECURITY;`,
        });
      }
    }

    return objects;
  }

  private async getCurrentPolicyObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        pol.polname as policy_name,
        c.relname as table_name,
        n.nspname as schema_name,
        pol.polcmd as policy_command,
        pol.polpermissive as is_permissive,
        pg_get_expr(pol.polqual, pol.polrelid) as using_expression,
        pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check_expression,
        CASE
          WHEN pol.polroles = '{0}'::oid[] THEN ARRAY['PUBLIC']::text[]
          ELSE ARRAY(
            SELECT rolname
            FROM pg_roles
            WHERE oid = ANY(pol.polroles)
            ORDER BY rolname
          )
        END as policy_roles
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
      ORDER BY n.nspname, c.relname, pol.polname
    `, [schemas]);

    return result.rows.map((row: any) => {
      const qualifiedTable = this.qualifyName(row.table_name, row.schema_name);
      const commandMap: Record<string, string> = {
        r: "SELECT",
        a: "INSERT",
        w: "UPDATE",
        d: "DELETE",
        "*": "ALL",
      };
      const parts = [
        `CREATE POLICY ${this.quoteIdent(row.policy_name)}`,
        `ON ${qualifiedTable}`,
        `AS ${row.is_permissive ? "PERMISSIVE" : "RESTRICTIVE"}`,
        `FOR ${commandMap[row.policy_command] || "ALL"}`,
      ];

      const roles = row.policy_roles || [];
      if (roles.length > 0) {
        parts.push(`TO ${roles.map((role: string) => this.quoteRole(role)).join(", ")}`);
      }
      if (row.using_expression) {
        parts.push(`USING (${row.using_expression})`);
      }
      if (row.with_check_expression) {
        parts.push(`WITH CHECK (${row.with_check_expression})`);
      }

      return {
        kind: "policy" as const,
        key: `policy:${row.schema_name}.${row.table_name}.${row.policy_name}`,
        name: row.policy_name,
        schema: row.schema_name,
        createStatement: `${parts.join(" ")};`,
        dropStatement: `DROP POLICY IF EXISTS ${this.quoteIdent(row.policy_name)} ON ${qualifiedTable};`,
      };
    });
  }

  private async getCurrentDomainObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        t.oid,
        t.typname as type_name,
        n.nspname as schema_name,
        format_type(t.typbasetype, t.typtypmod) as base_type,
        t.typnotnull as is_not_null,
        t.typdefault as default_value
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND t.typtype = 'd'
        AND d.objid IS NULL
      ORDER BY n.nspname, t.typname
    `, [schemas]);

    const objects: SqlObject[] = [];

    for (const row of result.rows) {
      const constraints = await client.query(`
        SELECT
          conname,
          pg_get_constraintdef(oid) as definition
        FROM pg_constraint
        WHERE contypid = $1
        ORDER BY conname
      `, [row.oid]);

      const parts = [
        `CREATE DOMAIN ${this.qualifyName(row.type_name, row.schema_name)}`,
        `AS ${row.base_type}`,
      ];

      if (row.default_value) {
        parts.push(`DEFAULT ${row.default_value}`);
      }
      if (row.is_not_null) {
        parts.push("NOT NULL");
      }
      for (const constraint of constraints.rows) {
        parts.push(`CONSTRAINT ${this.quoteIdent(constraint.conname)} ${constraint.definition}`);
      }

      objects.push({
        kind: "domain-type",
        key: `domain-type:${row.schema_name}.${row.type_name}`,
        name: row.type_name,
        schema: row.schema_name,
        createStatement: `${parts.join(" ")};`,
        dropStatement: `DROP DOMAIN IF EXISTS ${this.qualifyName(row.type_name, row.schema_name)} CASCADE;`,
      });
    }

    return objects;
  }

  private async getCurrentRangeObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        t.typname as type_name,
        n.nspname as schema_name,
        format_type(r.rngsubtype, NULL) as subtype_name,
        CASE
          WHEN opclass.oid IS NULL THEN NULL
          WHEN opclass_ns.nspname = 'public' THEN quote_ident(opclass.opcname)
          ELSE quote_ident(opclass_ns.nspname) || '.' || quote_ident(opclass.opcname)
        END as subtype_opclass_name,
        CASE
          WHEN coll.oid IS NULL THEN NULL
          WHEN coll_ns.nspname = 'public' THEN quote_ident(coll.collname)
          ELSE quote_ident(coll_ns.nspname) || '.' || quote_ident(coll.collname)
        END as collation_name,
        CASE
          WHEN canonical.oid IS NULL THEN NULL
          ELSE canonical.oid::regproc::text
        END as canonical_name,
        CASE
          WHEN diff.oid IS NULL THEN NULL
          ELSE diff.oid::regproc::text
        END as diff_name
      FROM pg_range r
      JOIN pg_type t ON t.oid = r.rngtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_opclass opclass ON opclass.oid = r.rngsubopc
      LEFT JOIN pg_namespace opclass_ns ON opclass_ns.oid = opclass.opcnamespace
      LEFT JOIN pg_collation coll ON coll.oid = r.rngcollation AND r.rngcollation <> 0
      LEFT JOIN pg_namespace coll_ns ON coll_ns.oid = coll.collnamespace
      LEFT JOIN pg_proc canonical ON canonical.oid = r.rngcanonical AND r.rngcanonical <> 0
      LEFT JOIN pg_proc diff ON diff.oid = r.rngsubdiff AND r.rngsubdiff <> 0
      LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
      WHERE n.nspname = ANY($1::text[])
        AND d.objid IS NULL
      ORDER BY n.nspname, t.typname
    `, [schemas]);

    return result.rows.map((row: any) => {
      const params = [`subtype = ${row.subtype_name}`];
      if (row.subtype_opclass_name) {
        params.push(`subtype_opclass = ${row.subtype_opclass_name}`);
      }
      if (row.collation_name) {
        params.push(`collation = ${row.collation_name}`);
      }
      if (row.canonical_name) {
        params.push(`canonical = ${row.canonical_name}`);
      }
      if (row.diff_name) {
        params.push(`subtype_diff = ${row.diff_name}`);
      }

      return {
        kind: "range-type" as const,
        key: `range-type:${row.schema_name}.${row.type_name}`,
        name: row.type_name,
        schema: row.schema_name,
        createStatement: `CREATE TYPE ${this.qualifyName(row.type_name, row.schema_name)} AS RANGE (${params.join(", ")});`,
        dropStatement: `DROP TYPE IF EXISTS ${this.qualifyName(row.type_name, row.schema_name)} CASCADE;`,
      };
    });
  }

  private async getCurrentForeignServerObjects(client: Client): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        srvname as server_name,
        fdw.fdwname as fdw_name,
        srvoptions as server_options
      FROM pg_foreign_server s
      JOIN pg_foreign_data_wrapper fdw ON fdw.oid = s.srvfdw
      ORDER BY srvname
    `);

    return result.rows.map((row: any) => {
      const options = this.formatOptions(row.server_options);
      const suffix = options ? ` OPTIONS (${options})` : "";
      return {
        kind: "foreign-server" as const,
        key: `foreign-server:${row.server_name}`,
        name: row.server_name,
        createStatement: `CREATE SERVER ${this.quoteIdent(row.server_name)} FOREIGN DATA WRAPPER ${this.quoteIdent(row.fdw_name)}${suffix};`,
        dropStatement: `DROP SERVER IF EXISTS ${this.quoteIdent(row.server_name)} CASCADE;`,
      };
    });
  }

  private async getCurrentConstraintTriggerObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        t.tgname as trigger_name,
        c.relname as table_name,
        n.nspname as schema_name,
        pg_get_triggerdef(t.oid) as trigger_definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND NOT t.tgisinternal
        AND t.tgconstraint <> 0
      ORDER BY n.nspname, c.relname, t.tgname
    `, [schemas]);

    return result.rows.map((row: any) => ({
      kind: "constraint-trigger" as const,
      key: `constraint-trigger:${row.schema_name}.${row.table_name}.${row.trigger_name}`,
      name: row.trigger_name,
      schema: row.schema_name,
      createStatement: this.ensureStatement(row.trigger_definition),
      dropStatement: `DROP TRIGGER IF EXISTS ${this.quoteIdent(row.trigger_name)} ON ${this.qualifyName(row.table_name, row.schema_name)};`,
    }));
  }

  private async getCurrentEventTriggerObjects(client: Client): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        e.evtname as trigger_name,
        e.evtevent as event_name,
        e.evttags as trigger_tags,
        p.proname as function_name,
        n.nspname as function_schema
      FROM pg_event_trigger e
      JOIN pg_proc p ON p.oid = e.evtfoid
      JOIN pg_namespace n ON n.oid = p.pronamespace
      ORDER BY e.evtname
    `);

    return result.rows.map((row: any) => {
      const tagClause = Array.isArray(row.trigger_tags) && row.trigger_tags.length > 0
        ? ` WHEN TAG IN (${row.trigger_tags.map((tag: string) => this.quoteLiteral(tag)).join(", ")})`
        : "";
      return {
        kind: "event-trigger" as const,
        key: `event-trigger:${row.trigger_name}`,
        name: row.trigger_name,
        createStatement: `CREATE EVENT TRIGGER ${this.quoteIdent(row.trigger_name)} ON ${row.event_name}${tagClause} EXECUTE FUNCTION ${this.qualifyName(row.function_name, row.function_schema)}();`,
        dropStatement: `DROP EVENT TRIGGER IF EXISTS ${this.quoteIdent(row.trigger_name)};`,
      };
    });
  }

  private async getCurrentRoleObjects(client: Client): Promise<SqlObject[]> {
    const result = await client.query(`
      SELECT
        rolname as role_name,
        rolcanlogin as can_login,
        rolsuper as is_superuser,
        rolcreatedb as can_create_db,
        rolcreaterole as can_create_role,
        rolinherit as can_inherit,
        rolreplication as can_replicate,
        rolbypassrls as can_bypass_rls,
        rolconnlimit as connection_limit
      FROM pg_roles
      WHERE rolname !~ '^pg_'
        AND rolname <> 'public'
      ORDER BY rolname
    `);

    return result.rows.map((row: any) => {
      const kind = row.can_login ? "user" : "role";
      const options = [row.can_login ? "LOGIN" : "NOLOGIN"];
      if (row.is_superuser) {
        options.push("SUPERUSER");
      }
      if (row.can_create_db) {
        options.push("CREATEDB");
      }
      if (row.can_create_role) {
        options.push("CREATEROLE");
      }
      if (!row.can_inherit) {
        options.push("NOINHERIT");
      }
      if (row.can_replicate) {
        options.push("REPLICATION");
      }
      if (row.can_bypass_rls) {
        options.push("BYPASSRLS");
      }
      if (row.connection_limit !== -1) {
        options.push(`CONNECTION LIMIT ${row.connection_limit}`);
      }

      const subject = kind === "user" ? "USER" : "ROLE";
      return {
        kind,
        key: `${kind}:${row.role_name}`,
        name: row.role_name,
        createStatement: `CREATE ${subject} ${this.quoteIdent(row.role_name)} WITH ${options.join(" ")};`,
        dropStatement: `DROP ${subject} IF EXISTS ${this.quoteIdent(row.role_name)};`,
      };
    });
  }

  private async getCurrentGrantObjects(client: Client, schemas: string[]): Promise<SqlObject[]> {
    const [classResult, schemaResult, serverResult] = await Promise.all([
      client.query(`
        SELECT
          n.nspname as schema_name,
          c.relname as object_name,
          CASE
            WHEN c.relkind = 'S' THEN 'SEQUENCE'
            ELSE 'TABLE'
          END as object_type,
          COALESCE(grantee.rolname, 'PUBLIC') as grantee_name,
          privilege.privilege_type,
          privilege.is_grantable
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN LATERAL aclexplode(c.relacl) as privilege ON c.relacl IS NOT NULL
        LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
        LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
        WHERE n.nspname = ANY($1::text[])
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND d.objid IS NULL
        ORDER BY n.nspname, c.relname, grantee_name, privilege.privilege_type
      `, [schemas]),
      client.query(`
        SELECT
          n.nspname as schema_name,
          COALESCE(grantee.rolname, 'PUBLIC') as grantee_name,
          privilege.privilege_type,
          privilege.is_grantable
        FROM pg_namespace n
        JOIN LATERAL aclexplode(n.nspacl) as privilege ON n.nspacl IS NOT NULL
        LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
        WHERE n.nspname = ANY($1::text[])
        ORDER BY n.nspname, grantee_name, privilege.privilege_type
      `, [schemas]),
      client.query(`
        SELECT
          s.srvname as server_name,
          COALESCE(grantee.rolname, 'PUBLIC') as grantee_name,
          privilege.privilege_type,
          privilege.is_grantable
        FROM pg_foreign_server s
        JOIN LATERAL aclexplode(s.srvacl) as privilege ON s.srvacl IS NOT NULL
        LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
        ORDER BY s.srvname, grantee_name, privilege.privilege_type
      `),
    ]);

    const objects: SqlObject[] = [];

    for (const row of classResult.rows) {
      objects.push(this.buildGrantObject(
        row.object_type,
        row.object_name,
        row.schema_name,
        row.grantee_name,
        row.privilege_type,
        row.is_grantable
      ));
    }

    for (const row of schemaResult.rows) {
      objects.push(this.buildGrantObject(
        "SCHEMA",
        row.schema_name,
        row.schema_name,
        row.grantee_name,
        row.privilege_type,
        row.is_grantable
      ));
    }

    for (const row of serverResult.rows) {
      objects.push(this.buildGrantObject(
        "FOREIGN SERVER",
        row.server_name,
        undefined,
        row.grantee_name,
        row.privilege_type,
        row.is_grantable
      ));
    }

    return objects;
  }

  private async getTableColumnDefinitions(client: Client, tableName: string, tableSchema: string): Promise<string[]> {
    const result = await client.query(
      `
        SELECT
          a.attname as column_name,
          format_type(a.atttypid, a.atttypmod) as pg_type,
          NOT a.attnotnull as is_nullable,
          pg_get_expr(ad.adbin, ad.adrelid) as column_default,
          a.attgenerated,
          a.attidentity,
          CASE
            WHEN a.attgenerated != '' THEN pg_get_expr(ad.adbin, ad.adrelid)
            ELSE NULL
          END as generation_expression,
          identity_sequence.sequence_schema as identity_sequence_schema,
          identity_sequence.sequence_name as identity_sequence_name,
          identity_sequence.seqstart as identity_start,
          identity_sequence.seqincrement as identity_increment,
          identity_sequence.seqmin as identity_min_value,
          identity_sequence.seqmax as identity_max_value,
          identity_sequence.seqcache as identity_cache,
          identity_sequence.seqcycle as identity_cycle,
          column_collation_namespace.nspname as column_collation_schema,
          column_collation.collname as column_collation_name,
          CASE
            WHEN a.attstorage <> column_type.typstorage THEN a.attstorage
            ELSE NULL
          END as column_storage,
          column_type.typstorage as column_default_storage,
          a.attcompression as column_compression
        FROM pg_attribute a
        LEFT JOIN pg_attrdef ad ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        JOIN pg_class cls ON cls.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = cls.relnamespace
        ${IDENTITY_SEQUENCE_JOIN_SQL}
        ${COLUMN_COLLATION_JOIN_SQL}
        WHERE cls.relname = $1
          AND n.nspname = $2
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attnum
      `,
      [tableName, tableSchema]
    );

    return result.rows.map(this.buildColumnDefinition, this);
  }

  private async getTableConstraintDefinitions(client: Client, relationOid: number): Promise<string[]> {
    const result = await client.query(`
      SELECT
        conname,
        pg_get_constraintdef(oid) as definition
      FROM pg_constraint
      WHERE conrelid = $1
      ORDER BY conname
    `, [relationOid]);

    return result.rows.map((row: any) => {
      return `CONSTRAINT ${this.quoteIdent(row.conname)} ${row.definition}`;
    });
  }

  private buildColumnDefinition(row: any): string {
    const parts = [this.quoteIdent(row.column_name), row.pg_type];

    const collation = this.buildColumnCollation(row);
    if (collation) {
      parts.push(`COLLATE ${renderCollationName(collation)}`);
    }

    const identity = this.buildIdentityColumn(row);
    if (identity) {
      parts.push(renderIdentityClause(identity));
      return parts.join(" ");
    }

    if (row.attgenerated && row.attgenerated !== "") {
      const always = row.attgenerated === "s" || row.attgenerated === "a" ? "ALWAYS" : "BY DEFAULT";
      const stored = row.attgenerated === "s" ? "STORED" : "VIRTUAL";
      parts.push(`GENERATED ${always} AS (${row.generation_expression}) ${stored}`);
      return parts.join(" ");
    }

    if (!row.is_nullable) {
      parts.push("NOT NULL");
    }
    if (row.column_default) {
      parts.push(`DEFAULT ${row.column_default}`);
    }

    return parts.join(" ");
  }

  private buildColumnCollation(row: any): Column['collation'] | undefined {
    if (!row.column_collation_name) return undefined;
    return {
      name: String(row.column_collation_name),
      schema: row.column_collation_schema
        ? String(row.column_collation_schema)
        : undefined,
    };
  }

  private buildIdentityColumn(row: any): Column['identity'] | undefined {
    if (!row.attidentity) return undefined;

    const toOptionalString = function toOptionalString(
      value: unknown
    ): string | undefined {
      return value === null || value === undefined ? undefined : String(value);
    };
    const sequenceName = row.identity_sequence_name
      ? {
          name: String(row.identity_sequence_name),
          schema: row.identity_sequence_schema
            ? String(row.identity_sequence_schema)
            : undefined,
        }
      : undefined;

    return {
      generation: row.attidentity === 'a' ? 'ALWAYS' : 'BY DEFAULT',
      sequenceName,
      start: toOptionalString(row.identity_start),
      increment: toOptionalString(row.identity_increment),
      minValue: toOptionalString(row.identity_min_value),
      maxValue: toOptionalString(row.identity_max_value),
      cache: toOptionalString(row.identity_cache),
      cycle:
        row.identity_cycle === null || row.identity_cycle === undefined
          ? undefined
          : Boolean(row.identity_cycle),
    };
  }

  private buildGrantObject(
    objectType: string,
    objectName: string,
    schemaName: string | undefined,
    granteeName: string,
    privilegeType: string,
    isGrantable: boolean
  ): SqlObject {
    const target = this.formatGrantTarget(objectType, objectName, schemaName);
    const grantOption = isGrantable ? " WITH GRANT OPTION" : "";
    const createStatement = `GRANT ${privilegeType} ON ${objectType} ${target} TO ${this.quoteRole(granteeName)}${grantOption};`;
    return {
      kind: "grant",
      key: `grant:${createStatement.replace(/\s+/g, " ").trim()}`,
      name: createStatement.replace(/\s+/g, " ").trim(),
      schema: schemaName,
      createStatement,
      dropStatement: `REVOKE ${privilegeType} ON ${objectType} ${target} FROM ${this.quoteRole(granteeName)};`,
    };
  }

  private formatGrantTarget(objectType: string, objectName: string, schemaName?: string): string {
    if (objectType === "SCHEMA") {
      return this.quoteIdent(objectName);
    }
    if (objectType === "FOREIGN SERVER") {
      return this.quoteIdent(objectName);
    }
    return this.qualifyName(objectName, schemaName);
  }

  private formatOptions(options: string[] | null): string {
    if (!options || options.length === 0) {
      return "";
    }

    return options.map((option) => {
      const match = option.match(/^([^=]+)=(.*)$/);
      if (!match) {
        return option;
      }
      return `${match[1] || ""} ${this.quoteLiteral(match[2] || "")}`;
    }).join(", ");
  }

  private ensureStatement(statement: string): string {
    const trimmed = statement.trim();
    return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
  }

  private quoteIdent(value: string): string {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  private quoteLiteral(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  private quoteRole(value: string): string {
    return value === "PUBLIC" ? "PUBLIC" : this.quoteIdent(value);
  }

  private qualifyName(name: string, schema?: string): string {
    return schema ? `${this.quoteIdent(schema)}.${this.quoteIdent(name)}` : this.quoteIdent(name);
  }

  // Helper method to analyze view dependencies
  async getViewDependencies(client: Client, viewName: string, viewSchema: string = "public"): Promise<string[]> {
    try {
      const result = await client.query(`
        SELECT DISTINCT
          CASE
            WHEN referenced_table_schema = 'public' THEN referenced_table_name
            ELSE referenced_table_schema || '.' || referenced_table_name
          END as dependency
        FROM information_schema.view_table_usage
        WHERE view_schema = $1 AND view_name = $2
        ORDER BY dependency
      `, [viewSchema, viewName]);

      return result.rows.map(row => row.dependency);
    } catch (error) {
      // If the query fails (e.g., permissions), return empty array
      return [];
    }
  }

  async getFunctionDependencies(
    client: Client,
    functionName: string,
    functionSchema: string = "public"
  ): Promise<string[]> {
    try {
      const result = await client.query(`
        SELECT DISTINCT
          CASE
            WHEN ref_ns.nspname = 'public' THEN ref_class.relname
            ELSE ref_ns.nspname || '.' || ref_class.relname
          END as dependency
        FROM pg_proc p
        JOIN pg_namespace proc_ns ON proc_ns.oid = p.pronamespace
        JOIN pg_depend d ON d.objid = p.oid AND d.classid = 'pg_proc'::regclass
        JOIN pg_class ref_class ON ref_class.oid = d.refobjid AND d.refclassid = 'pg_class'::regclass
        JOIN pg_namespace ref_ns ON ref_ns.oid = ref_class.relnamespace
        WHERE proc_ns.nspname = $1
          AND p.proname = $2
        ORDER BY dependency
      `, [functionSchema, functionName]);

      return result.rows.map(row => row.dependency);
    } catch (error) {
      return [];
    }
  }
}
